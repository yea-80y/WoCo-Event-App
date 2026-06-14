# WoCo × Arbitrum Buildathon — Submission

**WoCo** is a decentralised event + commerce platform: Swarm-hosted frontends and data feeds (no
database), on-chain ticketing, sub-ENS identity, an EAS social graph, a **Rust/WASM Stylus** trending
engine, a USDC merchant shop with on-chain loyalty, and a bounded non-custodial **AI-agent commerce**
surface. This is the judge-facing summary; every claim links to on-chain evidence or a clean
companion doc.

- **Chain:** Arbitrum Sepolia (`421614`) for all contract work below.
- **Live API:** `https://events-api.woco-net.com`  ·  **Frontend:** `woco.eth.limo` (ENS → Swarm)
- **Honest caveats:** collected in [§9](#9-honest-state).

---

## 1. What we built (at a glance)

| # | Component | What it is | On-chain anchor |
|---|---|---|---|
| 1 | **On-chain ticketing** | `WoCoEventV2` — USDC, per-event supply, sponsor-gated `claimFor` / `batchClaimFor` | `0x351070Aff6dECa449506a6eA6dC6cB84D13cAedf` |
| 1b | **Passkey smart wallet** | ZeroDev Kernel on Arbitrum: ECDSA-over-PRF root + scoped gasless session keys | live-proven via #4 + the agent rail |
| 1c | **Coinbase Smart Wallet** | CSW login as a first-class identity; multi-chain 1271/6492 verify | `lib/auth/coinbase-account.ts` |
| 3 | **Sub-ENS identity** | `label.woco.eth` sub-names via Durin L2Registry (ERC-721, transferable) | Registrar `0x7c0DE55a1713e6C1a53Db50314C7CB608179aAf1` |
| 4 | **EAS social graph** | likes (events) + follows (profiles) as revocable EAS attestations | schema UID `0x62c5b546…dda64` |
| 5 | **Stylus trending** | **Rust → WASM** `LikeAggregator`, pull-based, verifies each UID against EAS | `0x7dbf8d3a58bebb642fa1a478bbffba4675f1ba20` |
| S | **Shop + POD loyalty** | USDC merchant shop (web + POS), capped spend-permission rail, on-chain loyalty badges | reuses Kernel spend permissions + `WoCoEventV2` gate hook |
| A | **Agent commerce** | AI agent buys a ticket with USDC from a bounded, non-custodial spend permission | draw `0x0e8e688f…` (verified) |

**The through-line — three distinct tools for three distinct jobs**, composed into one product:
NFT/sub-ENS = identity, EAS = social graph (likes/follows), POD = tickets/loyalty/gates. A ZeroDev
Kernel makes every user action gasless on Arbitrum; an Arbitrum-native **Stylus** contract ranks the
graph trustlessly; and an agent can transact within cryptographic bounds the user sets.

## 2. Built on Arbitrum's own primitives (why this is on-theme)

We deliberately built on what's distinctive about Arbitrum rather than generic EVM glue:

- **Stylus (Arbitrum's Rust/WASM contracts)** for the compute-heavy, verification-heavy trending
  engine — see [#5](#5-stylus-trending-engine-5) below. This is the headline Arbitrum-native piece.
- **ZeroDev Kernel (ERC-4337) on Arbitrum** as the account-abstraction layer for passkey wallets,
  gasless session keys, and the agent/shop spend-permission rails — **no Alchemy / no second custody
  stack**; the primitives we already run *are* the agent wallet.
- **EAS** (canonical on Arbitrum) for the social graph, with the Stylus contract calling EAS via
  Stylus↔EVM interop.
- **Durin L2Registry** for sub-ENS names as ERC-721s on Arbitrum.
- **No database — and a server we can drop.** All app data lives in Swarm feeds; the EAS likes index
  and the Stylus read path are both rebuildable from chain, so trust never sits in our database.

## 3. On-chain ticketing + smart wallets (#1, #1b, #1c)

`WoCoEventV2` is USDC ticketing with per-event supply, a 1.5% platform fee (capped on-chain at 10%),
time-locked organiser payout, and refunds. **Sponsor-gated `claimFor`/`batchClaimFor`** means a card
buyer who never touches a wallet still gets an on-chain ticket — the Stripe webhook drives the mint.

Two smart-account logins make everything gasless and seedless:
- **Passkey wallet (ZeroDev Kernel):** root key is ECDSA derived from the passkey PRF (off the hot
  path); scoped **session keys** sign gasless userOps, each bounded by on-chain call/timestamp/
  rate-limit/gas policies.
- **Coinbase Smart Wallet:** signs `AuthorizeSession` as an ERC-1271/6492 signature; the server
  verifies **multi-chain by design** (Base for CSW, Arbitrum Sepolia for the Kernel) so both coexist.

→ Detail + security review: [`ONCHAIN_TICKETING.md`](./ONCHAIN_TICKETING.md).

## 4. Sub-ENS identity (#3)

`label.woco.eth` sub-names minted on Arbitrum via **Durin L2Registry** as **ERC-721 tokens**, so a
brand's identity (and its reputation) **travels on transfer**. Ownership resolves **live from chain**
(`ownerOf`), never cached. Passkey users claim gaslessly via a server-signed permit; one name per
profile; names route at events and back the site builder.

→ Detail: [`SUBENS_IDENTITY.md`](./SUBENS_IDENTITY.md).

## 5. EAS social graph — likes & follows (#4)

A like/follow is an **EAS attestation** (`bytes32 subject, uint8 subjectType`, revocable) — not an NFT,
not a POD. `subjectType` 0 = profile (sub-ENS namehash) → **follow**; 1 = event (on-chain id) → **like**.
The **attester is the user's own account** (web3 EOA own-gas, or the Kernel attesting gaslessly). The
trust linchpin: the server records a like only after verifying **on-chain** that `attester == the
authenticated parent`. `/api/likes/*` is a rebuildable cache, not the source of truth.

→ Detail + sybil model: [`EAS_SOCIAL_GRAPH.md`](./EAS_SOCIAL_GRAPH.md).

## 6. Stylus trending engine (#5)

A **Rust → WASM Arbitrum Stylus** contract that ranks events and profiles by likes, **trustlessly**.
We used Stylus because trending is a compute-heavy on-chain-verification workload — for each submitted
attestation the contract `staticcall`s EAS, strictly decodes it, dedups by attester, and maintains
per-subject leaderboards. WASM's cheaper compute/memory makes doing that **on-chain** practical
instead of trusting a server.

- **Pull model:** anyone submits attestation UIDs; the contract verifies each against EAS before
  counting. Permissionless keepers, no trusted submitter, and the live #4 schema stays untouched (a
  resolver-push design would have forced a new schema UID).
- Dedup by attester, revocation un-count, self-heal swap, independent profile/event leaderboards, and
  a stored-weight seam for unique-paid-payer anti-sybil weighting. Unit-tested against a mocked EAS.
- **Production `GET /api/likes/trending` reads the contract first** (projection only as an
  RPC-failure fallback). ABI + address ship in `packages/shared`, so any client can read it via a
  public RPC — the seam to drop our server entirely.

→ Detail + the Stylus↔EVM tuple-return gotcha: [`STYLUS_AGGREGATOR.md`](./STYLUS_AGGREGATOR.md).

## 7. Shop + POD loyalty (S) and agent commerce (A)

**Shop** — a USDC merchant shop with one catalog and two front-ends (web storefront + staff POS).
USDC is surfaced as £/$ (no points token). Two rails: card (Stripe) and crypto (USDC), the latter via
a per-order signed quote *or* the headline **capped, time-boxed Spend Permission** (a ZeroDev Kernel
session key): USDC stays in the attendee's own wallet and the venue draws only up to a per-draw
ceiling, only to the merchant, only in-window — a compromised terminal can't exceed the cap.
**POD loyalty** derives points from the order feed (never a points token) and **mints soulbound badge
PODs at spend milestones**, with a shared holdings primitive powering event + product gating.
→ [`SHOP_AND_LOYALTY.md`](./SHOP_AND_LOYALTY.md).

**Agent commerce** — an AI agent discovers a WoCo event and **buys a ticket autonomously**, paying
USDC from a spend permission the user granted to the **agent's own key** — recipient-pinned, per-draw
ceiling, expiry, draw-count, **all enforced on-chain by the user's Kernel**. The agent never holds
funds or an unbounded key; the server only does read-only on-chain verification + mints. Surfaced via
`/api/agent/*` + `/.well-known/agent.json` + OpenAPI 3.1 + a **stdio MCP server** (Claude can drive
the buy). **Verified on-chain end-to-end (2026-06-12):** bounded grant → agent self-key draw → ticket
minted → a wrong-recipient draw rejected by the on-chain policy.
→ [`WOCO_AGENT_ARCHITECTURE.md`](./WOCO_AGENT_ARCHITECTURE.md) (engineering deep-dive +
AA23 debug notes: [`AGENT_COMMERCE_SURFACE.md`](./AGENT_COMMERCE_SURFACE.md)).

---

## 8. Deployments & on-chain evidence

All on **Arbitrum Sepolia (`421614`)**. Every contract below was confirmed to have live bytecode, and
every transaction below returns `status = success` on-chain.

### Contracts

| Contract | Address | Source-verified on Arbiscan |
|---|---|---|
| `WoCoEventV2` (ticketing) | `0x351070Aff6dECa449506a6eA6dC6cB84D13cAedf` | ✅ Yes |
| `WoCoEvent` (V1) | `0x172031E6a8428617B05F2002e0e278bb8fb3Ed8A` | No (superseded by V2) |
| Sub-ENS Registrar | `0x7c0DE55a1713e6C1a53Db50314C7CB608179aAf1` | ✅ Yes |
| Sub-ENS L2Registry (Durin) | `0x41Fb196Ae7D65E06880A240c8d1B91245Fb84807` | ✅ Yes |
| `LikeAggregator` (Stylus, Rust/WASM) | `0x7dbf8d3a58bebb642fa1a478bbffba4675f1ba20` | Not yet (`--no-verify`) |
| EAS | `0x2521021fc8BF070473E1e1801D3c7B4aB701E1dE` | Canonical EAS |
| EAS SchemaRegistry | `0x45CB6Fa0870a8Af06796Ac15915619a0f22cd475` | Canonical EAS |
| USDC (Circle test) | `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` | Canonical Circle |

- **EAS like/follow schema UID:** `0x62c5b546e61c567163dcb1af412ddd3b6f3a75dbb0da944e89ca2fbeb01dda64`
- **Platform sponsor (public EOA):** `0x7b318c46a6FDC544212ebd83335f6b7414A97925`

### Key transactions

| What | Tx hash |
|---|---|
| Agent commerce draw (USDC userKernel→organiser) | `0x0e8e688ffdc0e3d686b35beb36eae72f3b8b0d964c9744992be107941c0c44f1` |
| Stylus contract activation | `0x0b928da0c23858ccf8d8b1296f012d2dcde62c4576314c8bb730fc71d283fd5b` |
| EAS like (attest, our schema) | `0x09cb5f8fd66dffc713c3711e980b40ed2c59889f3396dc48f840f32183bc2f93` |
| Stylus record → count = 1 | `0x898c9b7d6cc9a13b712057924dee3c884e45bfee49ea28d69356730b2e2bfee5` |
| EAS unlike (revoke) | `0xbbdbe75ed58277e3017ed453592287e71be3296c9f8324f06b596a08f1e91664` |
| Stylus record → count = 0 | `0xd11cb6bfc1362478fa0de052c2536e670c8dcfc20be763c8047c6ee22d91793d` |
| Stylus prod backfill (live like) | `0x297ecf5d27d865e7d13a02eb48d4fd740076b119022b51bbb3ad2e54d668110d` |

Explorer: prefix any address/tx with `https://sepolia.arbiscan.io/` (`/address/…` or `/tx/…`).

### Verify the live stack

```bash
curl https://events-api.woco-net.com/api/health          # {"ok":true}
curl https://events-api.woco-net.com/api/likes/trending  # served by the Stylus contract
curl https://events-api.woco-net.com/.well-known/agent.json   # agent capability card
```

---

## 9. Honest state

- **Everything above is on Arbitrum Sepolia (testnet).** Go-live is largely a config/USDC-address swap.
- `WoCoEventV2`, the sub-ENS registrar, and the Durin L2Registry are **source-verified on Arbiscan**
  (read the code at the address). The Stylus `LikeAggregator` is **not** yet (deployed `--no-verify`;
  reproducible Stylus verification is a follow-up), and V1 is superseded by V2.
- **Stripe is the only fully-live payment rail.** The direct USDC ticket/shop payment code and the
  spend-permission rails are built and reviewed; `WoCoEscrow` is disabled pending changes + an audit.
  (The agent rail and shop rail use a *direct* USDC transfer, not escrow.)
- The **agent commerce E2E is verified on-chain**; the **shop** spend-permission rail has the same
  fixes ported but still needs a live on-chain settle to confirm end-to-end.
- The likes/following/trending **API + on-chain path are live**; the frontend like UI's Swarm deploy
  is pending.

---

## Document index (judge-facing, all in this repo)

| Doc | Contents |
|---|---|
| [`ONCHAIN_TICKETING.md`](./ONCHAIN_TICKETING.md) | `WoCoEventV2` + passkey Kernel + CSW + security review |
| [`SUBENS_IDENTITY.md`](./SUBENS_IDENTITY.md) | Durin L2Registry sub-ENS identity layer |
| [`EAS_SOCIAL_GRAPH.md`](./EAS_SOCIAL_GRAPH.md) | EAS schema, attester model, abuse/sybil analysis |
| [`STYLUS_AGGREGATOR.md`](./STYLUS_AGGREGATOR.md) | Stylus (Rust/WASM) trending contract + on-chain E2E |
| [`SHOP_AND_LOYALTY.md`](./SHOP_AND_LOYALTY.md) | USDC shop, capped spend-permission rail, POD loyalty |
| [`WOCO_AGENT_ARCHITECTURE.md`](./WOCO_AGENT_ARCHITECTURE.md) | Bounded non-custodial agent commerce — full explainer |
| [`AGENT_COMMERCE_SURFACE.md`](./AGENT_COMMERCE_SURFACE.md) | Agent surface engineering notes + AA23 debug record |
