# WoCo × Arbitrum Buildathon — Submission

**WoCo** is a decentralised event platform: Swarm-hosted frontends and data feeds (no database),
on-chain ticketing, sub-ENS identity, an EAS social graph, a Stylus-powered trending engine, and a
bounded non-custodial **AI-agent commerce** surface. This document is the judge-facing summary; every
claim links to on-chain evidence or a source file.

- **Chain:** Arbitrum Sepolia (`421614`) for all contract work below.
- **Live API:** `https://events-api.woco-net.com`  ·  **Frontend:** `woco.eth.limo` (ENS → Swarm)
- **Source-of-truth record (internal):** [`ARBITRUM_BUILDATHON_PROGRESS.md`](./ARBITRUM_BUILDATHON_PROGRESS.md)
- **Status note:** caveats are listed honestly in [§9](#9-honest-state--what-is-and-isnt-live).

---

## 1. What we built (at a glance)

| # | Component | What it is | On-chain anchor |
|---|---|---|---|
| 1 | **On-chain ticketing** | `WoCoEventV2` — USDC, per-event supply, sponsor-gated `claimFor`/`batchClaimFor` | `0x351070Aff6dECa449506a6eA6dC6cB84D13cAedf` |
| 1b | **Passkey smart wallet** | ZeroDev Kernel, ECDSA-over-PRF root + scoped gasless session keys | commit `a6facab` (live-proven via #4) |
| 1c | **Coinbase Smart Wallet** | CSW login as a first-class identity; multi-chain 1271/6492 verify | `lib/auth/coinbase-account.ts` |
| 3 | **Sub-ENS identity** | `label.woco.eth` sub-names via Durin L2Registry (ERC-721, transferable) | Registrar `0x7c0DE55a1713e6C1a53Db50314C7CB608179aAf1` |
| 4 | **EAS social graph** | likes (events) + follows (profiles) as revocable EAS attestations | schema UID `0x62c5b546…dda64` |
| 5 | **Stylus trending** | Rust→WASM `LikeAggregator`, pull-based, verifies each UID vs EAS | `0x7dbf8d3a58bebb642fa1a478bbffba4675f1ba20` |
| T2 | **Agent commerce** | AI agent buys a ticket with USDC from a bounded spend-permission | draw `0x0e8e688f…` |

The novel through-line: **three distinct tools for three distinct jobs** — NFT/sub-ENS = identity,
EAS = social graph (likes/follows/attendance), POD = tickets/gates — composed into one product, with a
ZeroDev Kernel making every user action gasless, and an agent that can transact within cryptographic
bounds the user sets.

---

## 2. On-chain ticketing + smart wallets (#1, #1b, #1c)

- **`WoCoEventV2`** (`0x351070Aff6dECa449506a6eA6dC6cB84D13cAedf`): USDC escrow, per-event supply,
  sponsor-gated claims (platform sponsor `0x7b318c46a6FDC544212ebd83335f6b7414A97925`). The Stripe
  webhook mints on-chain slots so card buyers get an on-chain ticket without touching a wallet.
  Register+claim smoke-tested E2E on the production stack (2026-05-29). V1 also live at
  `0x172031E6a8428617B05F2002e0e278bb8fb3Ed8A`.
- **ZeroDev passkey wallet (#1b)**: the user's root is an ECDSA key derived from a passkey PRF —
  never on the hot path. Scoped **session keys** sign userOps **gasless** (paymaster-sponsored), each
  pinned by call/timestamp/rate-limit/gas policies. This is the engine behind gasless sub-ENS claims,
  gasless likes, and the agent draw.
- **Coinbase Smart Wallet (#1c)**: an alternative login. CSW signs the `AuthorizeSession` EIP-712 as
  an ERC-1271/6492 signature; the server verifies it with viem's universal validator. Signature
  verification is **multi-chain by design** — Base for CSW, Arbitrum Sepolia for the Kernel wallet —
  so both coexist as first-class identities (fix `da59a83`).
- Security review + mainnet checklist: [`WOCO_EVENT_V2_SECURITY_REVIEW.md`](./WOCO_EVENT_V2_SECURITY_REVIEW.md).
  Integration plan: [`ZERODEV_PASSKEY_INTEGRATION_PLAN.md`](./ZERODEV_PASSKEY_INTEGRATION_PLAN.md).

---

## 3. Sub-ENS identity (#3)

`label.woco.eth` sub-names are minted on Arbitrum via **Durin L2Registry** (ERC-721, so brand
identity travels on transfer). Owner resolution is always **live from chain** — never cached at a
parent. The passkey wallet claims names gaslessly via a client-side permit; the site builder can
reuse an existing name. Registrar `0x7c0DE55a1713e6C1a53Db50314C7CB608179aAf1`, L2Registry
`0x41Fb196Ae7D65E06880A240c8d1B91245Fb84807`. Detail: [`SUB_ENS_ARBITRUM_PLAN.md`](./SUB_ENS_ARBITRUM_PLAN.md).

---

## 4. EAS social graph — likes & follows (#4)

A like/follow is an **EAS attestation** (`bytes32 subject, uint8 subjectType`, revocable), *not* an
NFT or a POD. `subjectType` 0 = profile (sub-ENS namehash) → **follow**; 1 = event (`onChainEventId`)
→ **like**. The **attester is the user's own account** (web3 EOA paying own gas, or the Kernel
attesting gaslessly). The trust linchpin: the server verifies on-chain that `attester == the
authenticated parent` before indexing.

The server's `/api/likes/*` is an **index/cache, not the source of truth** — it verifies each
attestation on-chain, and the whole projection is rebuildable from EAS logs (`reconcileFromChain`).
That's the seam that lets the server be dropped later.

- EAS `0x2521021fc8BF070473E1e1801D3c7B4aB701E1dE`, SchemaRegistry `0x45CB6Fa0870a8Af06796Ac15915619a0f22cd475`,
  schema UID `0x62c5b546e61c567163dcb1af412ddd3b6f3a75dbb0da944e89ca2fbeb01dda64`.
- Verified E2E (2026-06-11, passkey **gasless** attest+revoke, attester = user Kernel): attest
  `0x7ae3ee1c…`, revoke `0xbfd9a5ca…`.
- Design + abuse/sybil model: [`EAS_LIKES_HANDOVER.md`](./EAS_LIKES_HANDOVER.md).

---

## 5. Stylus trending aggregator (#5)

A **Rust → WASM Arbitrum Stylus** contract that ranks events/profiles by likes, **trustlessly**:

- **Address** `0x7dbf8d3a58bebb642fa1a478bbffba4675f1ba20`, activation
  `0x0b928da0c23858ccf8d8b1296f012d2dcde62c4576314c8bb730fc71d283fd5b`.
- **Pull model**: anyone submits attestation UIDs; the contract verifies each against EAS
  (`staticcall getAttestation`) before counting. Permissionless keepers, no trusted submitter, and
  the live #4 schema is untouched (a resolver-push design would have forced a new schema UID).
- Dedup by attester, revocation un-count, self-heal swap, strict validation, independent
  profile/event leaderboards, and a stored-weight seam for unique-paid-payer anti-sybil weighting.
  7 unit tests against a mocked EAS.
- On-chain E2E (2026-06-11): attest `0x09cb5f8f…` → record `0x898c9b7d…` (count=1, ~260k gas incl.
  EAS verify) → idempotent replay returns false → revoke `0xbbdbe75e…` → record `0xd11cb6bf…`
  (count=0, ~105k gas). Production `GET /api/likes/trending` now reads the **contract first**
  (projection only as an RPC-failure fallback). ABI+address shipped in `packages/shared` so any
  client can read it via a public RPC. Full record: [`STYLUS_AGGREGATOR_HANDOVER.md`](./STYLUS_AGGREGATOR_HANDOVER.md).

---

## 6. Agent commerce surface — bounded non-custodial agent wallet (Tier-2)

An autonomous AI agent **discovers a WoCo event and buys a ticket**, paying USDC on Arbitrum Sepolia
from a **spend permission the user granted to the agent's OWN key** — recipient-pinned, per-draw
ceiling, expiry, and draw-count, **all enforced on-chain by the user's ZeroDev Kernel**.

- The agent **never holds funds or an unbounded key**; the WoCo server **never holds either** (it does
  read-only on-chain verification + mints the ticket). Funds move Kernel→organiser directly.
- **Surface:** `/api/agent/*` (discover → grant-params → quote → x402-style `buy`) +
  `/.well-known/agent.json` + OpenAPI 3.1 + a **stdio MCP server** (Claude can drive the buy) + an
  **E2E demo**. Built on the same Kernel/EAS/Stylus primitives — **no Alchemy dependency**.
- A security review of the surface found+fixed two authz gaps before ship: POD-gate enforcement on
  `/buy`, and a one-time **purchase-intent + block-timestamp freshness** binding (stops replaying an
  arbitrary matching USDC transfer).
- **Verified E2E on-chain (2026-06-12):**
  - Draw (USDC userKernel→organiser): [`0x0e8e688ffdc0e3d686b35beb36eae72f3b8b0d964c9744992be107941c0c44f1`](https://sepolia.arbiscan.io/tx/0x0e8e688ffdc0e3d686b35beb36eae72f3b8b0d964c9744992be107941c0c44f1)
  - 🎟 Ticket **minted** to the user Kernel `0x7D135b15D6a07FB6012CF96212053b2F243bCb99`, edition #1.
  - Negative test: a **wrong-recipient draw is rejected** by the on-chain call policy — the bounds bite.
- Full design, the AA23 debugging story, and the verified-tx table:
  [`AGENT_COMMERCE_SURFACE.md`](./AGENT_COMMERCE_SURFACE.md).

---

## 7. Architecture highlights

- **No database.** All app data lives in **Swarm feeds** (events, tickets, profiles, sites), signed
  by the platform feed key today and **moving to client-side feed signing** next (decentralisation seam
  already isolated in the code).
- **Three identity layers:** primary wallet (secp256k1) → session key (30-day) → POD identity
  (ed25519, for tickets/gates). Login = connect; the EIP-712 `AuthorizeSession` is signed lazily on
  first action that needs it.
- **Gasless everywhere it matters:** ZeroDev Kernel + paymaster sponsor sub-ENS claims, likes, and the
  agent draw, each scoped by a session key whose on-chain policies bound what a leaked key could do.
- **Server as a droppable cache:** the likes index and the Stylus read path are both rebuildable from
  chain; the agent server is read-only verification. The trust never sits in our database.

---

## 8. How to verify / run

```bash
# API health
curl https://events-api.woco-net.com/api/health

# Trending — served by the Stylus contract (projection is fallback only)
curl https://events-api.woco-net.com/api/likes/trending

# Agent commerce E2E demo (Arb Sepolia): grant → draw → mint → reject
#   prereqs: dev bee tunnel + a funded test user Kernel + the seeded demo event
npm run dev:server                                   # opens bee tunnel + API :3001
node --env-file=apps/server/.env --import tsx \
  apps/server/scripts/agent/seed-demo-editions.ts    # one-time: seed claimable editions
npm run agent:demo -w @woco/server                   # runs the full E2E, prints Arbiscan links
```

Contract/agent source map: [`AGENT_COMMERCE_SURFACE.md` §File map](./AGENT_COMMERCE_SURFACE.md).

---

## 9. Honest state — what is and isn't live

- `WoCoEventV2` + `LikeAggregator` are **not source-verified on Arbiscan** yet (V2: missing Arbiscan
  key; #5 deployed `--no-verify`). Reproducible verification is an optional follow-up.
- **Stripe is the only live payment rail.** Crypto-payment code + `WoCoEscrow` exist but are disabled
  pending escrow changes + an audit. (The agent rail uses a *direct* USDC transfer, not escrow.)
- Likes/Following/Trending **UI** is API/contract-level; the frontend Swarm deploy of the likes UI is
  pending (user-run `npm run deploy`).
- The agent demo is **run + green on-chain**; a Claude-Desktop-over-MCP screen recording is an optional
  nice-to-have, not yet captured.
- Not built (Tier-2 stretch): Aave yield, Coinbase Onramp, V2 register-path frontend wiring.

---

## 10. Document index

| Doc | Contents |
|---|---|
| [`ARBITRUM_BUILDATHON_PROGRESS.md`](./ARBITRUM_BUILDATHON_PROGRESS.md) | Internal source-of-truth: every address/tx with dates |
| [`AGENT_COMMERCE_SURFACE.md`](./AGENT_COMMERCE_SURFACE.md) | Agent wallet design, AA23 debug notes, verified-tx table |
| [`STYLUS_AGGREGATOR_HANDOVER.md`](./STYLUS_AGGREGATOR_HANDOVER.md) | Stylus contract design + on-chain E2E record |
| [`EAS_LIKES_HANDOVER.md`](./EAS_LIKES_HANDOVER.md) | EAS schema, attester model, abuse/sybil analysis |
| [`SUB_ENS_ARBITRUM_PLAN.md`](./SUB_ENS_ARBITRUM_PLAN.md) | Durin L2Registry sub-ENS identity layer |
| [`WOCO_EVENT_V2_SECURITY_REVIEW.md`](./WOCO_EVENT_V2_SECURITY_REVIEW.md) | Ticketing contract review + mainnet checklist |
| [`ZERODEV_PASSKEY_INTEGRATION_PLAN.md`](./ZERODEV_PASSKEY_INTEGRATION_PLAN.md) | Passkey Kernel wallet + session keys |
