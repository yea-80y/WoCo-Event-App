# WoCo × Arbitrum Buildathon — Progress Record (as of 2026-06-11)

Source-of-truth summary for the final submission docs. Every address/tx below was
taken from code, env, or an on-chain verification performed at the time recorded —
items marked *(prefix)* are recorded truncated; expand from Arbiscan before publishing.
Deadline: **Sun 2026-06-15 23:00**.

WoCo: decentralised event platform — Swarm-hosted frontends/feeds (no database),
Stripe + on-chain ticketing, sub-ENS identity, EAS social graph, Stylus ranking.
All chain work below: **Arbitrum Sepolia (421614)** unless stated.

## Shipped timeline

| Date | Item | Evidence |
|---|---|---|
| 2026-05-26 | #1 WoCoEvent V1 deployed | `0x172031E6a8428617B05F2002e0e278bb8fb3Ed8A` |
| 2026-05-26 | #1 WoCoEventV2 (USDC escrow) deployed | `0x351070Aff6dECa449506a6eA6dC6cB84D13cAedf` |
| 2026-05-29 | V2 register+claim smoke-tested E2E on prod stack | memory `project_arb_smoketest_20260529` |
| 2026-05-27→06 | #1b ZeroDev passkey wallet (Kernel, ECDSA-over-PRF) + scoped session keys | commit `a6facab`; live-proven via #4 |
| 2026-05-28→06 | #3 Sub-ENS identity (Durin L2Registry, `label.woco.eth`) | Registrar `0x7c0DE55a1713e6C1a53Db50314C7CB608179aAf1`, L2Registry `0x41Fb196Ae7D65E06880A240c8d1B91245Fb84807` |
| 2026-06-05 | #4 EAS like schema registered + verified | UID `0x62c5b546e61c567163dcb1af412ddd3b6f3a75dbb0da944e89ca2fbeb01dda64` |
| 2026-06-11 | #4 verified on-chain E2E (passkey gasless attest+revoke, attester = user Kernel) | attest `0x7ae3ee1c…` *(prefix)*, revoke `0xbfd9a5ca…` *(prefix)* |
| 2026-06-11 | #5 Stylus LikeAggregator deployed + activated + E2E + prod-wired | `0x7dbf8d3a58bebb642fa1a478bbffba4675f1ba20` |
| 2026-06-12 | Tier-2 agent commerce surface built (server green; demo + MCP ready) | `docs/AGENT_COMMERCE_SURFACE.md` |

## #1 / #1b — On-chain ticketing + passkey smart wallet
- WoCoEventV2: USDC escrow, per-event supply, sponsor-gated `claimFor`/`batchClaimFor`
  (platform sponsor `0x7b318c46a6FDC544212ebd83335f6b7414A97925`), Stripe webhook mints
  on-chain slots. Security review + mainnet checklist: `docs/WOCO_EVENT_V2_SECURITY_REVIEW.md`.
- ZeroDev Kernel passkey wallet: ed25519-free ECDSA-over-PRF root, scoped session keys
  sign userOps gasless (paymaster); root key never on the hot path. Plan:
  `docs/ZERODEV_PASSKEY_INTEGRATION_PLAN.md`.
- June ZeroDev RPC incident: their bundler returned stub `verificationGasLimit=1`;
  shipped retry-with-explicit-800k workaround (commit `049fc8b`).

## #3 — Sub-ENS identity layer
- `label.woco.eth` sub-names minted on Arbitrum via Durin L2Registry (ERC-721 —
  brand identity travels on transfer). Owner resolution is always LIVE from chain.
- Client-side permit claim from the passkey wallet; on-chain enumeration of owned
  names; reuse-existing in site builder (commits `5f8f7cd`, `eee5a8b`).
- Plan/details: `docs/SUB_ENS_ARBITRUM_PLAN.md`.

## #4 — EAS likes / follows (social graph)
- A like/follow is an EAS attestation (`bytes32 subject, uint8 subjectType`, revocable;
  EAS `0x2521021fc8BF070473E1e1801D3c7B4aB701E1dE`, SchemaRegistry
  `0x45CB6Fa0870a8Af06796Ac15915619a0f22cd475`). subjectType 0 = profile (sub-ENS
  namehash) → follow; 1 = event (`onChainEventId`) → like. Attester = the user's own
  account (web3 EOA own-gas, or Kernel gasless) — server-verified `attester ==
  authenticated parent` is the trust linchpin.
- Server `/api/likes/*` is a CACHE, not truth: verifies on-chain before indexing,
  rebuildable from EAS logs (`reconcileFromChain`). Abuse/sybil model:
  `docs/EAS_LIKES_HANDOVER.md`.

## #5 — Stylus trending aggregator (Rust → WASM)
- `contracts-stylus/like-aggregator/` at `0x7dbf8d3a58bebb642fa1a478bbffba4675f1ba20`,
  activation tx `0x0b928da0c23858ccf8d8b1296f012d2dcde62c4576314c8bb730fc71d283fd5b`.
- PULL model: anyone submits attestation UIDs; the contract verifies each against EAS
  (staticcall `getAttestation`) — permissionless keepers, no trusted submitter, live #4
  schema untouched (resolver-push would have forced a new schema UID).
- Dedup by attester, revocation uncount, self-heal swap, strict data validation,
  independent profile/event leaderboards, stored-weight seam for unique-paid-payer
  anti-sybil weighting. 7 unit tests against a mocked EAS.
- On-chain E2E 2026-06-11: attest `0x09cb5f8fd66dffc713c3711e980b40ed2c59889f3396dc48f840f32183bc2f93`
  → record `0x898c9b7d6cc9a13b712057924dee3c884e45bfee49ea28d69356730b2e2bfee5` (count=1,
  ~260k gas incl. EAS verify) → idempotent replay returns false → revoke
  `0xbbdbe75ed58277e3017ed453592287e71be3296c9f8324f06b596a08f1e91664` → record
  `0xd11cb6bfc1362478fa0de052c2536e670c8dcfc20be763c8047c6ee22d91793d` (count=0, ~105k gas).
- Prod backfill tx `0x297ecf5d27d865e7d13a02eb48d4fd740076b119022b51bbb3ad2e54d668110d`;
  production `GET /api/likes/trending` now serves the contract (projection = RPC-failure
  fallback only). ABI + address in `packages/shared` → clients can read via any public
  RPC (server phase-out by design). Full record: `docs/STYLUS_AGGREGATOR_HANDOVER.md`.

## #1c — Coinbase Smart Wallet (CSW) login + multi-chain signature verify
- CSW is a supported **user login** (smart-account identity on Base), alongside the ZeroDev
  Kernel passkey wallet. Client: `apps/web/src/lib/auth/coinbase-account.ts`,
  `auth/signers/coinbase-signer.ts`, `components/auth/CoinbaseLogin.svelte`.
- CSW signs the `AuthorizeSession` EIP-712 as an ERC-1271 / ERC-6492 signature; the server
  verifies it via viem's universal validator. Two CSW-specific invariants we hit + fixed:
  - **CSW signs on Base regardless of `appChainIds`** — server `SMART_WALLET_VERIFY_CHAIN` is
    pinned to base/base-sepolia, not whatever the app lists.
  - **Connect + sign must be two separate user gestures** (CSW SDK v4 rejects in-flight popup
    listeners → 4001 race); the UI is a two-step Connect → Authorize.
- **Signature verification is multi-chain by design** (`apps/server/src/lib/auth/verify-delegation.ts`,
  `lib/auth/smart-wallet-client.ts`): the server verifies 1271/6492 across every smart-account
  home chain — **Base for CSW + Arbitrum Sepolia for the Kernel wallet** — because a single-chain
  pin previously 403'd all passkey requests (fix `da59a83`). This is what lets the Arbitrum Kernel
  wallet and the Base CSW coexist as first-class identities.

## Tier-2 — Agent commerce surface (bounded non-custodial agent wallet)
- An AI agent discovers a WoCo event and buys a ticket autonomously, paying USDC on Arb Sepolia
  from a **spend permission the user granted to the agent's OWN key** — recipient-pinned,
  per-draw ceiling, expiry, draw count, all enforced on-chain by the user's ZeroDev Kernel.
  The agent never holds funds or an unbounded key; the WoCo server never holds either (read-only
  on-chain verify + mint). Built on the same Kernel/EAS/Stylus primitives — **no Alchemy**.
- Surface: `/api/agent/*` (discover / grant-params / quote / x402-style buy) +
  `/.well-known/agent.json` + OpenAPI 3.1 + a **stdio MCP server** (Claude drives the buy) + an
  **E2E demo** that mints a ticket and shows a wrong-recipient draw rejected on-chain.
- Security review of the new surface found + fixed two server-side authz gaps before ship: POD
  gate enforcement on `/buy`, and a one-time purchase-intent + block-timestamp freshness binding
  (stops replaying arbitrary matching USDC transfers). Full design + verified-tx table:
  `docs/AGENT_COMMERCE_SURFACE.md`.

## Honest-state caveats (do not overclaim in submission)
- WoCoEventV2 + LikeAggregator are NOT source-verified on Arbiscan yet (V2: missing
  ARBISCAN key; #5: deployed `--no-verify` — reproducible verify is optional follow-up).
- Stripe is the ONLY live payment rail; crypto-payment code + WoCoEscrow exist but are
  disabled pending escrow changes + audit.
- Frontend Swarm deploy of the likes UI is pending (user-run `npm run deploy`).
- Trending/Following UI not built yet — trending is currently API/contract-level.
- Agent commerce surface is **built + server-green**, but the E2E demo has not been *run* live
  yet (needs a funded test user Kernel + a USDC/direct-transfer demo event on 421614). The
  verified-tx table in `docs/AGENT_COMMERCE_SURFACE.md` is still to be filled from a live run.
- Other Tier-2 items not built: Aave yield, Coinbase Onramp, V2 register-path frontend wiring.

## Remaining before Sun 2026-06-15 23:00
1. Run the agent demo live (fund a test Kernel + point at a USDC demo event) and paste the
   tx hashes into `docs/AGENT_COMMERCE_SURFACE.md`; optionally record a Claude-Desktop-over-MCP buy.
2. Submission docs (this file + `docs/AGENT_COMMERCE_SURFACE.md` are the source).
3. Frontend deploy (user) + optional Arbiscan verification passes.
