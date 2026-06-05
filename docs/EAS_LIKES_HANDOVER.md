# EAS Likes (#4) — Build Handover

**Status:** architecture LOCKED (planning chat 2026-06-05). Code not started. Build in a fresh chat.
**Buildathon:** items #4 (likes/attendance) + #5 (Stylus aggregator). Deadline Fri 2026-06-13.
**Branch:** `feat/woco-shop` (or cut `feat/likes`).
**Read alongside:** `docs/SUB_ENS_ARBITRUM_PLAN.md` (identity layer), memory `project_subens_arbitrum`,
`project_zerodev_passkey`, `project_referrals`.

---

## What we're building
Profile-likes / following for event brands. A user likes a **brand profile** or an **event**; likes
are **EAS attestations** on Arbitrum Sepolia, the social graph is queryable both directions, and (#5,
later) a Stylus contract aggregates trending.

## Locked decisions

### Three tools, three jobs — do not conflate
| Job | Tool | Used for |
|---|---|---|
| Own a unique, transferable **asset** | ERC-721 NFT | the sub-ENS **identity/name** |
| Make a revocable, queryable **claim/edge** | **EAS attestation** | **likes**, follows, attendance, referrals |
| Hold a private, gaslessly-verifiable **credential** | POD | tickets, loyalty badges, holdings-gates |

The like is an EAS attestation — NOT an NFT, NOT a POD. PODs are untouched.

### Identity / keying (load-bearing)
- Each sub-ENS and each event is a **first-class, independently-rankable, transferable entity**.
  **NEVER aggregate likes at the parent/owner level** — it would conflate an owner's multiple brands and
  break reputation-on-sale.
- **Subject** of a like = `bytes32`:
  - **Profile/brand** → the sub-ENS **namehash** (ERC-721 in Durin's L2Registry → reputation travels on
    sale, which is the desired behaviour). Derive with the existing
    `computeLabelNode(label)` (`apps/server/src/lib/chain/sub-ens-contract.ts:44`) =
    `keccak256(concat([namehash("woco.eth"), keccak256(label)]))`.
    Accepted consequence: a brand is only a likeable "profile" once it has a sub-ENS (good funnel).
  - **Event** → on-chain `eventId` (`bytes32`, `SeriesSummary.onChainEventId`).
- **Attester** (liker) = the user's **account address** — likes key to it forever; survives a later
  attendee sub-ENS claim (address→name is display only).
- **Owner association** = resolved **live** from chain (`L2Registry.ownerOf` / event organiser), NOT baked
  into the attestation (avoids stale owner after transfer). Keeps the schema minimal.
- **Future "one brand, two names"** (`punkpub.woco.eth` + own `punkpub.eth`): nominate one canonical id,
  alias the other via a text record. Deferred — does not block #4 (1 name/brand today).

### EAS schema
`bytes32 subject, uint8 subjectType` — `subjectType` = `0` profile | `1` event. `revocable = true`.
**Like = `attest`**, **unlike = `revoke(uid)`**. Count = non-revoked attestations per subject, deduped by
attester.

### Write path — Option 1 (user-attested)
- The user's own account is the on-chain attester → user-owned, trustless graph.
- **Passkey accounts** (the "create an account to like" funnel) attest **GASLESS** via their ZeroDev
  Kernel session key + paymaster — reuse the sub-ENS rail (`registerSubEnsViaPermit` →
  `client.sendUserOperation`, `apps/web/src/lib/auth/kernel-account.ts`).
- **Web3 wallet (MetaMask)** attests via the user's own wallet on Arb Sepolia (own trivial testnet gas).
  Same calldata, submitted through the web3 signer instead of the Kernel client.
- **Para/email gasless + universal = Option 2 (delegated attestation), future.** Para→Privy swap later is
  transparent (likes key to address). Flag only; no action now.

### Reads — server projection of on-chain truth
- Primary: after the client attest/revoke confirms, client POSTs `uid` + subject; server **verifies
  on-chain** via `EAS.getAttestation(uid)` (attester == authenticated `parentAddress`, subject + schema
  match, `revocationTime` for unlike) then updates `.data/likes-index.json`. Mirrors the sub-ENS
  "reconciled vs on-chain" `.data/sub-ens-owners.json` pattern — trustless-enough + instant.
- Optional hardening: periodic reconcile/poller over EAS `Attested`/`Revoked` logs filtered by `schemaUID`
  (cursor in the same store). Not required for the demo.

### Abuse / sybil + paymaster-drain model (locked 2026-06-05)
The threat is NOT key exposure (parent-as-attester is correct + safe — see below); it's **gasless
paymaster drain**. Key insight: **dedup-on-count ≠ dedup-on-spend** — EAS lets one account attest the
same subject N times (N UIDs, each a sponsored userOp), even though our projection counts it once. So
"like once" protects ranking integrity, not the tank. Controls (defence in depth):
1. **One active like per (attester, subject)** enforced at the WRITE layer: client refuses a 2nd `attest`
   when an active like exists (toggle→`revoke` instead); server `/record` rejects a duplicate.
2. **Gate the SPONSORSHIP, not the right-to-like.** Gasless (our paymaster) only for accounts that have
   **paid** for a ticket (non-zero platform fee) or **hosted** an event — we've then accrued fees that
   cover thousands of Arb-Sepolia userOps. Non-eligible accounts may still like via the **web3 path on
   their own gas** → keeps the graph open + preserves the "create an account to like" funnel. NB: free /
   zero-fee tickets accrue ~no revenue — gate on paid only, or cap free-ticket likers.
3. **Rate-limit server-side** (per parent + per IP), NOT in the on-chain call policy — the on-chain
   `toGasPolicy` cap already bounds per-key drain, and an untested `toRateLimitPolicy` risks the same
   `PolicyFailed`-before-paymaster class that already forced `enforcePaymaster` off. Cap toggles/day too.
4. **Parent-as-attester is safe** (verified): web3 = parent EOA signs directly (own gas); passkey =
   attester *identity* is the Kernel (`msg.sender`), literal signer is the **scoped session key** (root
   PRF never exposed per-like). This is a COLD, user-confirmed, zero-value, revocable action — same class
   as the one EIP-712 `AuthorizeSession`. The rule is "parent off the HOT automated path (feeds/requests)",
   NOT "parent never signs". Server attester-binding (`attester == verified parentAddress`) is the linchpin
   that makes it meaningful — non-negotiable. EAS enforces revoke-only-by-attester on-chain (`AccessDenied`).
For #5 (Stylus trending) weight by **unique paid payer**, not raw count, to blunt cheap-ticket sybil.

### Stylus aggregator (#5)
On-chain trending/ranking over EAS — **separate Opus build, next phase.** Out of scope for #4 below.

---

## Contracts / addresses — RE-VERIFY on Arbiscan before wiring (crypto-expert posture)
| What | Address (Arb Sepolia 421614) |
|---|---|
| EAS | `0x2521021fc8BF070473E1e1801D3c7B4aB701E1dE` |
| SchemaRegistry | `0x45CB6Fa0870a8Af06796Ac15915619a0f22cd475` |
| Sub-ENS L2Registry (`ownerOf`/namehash) | `0x41Fb196Ae7D65E06880A240c8d1B91245Fb84807` |
| WoCoEventV2 | `0x351070Aff6dECa449506a6eA6dC6cB84D13cAedf` |

Source: `ethereum-attestation-service/eas-contracts/deployments/arbitrum-sepolia/`.

---

## Build slice (ordered) — #4 only

**Opus (core — prove write+read first):**
1. **Shared types** — `packages/shared/src/likes/{types.ts,index.ts}`: schema string, `SubjectType`
   enum, `LikeSubject`/`LikeRecord` types, `EAS_ADDRESS`/`EAS_SCHEMA_UID`/`EAS_CHAIN_ID` constants.
   Add `export * from "./likes/index.js"` to `packages/shared/src/index.ts`.
2. **Register schema once** — tsx/forge script: `SchemaRegistry.register("bytes32 subject,uint8 subjectType",
   address(0), true)` on Arb Sepolia → print `schemaUID`. Record in `apps/server/.env` (master) + shared.
3. **Client write** — `apps/web/src/lib/eas/attest.ts`: encode `EAS.attest`/`revoke` calldata (viem
   `encodeFunctionData` + `encodeAbiParameters`); submit via `getWocoSessionClient()` (passkey, gasless)
   or web3 signer (MetaMask, own gas). **Widen `createWocoSessionKey` call policy** (`kernel-account.ts:408`)
   to also permit `attest`+`revoke` on the EAS address — existing session keys must be re-minted (OK in dev).
4. **Sign-in-to-act helper** — `apps/web/src/lib/auth/ensure-action.ts`: compose the existing inline
   pattern (`loginRequest.request()` → `ensureSession()`/`ensureWocoSessionKey()`) into reusable
   `requireAccountForAction()`. ADDITIVE only — no component state moves (`feedback_claimbutton_refactor_safety`).
   LikeButton is first consumer; gated-card flow reuses it via existing `CheckoutError { gated }`
   (`apps/web/src/lib/api/stripe.ts`).
5. **Server index store** — `apps/server/src/lib/likes/index-store.ts`: `.data/likes-index.json`, mirror
   `apps/server/src/lib/event/reservation-store.ts` (load-on-startup, persist-on-mutation, per-subject mutex).
   `{subject → Set<attester>}` + uid per (subject,attester) for unlike + derived count.
6. **Server routes** — `apps/server/src/routes/likes.ts`, mount `app.route("/api/likes", …)` in
   `apps/server/src/index.ts` (specific routes BEFORE any `/:id`):
   - `POST /api/likes/record` (auth) `{ subject, subjectType, uid, action }` → verify on-chain → update index.
   - `GET /api/likes/:subjectType/:id` → `{ count, likedByViewer }`.
   - `GET /api/likes/following/:address` → subjects liked by address.
   - `GET /api/likes/trending?subjectType=` → top subjects by count (server projection; Stylus later).

**Sonnet (UI, after Opus proves write+read):**
7. `LikeButton.svelte` — heart/count pill, optimistic toggle → `requireAccountForAction()` → attest/revoke
   → `POST /record`. On EventCard/EventDetail (event subject) + brand/profile header (namehash subject).
8. Profile **"Following"** tab + **trending** list. Concrete & Acid tokens + custom SVG
   (`feedback_avoid_claude_default_look`) — no generic Tailwind/indigo tells.

Flag any signing / contract / funds change back to Opus.

---

## Verification (end-to-end)
- Schema register tx on Arbiscan; `schemaUID` deterministic.
- Passkey like → `Attested` on Arbiscan, **user paid no gas**; count endpoint +1.
- Unlike → `Revoke` on Arbiscan; count −1; `likedByViewer=false`.
- MetaMask like → attester = EOA, own gas, indexed.
- `GET /following/:address` correct; trending orders by count.
- `npm run build:server` + `build:web` typecheck green.

---

## Key files (from exploration)
- `apps/web/src/lib/auth/kernel-account.ts` — `createWocoSessionKey` (call policy `:408`),
  `getWocoSessionClient`, `registerSubEnsViaPermit` (`sendUserOperation` pattern).
- `apps/web/src/lib/auth/auth-store.svelte.ts` — `auth.parent`/`auth.podAddress`/`auth.kind`,
  `ensureWocoSessionKey()` (passkey-only), `ensureSession()`.
- `apps/web/src/lib/auth/login-request.svelte.ts` — `loginRequest.request() => Promise<boolean>`.
- `apps/web/src/lib/api/client.ts` — `authPost`/`authGet`/`buildAuthHeaders`.
- `apps/web/src/lib/api/sub-ens.ts` — reference api module (`claimSubEnsViaPermit`).
- `apps/server/src/lib/chain/sub-ens-contract.ts` — `computeLabelNode`, provider setup, sponsor signing.
- `apps/server/src/lib/event/reservation-store.ts` — `.data/*.json` store pattern to mirror.
- `apps/server/src/lib/chain/event-contract-v2.ts` — `onChainEventId` derivation.
- `apps/server/src/index.ts` — route mounting + CORS allow-headers + ordering gotcha.
- `packages/shared/src/index.ts` — barrel; add the likes module here.
