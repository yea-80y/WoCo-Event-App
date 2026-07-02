# Handover — web3auth guardian escrow (Fable #3) + Vite refresh-logout fix (2026-07-02)

Branch `feat/feed-signer-recovery`. Continues `WEB3AUTH_GUARDIAN_ESCROW_HANDOVER_2026-07-02.md`
and the Fable lock-down plan in `FEED_SIGNER_REVIEW_2026-07-02.md` §"Lock-down plan".

Two workstreams touched this session. **Neither is committed yet.** Typecheck is green
(only the 2 pre-existing esrap/@typescript-eslint/types errors remain).

---

## A. Vite refresh-logout fix (dev-only) — VERIFY FIRST

### Symptom
web3auth (email/social) user refreshes the page → logged out. Re-login is silent (no
OTP). Console shows:
```
GET .../deps/chunk-XXXX.js?v=4ee5659e  504 (Outdated Optimize Dep)
Failed to fetch dynamically imported module: .../deps/english.json-VA5I2DTL.js
  at init @ @web3auth_modal.js  →  _getInstance @ web3auth-account.ts:39
  →  init @ auth-store.svelte.ts:709
```

### Root cause (NOT a code bug, NOT rehydration)
`@web3auth/modal` `loginModal.js` does dynamic `import('./i18n/english.json.js')` (+ other
locales). We also load the modal via dynamic `import("@web3auth/modal")` in
`web3auth-account.ts:_getInstance`. So Vite's dep-optimizer discovers the modal LATE and
bundles it lazily; the locale import then triggers a SECOND optimize pass that re-hashes
the browser `?v=` query; the already-loaded modal requests the stale chunk → `504 Outdated
Optimize Dep` → `w.init()` throws → `restoreWeb3AuthSession()` catches it → auth-store
logs out. Explicit login later hits a re-optimized (consistent) state → works, and the
Web3Auth server session is still valid → no OTP. Hence the exact symptom.

Production is UNAFFECTED: `optimizeDeps` is dev-only; the rollup build resolves these
imports at build time.

### Fix applied
`apps/web/vite.config.ts` → `optimizeDeps.include: ['@web3auth/modal']`. Forces the modal
(and its locale chunks) into ONE eager optimize pass at server start → single consistent
hash → no desync.

### VERIFY
1. Stop dev server. `rm -rf node_modules/.vite` (config change should auto-invalidate, but
   be sure). Restart `npm run dev:web`. **Hard-reload** the browser (Ctrl+Shift+R) — a
   normal reload can serve the stale module graph and mask the fix.
2. Log in as web3auth, refresh several times. Expected: stays logged in; no 504; the
   `[web3auth] restore:` debug line shows `connected:true, hasProvider:true`.

### If it STILL 504s after a clean restart + hard reload (fallback)
Swap `include` → `exclude: ['@web3auth/modal']` (serves the modal as raw ESM source, no
optimizer hashing at all). Higher risk of CJS sub-dep interop noise, so `include` is
preferred; only fall back if needed. If exclude also misbehaves, pin the locale chunks via
`optimizeDeps.include: ['@web3auth/modal', '@web3auth/modal > i18next']` and clear `.vite`.

---

## B. Guardian escrow for web3auth (Fable lock-down #3) — implemented, needs live test

### What shipped (5 edits, all in `apps/web/src`)
1. `auth/auth-store.svelte.ts` `setupAccountRecovery` — gate now `passkey | web3auth`;
   `_ensureKernel()` → `_ensureKernelForKind()`. Already seals BOTH `podSeed` +
   `feedSignerPrivKey` generically (no crypto change).
2. `auth/auth-store.svelte.ts` `recoverAndRekey` — new arg
   `newOwnerKind: "passkey" | "web3auth"` (default passkey). web3auth branch runs
   `loginWithWeb3Auth()` for the new Kernel owner; sets `AUTH_KIND=web3auth`,
   `POD_ADDRESS=new EOA`, `_web3authPrivateKey/_web3authPodAddress`, binding. Seed +
   feed-signer restore paths unchanged (restore original seed under new POD address; feed
   signer verbatim under preserved parent).
3. `components/recovery/AccountRecoverPortal.svelte` — new-owner radio (email default /
   passkey), conditional copy, passes `newOwnerKind`.
4. `components/recovery/AccountRecoverySetup.svelte` — `canProtect = passkey || web3auth`;
   status-check effect + "already covered" branch updated; kind-agnostic prompt copy.
5. Copy tidy-ups.

### CRYPTO GAP the prior handover MISSED — found + fixed here
`_ensureKernelForWeb3Auth` and `loginWeb3Auth` had NO `RECOVERED_KERNEL_BINDING` support
(only the passkey paths did). Without it a recovered web3auth account works in-memory right
after the ceremony but THROWS "Kernel address mismatch (web3auth)" on the next reload — the
Kernel gets rebuilt at the new key's counterfactual, not the preserved `target`. Fixed by
threading the binding override (+ an on-chain stale-owner guard in `loginWeb3Auth`),
mirroring `_ensureKernel`/`loginPasskey`. `_getContentFeedSigner` step (1) already
guarantees the escrow-restored feed signer wins over re-derivation.

### Known residual limitations (documented, accepted for now)
- web3auth-recovered accounts get NO cross-device portability envelope (that channel is
  PRF-sealed = passkey-only). Re-opening on a 3rd device = re-run the portal (web3auth key
  + guardian escrow are reproducible, so it always works).
- DIFFERENT-email recovery THEN logout: the on-device feed-signer blob is wiped on logout,
  so the next login re-derives from the NEW key → divergent from the escrow-restored
  original → orphans feeds. SAME-email recovery is fully self-healing (common case).
- email-backup + email-new-owner may collide on the Web3Auth singleton instance — untested
  edge; a web3auth PRIMARY user can't pick email as backup anyway (guarded).

### TEST PLAN (do after the Vite fix verifies)
1. **Setup** — as web3auth user, "add a backup" → crypto wallet → guardian SOC written +
   on-chain recovery route installed + determinism self-check passes.
2. **Recover, email target** — cold device: connect backup + account address → choose
   Email/social → new Web3Auth login → owner rotates → **reload the page** → POD decrypts
   history, own profile/avatar resolves, account still `web3auth`. (The reload is the bit
   the binding fix protects.)
3. **Recover, passkey target** — same, choose Passkey → original passkey path unchanged.
4. All green → **commit** the branch.

---

## C. What's genuinely next (Sonnet)
Remaining Fable lock-down items, both Sonnet-able:
- **#4 one-ceremony eager key setup** — collapse POD + feed-signer establishment into ONE
  confirm at account creation instead of lazily mid-publish (F3 in the review). Opus should
  spec the ceremony contract first (short), then Sonnet implements.
- **#5 guardian-setup warning copy** — anti-phishing copy on the backup step (F4).

## D. Cross-app / cross-platform passkey — SEPARATE future phase (NOT this work)
"Same account usable across platforms" = WebAuthn RP-ID / origin-binding (passkeys are
bound to a domain). Needs Related Origin Requests or a portable-key model — a distinct
design piece, related to the Verifiable Signer Enclave direction. NOT a prerequisite for
anything above. Park as its own phase; scope separately after launch lock-down.
