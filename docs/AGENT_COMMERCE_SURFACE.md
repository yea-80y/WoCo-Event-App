# WoCo Agent Commerce Surface — Bounded, Non-Custodial Agent Wallet

Status: **built, server typecheck-green, E2E demo + MCP ready to run** (2026-06-12).
Chain: **Arbitrum Sepolia (421614)**. Part of the Arbitrum buildathon (Tier-2 agent surface).

## The one-line pitch

> An AI agent discovers a WoCo event and buys a ticket autonomously, paying USDC on
> Arbitrum from a **spend permission the user granted to the agent's own key** — capped,
> recipient-pinned, time-boxed, revocable, and enforced on-chain. **The agent never holds
> funds or an unbounded key, and the WoCo server never touches either.**

## Why this is novel (the part judges should care about)

Almost every agent-payment / x402 demo today hands the agent a **funded hot wallet**: the
agent holds the private key *and* the money, so "don't misbehave" is a trust assumption. We
invert that. The agent's authority is an **ERC-7710-style spend permission** on the user's
ERC-4337 (ZeroDev Kernel) smart account:

- **Recipient-pinned** — a draw can only pay the event organiser; the smart account rejects any
  other `to`.
- **Per-draw ceiling** — no single draw exceeds the ticket-price ceiling.
- **Expiry + draw count** — the budget self-expires and caps the number of purchases.
- **Non-custodial** — USDC stays in the user's Kernel until a draw moves it *directly* to the
  organiser. A leaked agent key, a malicious agent, or a prompt-injected LLM can do **nothing**
  outside those bounds. Revocation is immediate (uninstall the validator / let it expire).

This is a concrete safety model for agentic commerce, built entirely on Arbitrum-native
primitives WoCo already ships (ZeroDev Kernel #1b, EAS #4, Stylus #5), not off-the-shelf glue.

## ZeroDev vs Alchemy vs Coinbase — what we used and why

- **Budget rail = ZeroDev Kernel on Arb Sepolia, only.** The gasless paymaster + permission
  validator live there; keeping it Arbitrum-native is both correct and on-theme. We did **not**
  bring in Alchemy's agent-wallet stack — it would mean a second, parallel account-abstraction /
  custody stack for zero new capability (the exact key-custody fork to avoid). The primitives we
  already run (session keys with call + spend policies) *are* the agent wallet.
- **Coinbase Smart Wallet (CSW)** is a supported *user login* (Base), not the agent-budget rail.
  CSW's own native Spend Permissions on Base are a clean post-buildathon cross-chain extension.

## Architecture

```
USER (Kernel smart account, Arb Sepolia, holds test USDC)
   │  grants a ZeroDev spend permission → spender = AGENT's own address
   │  scope: USDC.transfer, to = ORGANISER only, ≤ ceiling/draw, ≤ N draws, until T
   ▼
AGENT (its OWN secp256k1 key; an MCP-driven LLM, or the demo script)
   │  1. discover   GET  /api/agent/events
   │  2. quote      POST /api/agent/quote        → amount + organiser + intentId
   │  3. DRAW       (agent-side, ZeroDev) reconstruct approval w/ own key →
   │                USDC.transfer(organiser, amount) gasless userOp → settlementTxHash
   │  4. settle     POST /api/agent/buy { …, settlementTxHash, intentId }
   ▼
WoCo SERVER (never holds the agent key or funds — read-only verify + mint)
   verify USDC Transfer LOG (from=userKernel, to=organiser, exact amount, confirmations)
   + POD gate + purchase-intent freshness + one-shot → claimTicket() mints to userKernel
```

Key invariant: settlement verifies the **USDC `Transfer` log** (`from = userKernel`), **not**
the outer `tx.from` — a 4337 userOp's `tx.from` is the bundler. The mint therefore goes through
the internal `claimTicket()` (not the public claim endpoint, whose `tx.from === claimer` binding
is invalid for a 4337 payment); the log proof is the stronger guarantee.

## Security model (reviewed + hardened)

A security review of the new surface raised two server-side authorization gaps versus WoCo's
established claim/shop patterns. Both were fixed before ship:

1. **POD gate enforcement.** `/api/agent/buy` now runs the same `checkPodGate(userKernel)` /
   phase logic as the events claim route *before* minting (fail closed) — a gated series cannot
   be claimed via the agent rail by a Kernel that doesn't hold the gating POD.
2. **Payment ↔ purchase binding.** A bare USDC transfer carries no memo, so without binding any
   first-seen matching transfer could be replayed to mint a ticket. We issue a one-time,
   short-TTL **purchase intent** at `/quote` (and the `/buy` 402 step); settlement requires the
   intent (one-shot) *and* the draw's block timestamp to post-date the intent's `issuedAt`. This
   rejects pre-existing/unrelated transfers; the global txHash one-shot prevents reusing a draw.

Sound-by-construction (reviewed, no change needed): amount + recipient are recomputed server-side
(never trusted from the request); the on-chain call policy pins recipient + per-draw ceiling +
expiry + count; log verification pins the canonical USDC address + exact value + min-confirmations.

Residual / future hardening: unique-amount (micro-salted) intents would also defeat
front-running a *fresh* concurrent draw (currently benign — that draw still mints to its own
funder). Purchase intents are in-memory (a restart forces a fresh quote — fail-safe).

## Endpoints (`/api/agent/*`, unauthenticated by design)

The on-chain draw *is* the authorization; the ticket always mints to the funding Kernel.

| Method | Path | Purpose |
|---|---|---|
| GET  | `/api/agent/events[?organiser=0x…]` | Discover events (directory). |
| GET  | `/api/agent/events/:eventId` | Event detail + series + USDC pricing. |
| POST | `/api/agent/grant-params` | Server-dictated bounds to embed in the grant (recipient pinned to organiser). |
| POST | `/api/agent/quote` | Exact USDC amount + organiser recipient + a fresh `intentId`. |
| POST | `/api/agent/buy` | x402-style: 402 without a draw; verifies + mints with `{settlementTxHash, intentId}`. |
| GET  | `/.well-known/agent.json` | Agent card (capabilities, payment scheme, MCP + OpenAPI URLs). |
| GET  | `/api/agent/openapi.json` | OpenAPI 3.1 for the surface. |

x402: the 402 handshake (PAYMENT-REQUIRED descriptor) is preserved, but the settlement *scheme*
is our non-custodial `spend-permission` draw rather than x402's default EIP-3009 hot-wallet
transfer.

## MCP server

`apps/server/scripts/agent/mcp.ts` — a stdio MCP server (run: `npm run agent:mcp -w @woco/server`)
exposing `find_events`, `get_event`, `get_quote`, `buy_ticket`. Point Claude Desktop at it and
Claude *is* the agent: it discovers, quotes, and buys, with `buy_ticket` drawing against the
user-granted budget using the agent's own key (held by the MCP process, never the WoCo server).

## Demo (the showpiece)

`apps/server/scripts/agent/demo.ts` — `npm run agent:demo -w @woco/server`. End-to-end on Arb
Sepolia: the user Kernel grants the agent a bounded budget → the agent draws with its own key →
the ticket mints to the user → **a deliberately wrong-recipient draw is rejected on-chain** (the
bounds bite). Prints every tx (Arbiscan links) + remaining budget.

### Runtime prerequisites
- `ZERODEV_RPC` set (already required for the POS rail).
- A published event with a **USDC / direct-transfer** series (no escrow) on chain 421614.
- A test user Kernel funded with Arb Sepolia test USDC.
- Env per `apps/server/.env.example` (agent section): `AGENT_DEMO_USER_PK`, `AGENT_DEMO_EVENT_ID`,
  `AGENT_DEMO_SERIES_ID` (+ optional `AGENT_DEMO_AGENT_PK`).

## Verified on-chain (Arbitrum Sepolia, 2026-06-12)

End-to-end demo run green: bounded grant → agent self-key draw → mint → off-policy draw rejected.

| Item | Value |
|---|---|
| Demo event / series | `agent-demo-event-01` / `agent-demo-series-01` |
| User Kernel (funder + recipient) | `0x7D135b15D6a07FB6012CF96212053b2F243bCb99` |
| Agent address (own key) | per-run ephemeral (e.g. `0x969524c6e2b206e937cf2dec963ad420b7e5f763`) |
| Spend-permission bounds | recipient `0x7b318c46a6fdc544212ebd83335f6b7414a97925`, ceiling `$100`, max 20 draws, 24h expiry |
| Draw tx (USDC userKernel→organiser) | `https://sepolia.arbiscan.io/tx/0x0e8e688ffdc0e3d686b35beb36eae72f3b8b0d964c9744992be107941c0c44f1` |
| Minted ticket | series `Agent Demo Ticket`, edition `#1`, to the user Kernel |
| Rejected wrong-recipient draw | call policy `to == organiser` mismatch → bundler rejects at validation (HTTP 400) |

### Debug notes (AA23 root cause + fixes)

The first E2E attempts reverted with `AA23 reverted 0x` (empty revert data). After isolating it
empirically (a policy-matrix probe, since deleted), the cause was **out-of-gas inside the account's
`validateUserOp` during the agent's enable-mode draw** — *not* the policies, the no-key approval, the
nonce, or deployment. This grant's call policy matches `USDC.transfer`'s ABI args (`to` EQUAL recipient,
`value` LE ceiling) plus timestamp + rate-limit + gas policies — far heavier to validate than the EAS
likes path's flat selector-only policy, so the EAS path's `800k` verificationGasLimit fallback is
insufficient here (verified: 800k OOMs, 3M succeeds). Three fixes, all in `scripts/agent/zerodev.ts`:

1. **Generous explicit gas for the draw** (`DRAW_GAS_OVERRIDES`, verificationGasLimit 3M) — skips the
   unreliable bundler estimate; the lever that actually fixed AA23. Sponsored + Arb gas is ~free and
   the bundler still meters real usage, so over-provisioning the limit is harmless.
2. **Deploy the user Kernel first** (`ensureKernelDeployed`) — a fresh raw-key Kernel is undeployed, so
   the draw would otherwise deploy + enable + validate in one first-ever op. A cheap sudo deploy makes
   the draw enable-only (no initCode). No-op once the Kernel has code (the real-world case).
3. **Non-zero rate-limit `interval`** — `toRateLimitPolicy` defaults `interval=0` (a footgun: the
   on-chain policy does time-bucket math); set to the permission's remaining lifetime so `count` is an
   effective lifetime cap of `maxDraws`.

> ⚠ **Latent in the shop POS rail** (`lib/shop/spend-permission.ts` + browser `grantShopSpendPermission`):
> it uses the *same* heavy ABI call policy + rate-limit(interval=0) + no-key approval. Its first draw
> against a freshly-deployed attendee Kernel will hit the *same* `800k`-too-low OOM and the `interval=0`
> footgun. Port fixes 1 + 3 there before relying on it end-to-end.

The demo's series must have a seeded **editions feed** for the legacy `claimTicket` path to mint — see
`scripts/agent/seed-demo-editions.ts` (run once after `setup-demo-event.ts`). Real organiser publishes
build signed editions client-side; the seeder mirrors that with a throwaway POD key.

## File map

- `apps/server/src/routes/agent.ts` — the `/api/agent/*` surface (discovery, grant-params, quote, buy).
- `apps/server/src/lib/agent/spend-authority.ts` — bounds + log verification + freshness + mint.
- `apps/server/src/lib/agent/purchase-intent.ts` — one-time purchase-intent binding.
- `apps/server/src/agent/discovery.ts` — `.well-known/agent.json` + OpenAPI generators.
- `apps/server/scripts/agent/zerodev.ts` — Node ZeroDev helpers (user grant + agent draw).
- `apps/server/scripts/agent/demo.ts` — E2E demo.
- `apps/server/scripts/agent/mcp.ts` — stdio MCP server.
- Reuses: `lib/event/claim-service.ts` (`claimTicket`), `lib/pod/gate-check.ts`,
  `lib/payment/tx-registry.ts`, `lib/payment/constants.ts`, `lib/shop/spend-permission.ts` (template).
