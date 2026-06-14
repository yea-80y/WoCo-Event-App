# EAS Social Graph — Likes & Follows

A user-owned social graph for events and brands, built as **EAS attestations** on **Arbitrum Sepolia
(`421614`)**. Companion to [`BUILDATHON_SUBMISSION.md`](./BUILDATHON_SUBMISSION.md); ranking is the
[Stylus aggregator](./STYLUS_AGGREGATOR.md).

---

## Three tools, three jobs

WoCo deliberately uses a different primitive for each job — they are never conflated:

| Job | Tool | Used for |
|---|---|---|
| Own a unique, transferable **asset** | ERC-721 NFT | the [sub-ENS name](./SUBENS_IDENTITY.md) (identity) |
| Make a revocable, queryable **claim/edge** | **EAS attestation** | **likes, follows** (this doc) |
| Hold a private, gaslessly-verifiable **credential** | POD | [tickets, loyalty badges, gates](./SHOP_AND_LOYALTY.md) |

A like/follow is an EAS attestation — **not** an NFT, **not** a POD.

## The schema

```
bytes32 subject, uint8 subjectType        (revocable = true)
```

- `subjectType = 1` → **event** (subject = the event's on-chain id) → this is a **like**.
- `subjectType = 0` → **profile** (subject = the sub-ENS name's namehash) → this is a **follow**.

**Like = `attest`**, **unlike = `revoke(uid)`**. A subject's count is its non-revoked attestations,
deduped by attester. Events and profiles are independently rankable; an owner's brands are never
aggregated together (so reputation stays per-brand and travels on sale).

## The user is the attester (and that's the trust model)

The on-chain **attester is the user's own account** — so the graph is genuinely user-owned, not
asserted by WoCo:

- **Web3 wallet** users attest from their own EOA on Arbitrum Sepolia (their own testnet gas).
- **Passkey** users attest **gaslessly** through their ZeroDev Kernel session key + paymaster. The
  attester identity is the Kernel (`msg.sender`); the literal signer is the scoped session key, so
  the passkey root is never exposed per-like.

**The linchpin:** the server records a like only after it verifies **on-chain** (via
`EAS.getAttestation(uid)`) that the attestation's `attester` equals the **authenticated** parent
address, the schema matches, and the subject matches. The attester is read *from chain*, never
trusted from the request body. EAS itself enforces that only the attester can revoke.

## Server is a cache, not the source of truth

`/api/likes/*` is a read projection over on-chain truth:

- `POST /api/likes/record` verifies on-chain, then updates a file-backed index.
- The whole projection is **rebuildable from EAS logs** (`reconcileFromChain`) — the seam that lets
  the server be dropped later; clients can read counts directly from the
  [Stylus aggregator](./STYLUS_AGGREGATOR.md) via any public RPC.
- Reads: `GET /api/likes/:subjectType/:id`, `/following/:address`, `/trending`.

## Abuse / sybil model

The real threat is **gasless paymaster drain**, not key exposure (parent-as-attester is safe).
Controls, defence-in-depth:

1. **One active like per (attester, subject)** — enforced at the write layer (toggle ⇒ revoke) and
   rejected server-side as a duplicate.
2. **Gate the *sponsorship*, not the right to like** — gasless sponsorship is intended for accounts
   that have paid for a ticket or hosted an event (so accrued fees cover the userOps); anyone else
   can still like via the web3 path on their own gas, keeping the graph open.
3. **Server-side rate limits** (per parent + per IP), plus the on-chain gas policy that already
   bounds per-key drain.

For ranking, the [Stylus aggregator](./STYLUS_AGGREGATOR.md) reserves a weight seam to weight by
**unique paid payer** rather than raw count, to blunt cheap-ticket sybil.

## On-chain addresses (Arbitrum Sepolia `421614`)

| What | Value |
|---|---|
| EAS | `0x2521021fc8BF070473E1e1801D3c7B4aB701E1dE` |
| SchemaRegistry | `0x45CB6Fa0870a8Af06796Ac15915619a0f22cd475` |
| Schema UID | `0x62c5b546e61c567163dcb1af412ddd3b6f3a75dbb0da944e89ca2fbeb01dda64` |

## Evidence it works end-to-end

- **Live now:** `GET https://events-api.woco-net.com/api/likes/trending` returns a real like
  (event subject, count 1) served by the Stylus contract.
- **On-chain E2E (full hashes, verified `status = success`):** a real attestation on our schema,
  `0x09cb5f8fd66dffc713c3711e980b40ed2c59889f3396dc48f840f32183bc2f93`, counted by the aggregator,
  then revoked `0xbbdbe75ed58277e3017ed453592287e71be3296c9f8324f06b596a08f1e91664` and un-counted.
- Passkey **gasless** attest + revoke (attester = the user's Kernel) was also verified on
  2026-06-11.

## Honest state

- **Arbitrum Sepolia (testnet).**
- The like/follow **API + on-chain path are live**; the frontend like/following UI is built at the
  API/contract level and its Swarm deploy is pending.
