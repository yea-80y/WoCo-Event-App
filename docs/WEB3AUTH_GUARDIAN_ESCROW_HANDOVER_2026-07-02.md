# Handover — web3auth guardian escrow + recovery-target choice (Fable #3)

Branch `feat/feed-signer-recovery`. Start a FRESH chat from this doc. Read
alongside `FEED_SIGNER_REVIEW_2026-07-02.md` (lock-down plan §3) and
`PASSKEY_RECOVERY_PLAN.md` (§11 escrow, §13 guardian SOC).

Test setup: `npm run dev:web` (localhost:5173) → PRODUCTION api. Client edits live
on localhost; SERVER edits need a deploy. This task is CLIENT-ONLY (no server change).

---

## DONE this session (committed 02d5d8c) — do not redo
Workstream A: web3auth client-owned feeds resolve across sign-out/in AND cold
device. Cold-device gate PASSED + verified (profile SOC provably on gateway;
deterministic signer 0x9c9c… across Chrome+Chromium). Root cause was a client read
race + poisoned cache, NOT crypto — fixed by making the passive self-read resolver
(`_getContentFeedSignerAddress`) ESTABLISH the signer on demand for silent-derivable
kinds (web3auth/local). Details in commit + `project_web3auth_feeds_postage_20260702`.

---

## TASK — Fable lock-down §3, with owner's recovery-target expansion

### Goal
Give **web3auth (email/social) users** guardian account recovery, sealing BOTH
`podSeed` AND `feedSignerPrivKey` into the same generic guardian bundle passkey
users use. Closes the Web3Auth-repoint orphaning risk (their key reconstruction is
a `FEED_PRIVATE_KEY`-class EXTERNAL config dependency). **Not for web3 wallets**
(re-sign is their recovery; parent lost anyway — revisit post-7702). **No user
choice on the escrow MECHANISM** (credential-driven).

### Owner decision (2026-07-02) — the expansion vs the naive plan
Recovery must **NOT force web3auth users to become passkey**. On recovery, rotate
the Kernel owner to the credential the user PICKS:
- **default: log in with email/social again** (a possibly-different Web3Auth login)
  → its EOA becomes the new Kernel owner; account stays `web3auth`.
- **option: mint a passkey** (the existing portal path) → PRF-EOA becomes owner;
  account becomes `passkey`.
So the recovery portal gains a new-owner-credential CHOICE. (This is a UX choice of
forward credential, distinct from the escrow mechanism, which stays fixed.)

### Why this is mostly-built already (verify, don't rebuild)
- Seal/open bundle (`recovery-escrow.ts`) is generic `secrets: Record<name,secret>`
  and ALREADY carries `podSeed` + `feedSignerPrivKey`. No crypto change.
- web3auth Kernel is built by the SAME `buildKernelFromPrivateKey` as passkey →
  identical ECDSA validator → `setupRecovery`/`recoverAccount` apply identically.
- web3auth POD seed IS persisted (keyed by the Web3Auth EOA, `_web3authPodAddress`),
  so `restorePodSeed(_getPodAddress())` succeeds at setup.
- `_ensureKernelForKind()` (auth-store ~L595) already dispatches passkey vs web3auth.

### Implementation

**1. SETUP side — `auth-store.svelte.ts` `setupAccountRecovery` (~L1207).**
- Gate: `if (_kind !== "passkey" && _kind !== "web3auth") throw` (was passkey-only L1212).
- Swap `await _ensureKernel()` (L1221) → `await _ensureKernelForKind()`.
- Update the passkey-only doc comment + error copy.
- Everything else already seals BOTH secrets (L1243-1245 fetch feedSigner + podSeed).
  DONE = a web3auth user can install guardian recovery; bundle has both secrets.

**2. UI — `AccountRecoverySetup.svelte`.**
- `isPasskey = auth.kind === "passkey"` (L33) → `canProtect = kind === "passkey" ||
  kind === "web3auth"`. Fix the status guard (L39) and the "You're already covered /
  backups are for passkey sign-ins" branch (L159) so web3auth sees the protect flow.
  Keep the "already covered" copy for TRUE self-custody kinds (web3/local/coinbase).
- Mounted in `AttendeeApp.svelte:51`.

**3. RECOVERY portal — `auth-store.svelte.ts` `recoverAccount` (~L1350).**
Currently HARDCODES `createPasskeyAccount()` (L1404) as the new owner and sets
`AUTH_KIND=passkey` (L1444). Parameterize the new-owner credential:
- Add a choice (arg / UI in `AccountRecoverPortal.svelte`): "email/social" | "passkey".
- email/social: run a Web3Auth login → get `{ address, privateKey }` (see
  `loginWithWeb3Auth` / `_extractKeyAndAddress` in `web3auth-account.ts`); new owner
  = that EOA. Build Kernel at preserved `target` via `buildKernelFromPrivateKey(
  newWeb3authPrivKey, { address: target })`. Set `AUTH_KIND=web3auth`,
  `POD_ADDRESS=newWeb3authEOA`; `storePodSeed(newWeb3authEOA, restoredPodSeed)`;
  `storeContentFeedSigner(target, feedSignerPrivKey)` (unchanged — keyed by parent).
  Also set `_web3authPrivateKey` / `_web3authPodAddress` in memory to match a normal
  web3auth login so subsequent signs work.
- passkey: existing path unchanged.
- `recoverAccount` (kernel-account.ts) already takes `newOwnerAddress` — kind-agnostic.

CRYPTO INVARIANT to preserve: POD identity derives from the SEED, not the EOA. On
recovery you restore the ORIGINAL seed and store it under the NEW POD address (new
EOA / new PRF-EOA). Feed signer restored VERBATIM under the preserved parent
(Kernel) address. Same as today's passkey path — just a different new-owner kind.

### Scope guard
- Do NOT touch the escrow crypto (`recovery-escrow.ts`) — generic already.
- Do NOT enable web3 wallets or local. Only passkey (existing) + web3auth (new setup)
  + recovery-target choice.
- Do NOT reopen sign-to-derive (Fable: settled).

### Verify before commit
- Setup: as a web3auth user, run "add a backup" → guardian SOC written + on-chain
  install; determinism self-check passes; bundle round-trips with BOTH secrets.
- Recovery (email target): from a cold device, backup wallet + account address →
  choose email → new Web3Auth login → Kernel owner rotates → POD decrypts historical
  data → feed signer resolves the user's OWN profile SOC (still `web3auth`, NOT
  passkey). Recovery (passkey target): existing behavior intact.
- Typecheck: `npx svelte-check --workspace apps/web --threshold error` (2 pre-existing
  esrap/@typescript-eslint/types errors are unrelated noise).

### Postage caveat (unchanged, Workstream B — separate design pass)
Guardian SOC + recovery status feeds land on the WoCo batch (`9ef3373b`, immutable
depth-20, TTL ~6d — needs top-up). Don't redesign batches here; just be aware the
setup writes hit that batch.
