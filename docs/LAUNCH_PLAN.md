# WoCo Launch Plan — single source of truth (sequenced)

Created 2026-06-21 by merging two in-flight handovers:
- `docs/CLIENT_FEED_SIGNER_HANDOVER.md` (Phase A done; Phase B + launch hardening)
- `docs/EMAIL_KERNELIZE_PLAN.md` (give email/Web3Auth users a Kernel)

This doc owns ORDER + dependencies. The two docs above own the detailed recipes.
Decision context: memory `project_auth_provider_decision`, `project_passkey_recovery`.

## Why these are sequenced (read before reordering)

Several steps are **identity / key flips that orphan owner-addressed Swarm feeds**.
All rely on the SAME "no real users yet" window. They must flip to the FINAL state
ONCE, in this order, or feeds get written then re-orphaned:
- Email-Kernelize changes the web3auth parent (EOA → Kernel addr); per-creator/profile
  feed TOPICS embed the parent address.
- Phase B Task 2 changes the feed SIGNER (platform key → client key) — orphans by design.
→ **Identity flip BEFORE feed-signer migration.** Both inside the no-users window.

LIVE Web3Auth testing is ALSO a shared gate: Web3Auth fails on localhost (hCaptcha) →
the frontend must be deployed first. So every "verify web3auth" step (email-Kernelize
P1/P2 verify + the go-live config) piggybacks on ONE frontend deploy.

---

## ORDERED TO-DO

### ✅ 0. Privacy fix — portability SOC AAD leak  — DONE (commit 9bbd1e6, typecheck-green; owner owes 1 cross-device re-test)
### 0. Privacy fix — portability SOC AAD leak  ✶ DO FIRST (small, ~2 files)
Source: CLIENT_FEED_SIGNER_HANDOVER.md "Security review gate" 🟡.
`preservedKernelAddress` is cleartext in the portability SOC. Pass `socOwnerAddress`
(not the real Kernel) as the envelope AAD; move `preservedKernelAddress` INSIDE the
sealed bundle (`secrets.preservedKernelAddress`); `PortabilityEnvelope` cleartext →
`{ v, envelope }`. Files: `packages/shared/src/swarm/soc.ts` + `recovery-portability.ts`.
Version-bump; back-fill rewrites on next login. Reuses audited HPKE/XChaCha unchanged.
Costs ONE cross-device re-test (owner). Independent of everything below; do first
because Phase B reuses this SOC/envelope machinery for PUBLIC content.

### ✅ 1. Email-Kernelize — BUILT + typecheck-green (P1 d591bbf, P2 e4c1900, P3 c4576e3). LIVE verify BLOCKED on step-3 deploy. Phase-B web3auth feed-signer source DECIDED (derive from Web3Auth key, own domain — see EMAIL_KERNELIZE_PLAN.md top).
### 1. Email-Kernelize — identity flip  (BEFORE Phase B)
Source: EMAIL_KERNELIZE_PLAN.md (full recipe). web3auth login → ZeroDev Kernel like
passkey; POD stays on raw Web3Auth key; parent becomes Kernel addr.
- P1 Kernelize identity → P2 gasless likes/follows → P3 teardown + payout parity.
- P1/P2 LIVE verify is BLOCKED until frontend deploy (step 3) — build+typecheck now,
  verify after deploy.
- **Resolve here for Phase B:** define the web3auth user's feed-signer source.
  Recommended: derive `feedSignerPrivKey` deterministically from the Web3Auth key under
  its OWN domain (recovery = re-login; no escrow). Does NOT contradict the passkey
  "feed signer ≠ POD seed" decision (different root). Confirm in step 2.

### 2. Phase B — client-owned content feeds  (AFTER identity flip)
Source: CLIENT_FEED_SIGNER_HANDOVER.md Task 2. Migrate events/profile/sites off the
platform `FEED_PRIVATE_KEY` onto client-owned signing. Single seam = `TODO(swarm-id)`
in `apps/server/src/lib/swarm/feeds.ts:195` (add optional `signer`, default platform
for back-compat; thread per-user signer from auth).
- Per-kind feed-signer source: passkey = PRF-sealed bundle slot (already reserved);
  **web3auth = derived from Web3Auth key (decided in step 1)**; web3 wallet = derive
  from a fixed signature OR keep platform-signed initially (decide, don't assume).
- Event directory / global list STAYS server-side for now (`project_event_directory_scaling`).
- GOTCHA: owner-addressed feeds → flipping the signer orphans old feeds. No users = OK,
  but it's a deliberate migration, not an in-place edit.

### 3. Web3Auth go-live config + frontend deploy  (shared gate)
Merged from BOTH docs. One frontend deploy unblocks all LIVE web3auth verification.
- Web3Auth dashboard: whitelist `gateway.woco-net.com` + `woco.eth.limo`; **disable
  Wallet Services** (keeps OTHER-namespace + `private_key` raw-key path working);
  **add aggregate verifier** so email/phone/Google → ONE identity (else different login
  = different key = different Kernel = "lost" account). Pin clientId + network (funds-
  critical determinism — see `web3auth-config.ts`).
- Deploy frontend (owner runs `npm run deploy`). NEVER test Web3Auth on localhost.
- Then run email-Kernelize P1/P2 LIVE verify (EMAIL_KERNELIZE_PLAN.md §Verify).

### 4. Launch hardening
- Per-account postage write cap on `POST /api/swarm/soc` (CLIENT_FEED_SIGNER_HANDOVER.md ⚪).
- Login polish for launch (3-login UX: passkey default, email fallback, native wallet).

---

## BACKLOG (post-launch / stretch — prepare, don't block launch)

- **EIP-7702 wallet sponsorship** — give web3 wallet users the same sponsored UX as
  passkey/email, same address (preserves `attester == parent` for likes). VERIFY 7702
  support on the exact ZeroDev chains (Arb Sepolia + mainnet target) + wallet signing
  BEFORE building. Own-gas fallback already accepted. Companion to EMAIL_KERNELIZE_PLAN.
- **Email-Kernelize P4** — sub-ENS + shop spend for email users (Kernel-generic; verify).
- **Privy** — DEFERRED + REVERSIBLE, no spike. Gated on concrete trigger (recurring
  Web3Auth outages, move to React, or Privy-specific features).

## FUTURE ARCHITECTURE (prepare-not-build)

- Per-user/cohort **postage-batch rotation + "trash bin"**: Swarm can't delete a chunk,
  but a batch can be left to expire; migrate kept data onto a fresh batch before the old
  one dies. Reliable delete = crypto-shredding (drop the encryption key); batch-expiry is
  the storage-reclaim backstop (identical chunks dedupe → expiry is best-effort).
  **Phase B (client-owned per-user feeds) is the prerequisite** that makes per-user batch
  migration possible.

## Conventions (apply throughout)
Client-first (server stamps/relays, never key custody); reuse audited crypto, never
hand-roll; trust = on-chain Kernel owner; Etherna-safe (inline SOC, read by computed
chunk address, never `/feeds`); NEVER test Web3Auth on localhost.
