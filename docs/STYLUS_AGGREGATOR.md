# Stylus Trending Aggregator (#5)

A trustless trending/ranking engine for the [EAS social graph](./EAS_SOCIAL_GRAPH.md), written in
**Rust and compiled to WASM** as an **Arbitrum Stylus** contract on **Arbitrum Sepolia (`421614`)**.
Deployed, on-chain E2E-verified, and wired into production. Companion to
[`BUILDATHON_SUBMISSION.md`](./BUILDATHON_SUBMISSION.md).

---

## Why we used Stylus here

Stylus is Arbitrum's own technology (from Offchain Labs) for running **Rust/WASM smart contracts
alongside the EVM**. Trending is a compute-heavy, on-chain-verification workload — exactly the kind
of job Stylus is built for, and the reason we reached for it rather than plain Solidity:

- **Cheaper compute and memory for real work.** For *every* submitted attestation the contract does
  a `staticcall` to EAS, a strict 64-byte decode, dedup bookkeeping, and maintains per-subject
  leaderboards (an O(n·k) selection in `getTrending`). WASM's lower per-operation and memory costs
  make doing this verification + ranking **trustlessly on-chain** practical, rather than something
  we'd be forced to keep on a trusted server.
- **Rust.** A typed, testable language for the fiddly parts — strict attestation decoding,
  dedup-by-attester, revocation handling — with unit tests against a mocked EAS.
- **It composes with the EVM.** The Stylus contract calls **EAS — an existing EVM contract — for its
  trust**, so we get a Rust contract for the heavy logic without giving up the canonical EAS
  attestation registry.
- **It uses Arbitrum's native capability.** Building the ranking engine in Stylus means leaning on
  what's distinctive about the chain we're deploying to, not generic EVM bytecode that could run
  anywhere.

The result is a ranking that **anyone can read and anyone can update**, with no trusted indexer — the
piece that lets WoCo's server drop out of the trending read path entirely.

## What it does

Aggregates EAS likes (#4) into trustless trending. It replaces the server's projection as the
**primary** trending read; the server projection is only an RPC-failure fallback. Source:
`contracts-stylus/like-aggregator/` (unit tests in `src/lib.rs`).

## Pull-based, not resolver-push (design rationale)

Anyone submits attestation UIDs; the contract verifies each against EAS before counting. We chose
pull over an EAS resolver that pushes on attest:

1. A resolver address is part of the EAS schema UID hash — resolver-push would need a **new schema**
   and re-attesting everything, i.e. touching the live #4 rail. Forbidden.
2. A resolver couples like/revoke availability to aggregator correctness (a resolver revert would
   brick the write path). Pull isolates failure: an aggregator bug only makes trending stale.
3. It's equally trustless — the contract `staticcall`s `EAS.getAttestation(uid)` per submission, so
   submitters prove, never assert. **Anyone can sync (a permissionless keeper).**
4. Pull can backfill pre-existing attestations; a resolver only ever sees new ones.

Trade-off accepted: counts lag until someone pokes, and a revoked like lingers until its UID is
resubmitted — the same eventual consistency the projection already had.

## Contract design

- **Count = non-revoked attestations, deduped by attester** (`active_uid[subject][attester]`).
- **Subjects are first-class** (`bytes32` namehash / on-chain event id) and **never owner-aggregated**;
  `subjectType` is pinned on first record (guards collisions). Follows share the schema with
  `subjectType = 0` → an independent profile leaderboard.
- **Weight seam:** `weight_of(attester) -> u64` (v1 = 1), with the applied weight stored per edge so
  a future unique-paid-payer weighting can't desync removals.
- **Self-healing:** re-recording a subject whose counted UID was since revoked swaps it in one call.
  Rejects wrong schema, missing/malformed data, or non-zero expiration.
- **Views:** `getCount`, `getActiveUid`, `totalSubjects`, `getSubjectAt`, and
  `getTrending(subjectType, limit)` (a free view).

### Developer gotcha — Stylus 0.9 multi-value returns

`getTrending` returns **one ABI tuple** (an extra outer offset), not a Solidity multi-return.
ethers/cast fragments must declare `returns (tuple(bytes32[], uint64[]))`. The canonical ABI +
address ship in `packages/shared` so any client can read the contract over a public RPC.

## Server wiring (cache/keeper only — phase-out by design)

- After every chain-verified `/api/likes/record`, the server fire-and-forget **pokes** the aggregator
  with the UID (a keeper role any wallet could perform).
- `GET /api/likes/trending` reads the **contract first**; the projection is a fallback only.
- Phase-out path: clients read the views via any public RPC (ABI + address are in the shared package),
  any wallet can keeper-poke, and the server projection then only serves the `/following` UX.

## Deployment + on-chain evidence (Arbitrum Sepolia `421614`)

| What | Value |
|---|---|
| `LikeAggregator` | `0x7dbf8d3a58bebb642fa1a478bbffba4675f1ba20` |
| Deployment (creation) tx | `0x1ab35ea3b70d0df495aaac7de7cfb1dec488c102f96d61fc32e0b02939a2e8ec` |
| Activation tx | `0x0b928da0c23858ccf8d8b1296f012d2dcde62c4576314c8bb730fc71d283fd5b` |
| Toolchain | Rust 1.87.0 (pinned), stylus-sdk 0.9.0, cargo-stylus 0.10.7 |
| Source-verified on Arbiscan | Not yet (deployed `--no-verify`) |

On-chain E2E (2026-06-11), all `status = success`:

| Step | Tx | Result |
|---|---|---|
| Attest (EAS, our schema) | `0x09cb5f8fd66dffc713c3711e980b40ed2c59889f3396dc48f840f32183bc2f93` | — |
| Record | `0x898c9b7d6cc9a13b712057924dee3c884e45bfee49ea28d69356730b2e2bfee5` | count = 1 (~260k gas incl. EAS verify) |
| Idempotent replay | — | returns false (no double-count) |
| Revoke | `0xbbdbe75ed58277e3017ed453592287e71be3296c9f8324f06b596a08f1e91664` | — |
| Record | `0xd11cb6bfc1362478fa0de052c2536e670c8dcfc20be763c8047c6ee22d91793d` | count = 0 (~105k gas) |
| Prod backfill | `0x297ecf5d27d865e7d13a02eb48d4fd740076b119022b51bbb3ad2e54d668110d` | live like indexed |

`GET https://events-api.woco-net.com/api/likes/trending` is served by this contract today.

## Roadmap

- **Unique-paid-payer weighting** — implement `weight_of` against paid state (on-chain ticket
  purchases) so trending weights real buyers over cheap sybil likes (a redeploy + backfill; state is
  a derived index and safely rebuildable).
- **Source verification** — a reproducible Stylus verify is ready to run
  (`cargo stylus verify --deployment-tx 0x1ab35ea3b70d0df495aaac7de7cfb1dec488c102f96d61fc32e0b02939a2e8ec`);
  it needs a Docker host for the reproducible build, which is the only reason it's outstanding. The
  full Rust source is in this repo at `contracts-stylus/like-aggregator/` regardless.
