# WoCo Agent Commerce — Architecture & How It Works

> A standalone explainer of WoCo's **bounded, non-custodial AI-agent commerce** system: how an
> autonomous agent buys an event ticket on a user's behalf, paying USDC on Arbitrum, **without anyone
> ever holding the user's funds or an unbounded key.** Written to be read on its own.

- **Network:** Arbitrum Sepolia (`421614`).
- **Live API:** `https://events-api.woco-net.com` · agent surface under `/api/agent/*`.
- **Verified E2E (2026-06-12):** draw `0x0e8e688ffdc0e3d686b35beb36eae72f3b8b0d964c9744992be107941c0c44f1`,
  ticket minted edition #1, off-policy draw rejected on-chain.

---

## 1. The one-paragraph version

A user grants an AI agent a **spend permission** — an on-chain authorization, signed by the user's
smart-account wallet, that lets the agent's *own* key move **USDC, but only to one specific organiser,
only up to a per-purchase ceiling, only a capped number of times, and only before an expiry.** The
agent then discovers a WoCo event, gets a price quote, and draws exactly that amount of USDC directly
from the user's wallet to the organiser — gaslessly — and the WoCo server (which never holds the funds
or the agent's key) verifies the on-chain payment and mints the ticket to the user. Everything the
agent is allowed to do is enforced by the user's wallet contract on-chain; the server is only a
read-only verifier and ticket issuer. **If the agent's key leaked, the worst case is over-paying the
chosen organiser within the ceiling — never a redirect to an attacker, never a drain.**

---

## 2. Why agent payments are hard (the problem we solve)

Giving an AI agent the ability to spend money usually means one of two bad options:

1. **Hand the agent a funded hot wallet / private key.** If the agent (or its host, or its prompt) is
   compromised, the funds are gone — the key can pay anyone, any amount.
2. **Custody the funds in a platform** and let the agent spend via an API. Now the platform is a
   honeypot and a trusted third party; "non-custodial" is a lie.

WoCo takes a third path using **account abstraction (ERC-4337) + a scoped spend permission**: the
user keeps custody, the agent gets its own key but that key is **cryptographically boxed in** by
policies the user's wallet enforces on every transaction. No funded hot wallet, no platform custody.

---

## 3. The four actors and the trust boundaries

```
            grants a bounded            draws within bounds,
            spend permission            signs with its OWN key
   ┌────────┐   ───────────▶  ┌────────┐   ───────────▶   ┌──────────────┐
   │  USER  │                 │ AGENT  │                  │  ARBITRUM     │
   │ Kernel │ ◀───────────    │ (own   │   USDC moves     │  (user Kernel │
   │ wallet │   ticket minted │  key)  │   Kernel→        │   enforces    │
   └────────┘                 └────────┘   organiser      │   the policy) │
        ▲                          │                      └──────────────┘
        │ mints ticket to user     │ POST /api/agent/buy          ▲
        │ (read-only verify)       ▼ (settlementTxHash)           │ reads the
   ┌─────────────────────────────────────────┐                   │ Transfer log
   │            WoCo SERVER                    │ ──────────────────┘
   │  • dictates the bounds (grant-params)     │
   │  • prices the ticket (quote)              │   NEVER holds: the agent key,
   │  • verifies the on-chain draw (buy)       │   the user funds, or any
   │  • mints the ticket to the user Kernel    │   ability to move money.
   └───────────────────────────────────────────┘
```

| Actor | Holds | Can do | **Cannot** do |
|---|---|---|---|
| **User Kernel** (ZeroDev smart account) | the user's funds + root key | grant/revoke permissions; is the source of funds + ticket recipient | — |
| **Agent** | its **own** session key | draw USDC **within the granted policy** | pay anyone but the pinned organiser; exceed the ceiling/count/expiry; touch other funds |
| **WoCo server** | the platform feed/mint keys | dictate bounds, price, **verify** the draw, mint the ticket | move funds; sign a draw; hold the agent key |
| **Arbitrum / Kernel contract** | — | **enforce** the policy on every userOp | be bypassed by the agent or the server |

The key insight: **the server is not in the funds path at all.** Removing it cannot steal money; it
can only refuse to mint. The agent is not trusted either — the *chain* is what bounds it.

---

## 4. The spend permission — what the user actually signs

The user's wallet is a **ZeroDev Kernel** (ERC-4337 smart account). To authorize the agent, the user's
wallet signs a **permission** that installs a scoped "session validator" naming the **agent's address**
as the spender. It carries four on-chain policies:

| Policy | Binds | Effect |
|---|---|---|
| **Call policy** (`CallPolicyVersion.V0_0_5`) | target = USDC, fn = `transfer`, arg `to` **EQUAL** organiser, arg `value` **≤** ceiling | the agent can *only* call `USDC.transfer(organiser, ≤ceiling)` — nothing else, nobody else |
| **Timestamp policy** | `validUntil` | the authority auto-expires (default 24h window) |
| **Rate-limit policy** | `count` over an `interval` | at most `maxDraws` draws (default 20) over the permission's life |
| **Gas policy** | a finite gasless budget | bounds paymaster-sponsored gas a leaked key could burn |

Crucially, the serialized permission the user hands over contains **no private key** — it is *enable
data* signed by the user's wallet (the ERC-7710 "delegation" primitive). The agent combines it with
**its own** key to act. The user never learns the agent's key; the agent never learns the user's key.

The server **dictates** these bounds (`POST /api/agent/grant-params`) so the client builds a permission
that exactly matches what the server will later verify against — recipient resolved from the event's
organiser, ceiling/expiry/count fixed server-side.

> **Why this is safe even if the agent key leaks.** The policies live in the user's wallet contract and
> are checked on *every* userOp. A stolen agent key can still only fire `transfer(organiser, ≤ceiling)`,
> ≤ N times, before expiry. It can't change the recipient, can't exceed the ceiling, can't spend after
> the window, and can't touch any token but the approved USDC up to that bound. The blast radius is
> "the user might over-tip the organiser they already chose," which is refundable — not theft.

---

## 5. End-to-end purchase flow

The `buy` endpoint follows an **x402-style** payment handshake: ask to buy with no payment and you get
HTTP **402 Payment Required** with a machine-readable descriptor; pay (draw) and retry with the
settlement to get the ticket.

```
AGENT                                   WoCo SERVER                         ARBITRUM
  │  1. GET /api/agent/events            │                                    │
  │ ───────────────────────────────────▶│  discover events                   │
  │ ◀─────────────────────────────────── │                                    │
  │                                       │                                    │
  │  2. POST /grant-params {agent,event} │                                    │
  │ ───────────────────────────────────▶│  server DICTATES the bounds        │
  │ ◀─── recipient,ceiling,expiry,count  │  (recipient = organiser)           │
  │                                       │                                    │
  │  3. USER signs the spend permission   │   (one wallet signature; the       │
  │      naming the AGENT as spender ─────┼──▶ serialized approval has NO key) │
  │                                       │                                    │
  │  4. POST /quote {event,series}        │                                    │
  │ ───────────────────────────────────▶│  exact USDC amount + a one-time     │
  │ ◀─── amount, recipient, intentId      │  purchase INTENT (freshness floor) │
  │                                       │                                    │
  │  5. DRAW: agent signs a gasless       │                                    │
  │     userOp with its OWN key  ─────────┼────────────────────────────────▶  │ Kernel checks
  │     USDC.transfer(organiser, amount)  │                       USDC moves   │ the policy,
  │ ◀──────────────────── settlementTxHash┼──────────────── Kernel→organiser   │ then executes
  │                                       │                                    │
  │  6. POST /buy {event,series,userKernel,settlementTxHash,intentId}          │
  │ ───────────────────────────────────▶│  verify Transfer LOG + freshness    │
  │                                       │  + one-shot the tx ───────────────▶│ read receipt/log
  │                                       │  mint ticket to the user Kernel    │
  │ ◀─────────────────────────── 🎟 ticket│                                    │
```

If the agent calls `/buy` **without** a `settlementTxHash`, step 6 returns **402** with a
`PAYMENT-REQUIRED` descriptor (asset = USDC, `payTo` = organiser, `maxAmountRequired` = amount, plus a
fresh `intentId`) — the agent pays, then retries. This is what lets a generic x402-aware agent
transact without bespoke WoCo knowledge.

---

## 6. Settlement verification — why the server can trust the draw

When the agent settles, the server does **not** trust the request body's claim of payment. It reads
the chain:

1. **Transfer-log proof, not `tx.from`.** A 4337 userOp's outer `tx.from` is the *bundler*, not the
   payer — so the server matches the **ERC-20 `Transfer` event log**: `from = the user's Kernel`,
   `to = the organiser`, `value = the exact quoted amount`, at the per-chain confirmation depth. This
   is a *stronger* guarantee than `tx.from` and is the right primitive for account abstraction.
2. **Freshness via a one-time purchase intent.** `/quote` (and the `/buy` 402 step) issues a short-TTL
   `intentId` with an `issuedAt`. Settlement requires the draw's **block timestamp ≥ issuedAt** (minus
   a small skew), so a *pre-existing* matching USDC transfer can't be replayed to claim a free ticket.
3. **One-shot the tx.** The settlement tx hash is consumed in a global registry before minting, so the
   same draw can never mint two tickets (idempotent under retries/concurrency).
4. **POD gate enforcement.** If the series is gated (holder-only, etc.), the gate is checked against
   the funding/claiming Kernel **before** minting — fail-closed, same rule as the human claim path.

Only after all four pass does the server mint the ticket to the **user's Kernel** (the funder and
recipient are the same address, proven by the Transfer log).

---

## 7. How an agent integrates (the surfaces)

The system is designed so *any* agent runtime can use it — not just ours:

| Surface | Purpose |
|---|---|
| `GET /.well-known/agent.json` | Agent discovery manifest — points at the capabilities + OpenAPI |
| **OpenAPI 3.1** schema | Machine-readable description of `/api/agent/*` for tool-calling agents |
| **REST** `/api/agent/*` | `events`, `events/:id`, `grant-params`, `quote`, `buy` (x402 handshake) |
| **MCP server** (stdio) | A Model Context Protocol server so **Claude (or any MCP client) can drive the buy** directly as a tool |

The MCP server (`apps/server/scripts/agent/mcp.ts`) exposes the discover→quote→buy flow as MCP tools,
so an LLM assistant can be handed a spend permission and asked, in natural language, to buy a ticket —
and it executes the bounded on-chain purchase end-to-end.

---

## 8. The cryptographic stack (and why no third-party custodian)

- **ERC-4337 account abstraction** via **ZeroDev Kernel** smart accounts. The user's wallet is a
  Kernel; the spend permission installs a **scoped session validator** keyed to the agent's address.
- **Gasless** execution via a **paymaster** — the agent's draw costs the user no ETH; gas is sponsored,
  bounded by the gas policy.
- **The agent's draw** = reconstruct the granted permission with the agent's own ECDSA signer
  (`deserializePermissionAccount`) and send `USDC.transfer(organiser, amount)` as a userOp. The Kernel
  validates it against the installed policies before it executes.
- Built on the **same primitives as the rest of WoCo** (the passkey Kernel wallet, EAS, Stylus) — the
  agent rail reuses the production spend-permission machinery; there is **no Alchemy dependency** and no
  custodial intermediary.

> **Engineering note (AA23).** The agent's first draw is an *enable-mode* userOp (it installs the
> session validator and validates in one op). Because this grant's call policy matches `USDC.transfer`'s
> ABI arguments (recipient + ceiling) on top of three more policies, validation is gas-heavy; an
> under-provisioned `verificationGasLimit` makes the wallet's `validateUserOp` run out of gas and revert
> with empty data (surfacing as `AA23 reverted 0x`). The fix is an explicit, generous gas budget for the
> draw (and deploying a fresh user Kernel before its first draw). Full write-up:
> [`AGENT_COMMERCE_SURFACE.md`](./AGENT_COMMERCE_SURFACE.md).

---

## 9. Verified on-chain (Arbitrum Sepolia, 2026-06-12)

| Item | Value |
|---|---|
| User Kernel (funder + recipient) | `0x7D135b15D6a07FB6012CF96212053b2F243bCb99` |
| Organiser (pinned recipient) | `0x7b318c46a6fdc544212ebd83335f6b7414a97925` |
| Bounds granted | ceiling `$100`, max `20` draws, `24h` expiry |
| Draw (USDC userKernel→organiser) | [`0x0e8e688f…c0c44f1`](https://sepolia.arbiscan.io/tx/0x0e8e688ffdc0e3d686b35beb36eae72f3b8b0d964c9744992be107941c0c44f1) |
| Ticket minted | series *Agent Demo Ticket*, edition `#1`, to the user Kernel |
| Off-policy draw (wrong recipient) | **rejected** by the call policy at validation (bundler 400) |

---

## 10. Run it yourself

```bash
npm run dev:server                                    # API :3001 + dev bee tunnel
node --env-file=apps/server/.env --import tsx \
  apps/server/scripts/agent/seed-demo-editions.ts     # one-time: make the demo series claimable
npm run agent:demo -w @woco/server                    # grant → draw → mint → reject, prints Arbiscan links
```

The demo prints each step: the bounds the user grants, the gasless draw tx, the minted ticket, and the
deliberately wrong-recipient draw being rejected on-chain.

---

## 11. Limitations & honest state

- **Arbitrum Sepolia only.** The pull/Kernel/paymaster rail is pinned to `421614` (testnet).
- **Direct-transfer series only.** Escrow series are not yet supported on the agent rail (escrow needs
  changes + audit before going live anywhere).
- The **cumulative spend cap** ($500 default) is the user's stated intent surfaced for the grant; the
  *on-chain* bounds are recipient + per-draw ceiling + window + draw-count (this ZeroDev version has no
  on-chain cumulative-limit policy yet — a drop-in upgrade when it lands).
- A Claude-Desktop-over-MCP screen recording is an optional nice-to-have, not yet captured (the E2E
  demo and MCP server both run today).

---

## 12. Source map

| File | Role |
|---|---|
| `apps/server/src/routes/agent.ts` | the `/api/agent/*` surface (discover, grant-params, quote, x402 buy) |
| `apps/server/src/lib/agent/spend-authority.ts` | server-dictated bounds + log verification + freshness + mint |
| `apps/server/src/lib/agent/purchase-intent.ts` | one-time purchase-intent binding (freshness floor) |
| `apps/server/src/agent/discovery.ts` | `/.well-known/agent.json` + OpenAPI 3.1 generators |
| `apps/server/scripts/agent/zerodev.ts` | the bounded wallet: user grant build + agent self-key draw |
| `apps/server/scripts/agent/demo.ts` | end-to-end demo |
| `apps/server/scripts/agent/mcp.ts` | stdio MCP server (LLM drives the buy) |
| `apps/server/scripts/agent/seed-demo-editions.ts` | seeds a claimable demo series |
| `docs/AGENT_COMMERCE_SURFACE.md` | deeper internal notes + AA23 debugging record |
