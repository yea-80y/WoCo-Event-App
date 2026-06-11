# Stylus Trending Aggregator (#5) — SHIPPED 2026-06-11

Buildathon deadline: **Sun 2026-06-15 23:00**. Built, deployed, E2E-verified, prod-wired.
Companion: `docs/EAS_LIKES_HANDOVER.md` (abuse model §), memories `project_eas_likes`,
`project_stylus_aggregator`.

## What it is
Stylus (Rust→WASM) contract on Arb Sepolia aggregating EAS likes (#4) into trustless
trending/ranking. Replaces the server's `getTrending` projection as the primary read.
Source: `contracts-stylus/like-aggregator/` (unit tests in `src/lib.rs`).

## Deployment record (Arb Sepolia 421614)
| What | Value |
|---|---|
| LikeAggregator | `0x7dbf8d3a58bebb642fa1a478bbffba4675f1ba20` |
| Activation tx | `0x0b928da0c23858ccf8d8b1296f012d2dcde62c4576314c8bb730fc71d283fd5b` |
| Deployer | sponsor wallet `0x7b318c46a6FDC544212ebd83335f6b7414A97925` |
| EAS / schema | hardcoded consts in lib.rs (no initializer → no init-frontrun) |
| Toolchain | Rust 1.87.0 (pinned), stylus-sdk 0.9.0, cargo-stylus 0.10.7, deployed `--no-verify` |

E2E verified on-chain 2026-06-11: attest→record (count=1, 260k gas), idempotent replay
(false), revoke→record (count=0, 105k gas), trending ranks/empties correctly.
Prod's one active like (event `0x06e00750…`) backfilled: tx `0x297ecf5d…`.

## DECISION: pull-based (not resolver-push) — rationale
1. Resolver address is part of the schema UID hash → resolver-push needs a NEW schema
   + re-attesting everything = touching the live #4 rail (forbidden).
2. A resolver couples like/revoke availability to aggregator correctness (resolver
   revert bricks the write path). Pull isolates failure: aggregator bug ⇒ stale
   trending only.
3. Equally trustless: contract staticcalls `EAS.getAttestation(uid)` per submission —
   submitters can prove, never assert. Anyone can sync (permissionless keeper) →
   the server can drop out of write AND read paths over time.
4. Pull supports backfilling pre-existing attestations; a resolver only sees new ones.
Trade-off accepted: counts lag until someone pokes; revoked likes linger until the
revoked UID is resubmitted (same eventual-consistency the projection already had).
Resolver-push remains a possible v2 when a schema migration is otherwise warranted.

## Contract design (locked constraints honoured)
- Count = non-revoked, **deduped by attester**: `active_uid[subject][attester]`
  (UID 0 = sentinel; EAS UIDs are keccaks, never 0).
- Subjects first-class (`bytes32` namehash / onChainEventId); **never owner-aggregated**.
  `subject_types` pinned on first record; `SubjectTypeMismatch` guards collisions.
  Follows = same schema, subjectType 0 → independent profile leaderboard.
- **Weight seam**: `weight_of(attester) -> u64` (v1: always 1). Applied weight stored
  per edge → future unique-paid-payer weighting can't desync removals.
- Self-healing: `record(newUid)` when the counted UID was since revoked swaps in one
  call. Rejects: wrong schema, missing, malformed data (strict 64-byte decode),
  nonzero expirationTime (our writer never sets one; counting expirables would rot).
- Views: `getCount`, `getActiveUid`, `totalSubjects`, `getSubjectAt`,
  `getTrending(subjectType, limit)` (O(n·k) selection — free as a view).

## GOTCHA — Stylus 0.9 multi-value returns
`getTrending` returns ONE ABI tuple (extra outer offset), not a Solidity multi-return.
ethers/cast fragments MUST use `returns (tuple(bytes32[],uint64[]))`. Static-only
tuples (`getSubjectAt`) are unaffected. Canonical ABI:
`STYLUS_LIKE_AGGREGATOR_ABI` in `packages/shared/src/likes/types.ts` (+ address const).

## Server wiring (cache/keeper only — phase-out by design)
- `apps/server/src/lib/likes/stylus-aggregator.ts`: `pokeAggregator(uid)` fire-and-forget
  after every chain-verified `/api/likes/record` (sponsor wallet, serialised queue);
  `getTrendingOnChain` primary read in `GET /api/likes/trending`, projection = fallback.
- `STYLUS_AGGREGATOR_ADDRESS` env overrides the shared const; not required.
- Phase-out path: clients read views via any public RPC (ABI+address in shared);
  any wallet can keeper-poke; server projection then only serves `/following` UX.

## Ops
- Build/test: `cd contracts-stylus/like-aggregator && cargo test`
- Check/deploy: `cargo stylus check|deploy --endpoint https://sepolia-rollup.arbitrum.io/rpc`
  (deploy: `--private-key <sponsor>` `--no-verify` `--max-fee-per-gas-gwei 0.5` — default
  0.02 cap lost a base-fee race once). Requires rustup toolchain 1.87.0 + wasm32 target.
- Redeploy is cheap and safe: state is a derived index, rebuildable by resubmitting
  UIDs (`recordBatch`) from EAS logs / `.data/likes-index.json`.
- `contracts-stylus/*/target/` is gitignored; EXCLUDE it from the deploy rsync.

## Remaining / next
- [ ] Demo polish: trending UI reads (Sonnet; via `/api/likes/trending` — already
      contract-backed) or direct client RPC reads using shared ABI.
- [ ] Unique-paid-payer weighting (post-buildathon): implement `weight_of` against paid
      state (WoCoEventV2 purchases or payment-receipt attestation) — v2 redeploy + backfill.
- [ ] Optional: `cargo stylus cache bid 7dbf8d3a… 0` (ArbOS cache → cheaper calls).
- [ ] Optional: reproducible-verify deploy (drop `--no-verify`) for public verification.
