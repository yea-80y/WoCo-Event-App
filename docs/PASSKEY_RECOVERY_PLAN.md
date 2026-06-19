# Passkey Account Recovery — Design / Build Plan

**Status:** Phase 0 spike DONE + PASSING (2026-06-17). **Phase 1 entry verified + MVP landed
(2026-06-17):** the deployed-account caller-hook flow is PROVEN end-to-end on Arb Sepolia and
the `setupRecovery` / `recoverAccount` / `sweepToExternal` primitives are implemented behind
the `KernelSudoValidator` seam (typechecks clean; recovery-portal UX still TODO). The open
deployed-account design decision is RESOLVED — see "Phase 1 progress" + "Phase 0 results".
**Owner intent (2026-06-17):** let ZeroDev Kernel passkey accounts safely *hold/receive
funds* by adding a recovery path, instead of the current blanket "passkey accounts can't
receive funds" rule.

---

## PHASE 1 PROGRESS (2026-06-17)

**✅ Step 1 — caller-hook flow VERIFIED on a DEPLOYED Arb Sepolia account.** New spike
`apps/web/scripts/recovery-spike-caller-hook.ts` = **PASS**: deploy a sudo-only Kernel →
sudo-signed `installModule(type=3, recoveryAction, initData)` installs the recovery action +
caller hook pinning a guardian account → a SEPARATE guardian account (itself a weighted-ECDSA
Kernel, M-of-N seam) *calls* `target.doRecovery(validator, newOwner)` → **same address
preserved, new signer controls, OLD KEY DEAD**. Recovery tx `0x17f062219243521acde9545fa7af1851a8bbbd51fab9a23a286ed8869d9d2f3f`,
target `0x8DEF5755D288f452837E3337b5799C19718a1922`. This is the realistic WoCo path (most
passkey Kernels are already deployed) and clears the AA23 `InvalidValidator` dead-end from
`recovery-spike-deployed.ts`. Install init-data shape verified verbatim against
zerodev-examples `guardians/recovery_call.ts`.

**✅ Step 2 — MVP primitives implemented** in `apps/web/src/lib/auth/kernel-account.ts`
(behind the `KernelSudoValidator` seam, client-first, paymaster-sponsored):
- `deriveGuardianAddress(config)` — deterministic guardian-account address from a
  `GuardianConfig` (signers+weights+threshold); the value pinned in the caller hook.
- `setupRecovery(builtKernel, guardianAddress)` — one sudo (passkey) userOp; installs the
  recovery action + caller hook. Deploys the Kernel if counterfactual.
- `recoverAccount({ targetAddress, guardianConfig, guardianSigners, newOwnerAddress })` —
  guardian account calls `doRecovery`, rotating sudo to the new owner.
- `sweepToExternal(builtKernel, { to, erc20Tokens? })` — escape hatch: sudo-signed sweep of
  native ETH + listed ERC-20s to a self-custodied address (funds never structurally trapped).

**Remaining for Phase 1 → 2:** recovery-portal UX (guardian connect + co-sign), setup UI,
funds-policy wiring in `TicketSeriesEditor`, timelock+cancel, 2nd-passkey guardian, and
**escrow-grade test/review before enabling organiser-payout-to-passkey.** Counterfactual
accounts MAY use the simpler baked-in Path A (`recovery-spike.ts`).

---

## PHASE 1 PROGRESS (2026-06-19) — escrow crypto + setup UI

**✅ §11.6 step 1 — POD escrow crypto shipped + spike-verified** (commit `f9d48f2`):
- `packages/shared/src/recovery/types.ts` — `RecoveryEnvelope` (ciphertext-only wire type)
  + `RECOVERY_ENVELOPE_VERSION`. `RECOVERY_ENC_DOMAIN/TYPES/NONCE` (fresh salt) in
  `packages/shared/src/auth/`.
- `apps/web/src/lib/auth/recovery-escrow.ts` — generic versioned `RecoveryBundle`
  (`{version, secrets}`; v1 = `{ podSeed }`). **Crypto stack changed from the §11.3 plan:
  HPKE / RFC 9180 (`@hpke/core`, DHKEM-X25519 + HKDF-SHA256 + AES-256-GCM) wraps the DEK;
  `@noble/ciphers` XChaCha20-Poly1305 encrypts the bundle, AAD-bound to the Kernel address.**
  Rationale: `libsodium-wrappers@0.7.15` ships broken ESM (imports a missing `./libsodium.mjs`)
  that fails Node + Vite — unacceptable in a funds-critical path. HPKE is a STRONGER
  "don't hand-roll ECIES" answer (an IETF standard with composed `seal`/`open`), clean ESM,
  and noble is already the crypto family under viem/ZeroDev. Guardian X25519 key derived
  deterministically from a fixed EIP-712 signature (same trick as `requestPodIdentity`).
- `apps/web/scripts/recovery-escrow-spike.ts` = **PASS** (pure crypto, no chain): round-trip,
  deterministic re-derivation, AAD-transplant + wrong-guardian + ciphertext-tamper all rejected.
- **Security review: no HIGH/MEDIUM findings.** Two notes: (1) recovery correctness depends on
  deterministic ECDSA from the backup (same assumption POD already relies on — add a setup-time
  round-trip self-check); (2) 1-of-1 escrow confidentiality == backup-EOA key strength (by design,
  §11.4 — surface it to the user). Both are availability/disclosure, not exploitable flaws.

**✅ Server escrow persistence:** `POST /api/recovery/escrow` (auth; envelope AEAD-bound +
required to match the verified Kernel parent → can't overwrite a victim's blob) + public
`GET /api/recovery/escrow/:kernelAddress` (locked-out user can't auth; ciphertext is safe to
read). Feed `woco/recovery/{kernelAddress}`, ciphertext only (non-custodial). Files:
`apps/server/src/{routes/recovery.ts, lib/recovery/service.ts}`, topic in `lib/swarm/topics.ts`,
client `apps/web/src/lib/api/recovery.ts`.

**✅ Setup UI ("Protect your account") — DONE, all crypto hidden** (route `#/protect`,
attendee surface): `apps/web/src/lib/components/recovery/AccountRecoverySetup.svelte`. One
"add a backup" action → `auth.setupAccountRecovery(backup)` (new wrapper) installs the on-chain
recovery route + escrows the POD seed in one ceremony. Backup connector
`apps/web/src/lib/wallet/backup-signer.ts` (`connectBackupWallet`, injected wallet for now).

**🟡 Recovery portal ("Recover my account") — UI to verify-stage** (route `#/recover`):
`AccountRecoverPortal.svelte`. Connect backup + confirm a protected account exists (via
`fetchRecoveryEnvelope`) are LIVE; the final irreversible step (on-chain signer rotation +
re-key to a fresh passkey + restoring the POD seed) is intentionally gated ("coming soon")
**pending in-browser escrow-grade verification** — that ceremony is irreversible and must be
proven live before it touches funds.

### Backup-factor decision (2026-06-19): EMAIL-FIRST via Para (the easy non-technical path)
The backup is just "an account with a stable address that can sign" — nothing is MetaMask-specific.
**Para (email) is the default backup for non-technical users**, plus social / 2nd-passkey, combinable
as M-of-N (the weighted-ECDSA guardian already scales there). Para satisfies both roles: stable
address (funds-rotation signer) + deterministic EIP-712 sig (escrow key — Para already backs POD
identity in prod, so determinism holds; **confirm in the browser-verification pass**). Boundary: the
backup must be a wallet the USER controls (non-custodial); WoCo may be ONE-of-N, never unilateral
(model 3 / custody line). NOT YET BUILT — `connectBackupWallet` must become a chooser (Email via Para
/ another wallet); both resolve the same `{ address, signTypedData }` seam. `ParaLogin.svelte` can't be
reused (it calls `auth.loginPara`, hijacking the session) — a backup must not change the logged-in
identity; build a backup-specific email→iframe flow + `createParaSigner`. Batch this WITH the portal's
irreversible ceremony in the browser-verified pass (both hinge on the same gate).

---

## PHASE 1 PROGRESS (2026-06-19b) — irreversible portal ceremony WIRED (injected backup)

**Decision shift:** Para is likely being PHASED OUT for another email provider, so we did
NOT build Para-specific viem wiring (would be ripped out). Instead the backup abstraction is
now **provider-agnostic** and the proven **injected-wallet** path is wired end to end; any
future email provider drops in by supplying a viem signer.

**Key finding (changes the recorded `{address, signTypedData}` seam):** `recoverAccount`
needs the backup to sign the **guardian userOp** as a viem/EIP-1193 `Signer`
(`OneOf<EIP1193Provider | WalletClient | LocalAccount | SmartAccount>`) — MORE than the
typed-data signer the escrow-key derivation uses. Injected wallets give this for free (viem
`WalletClient`, no new dep). Para would need `@getpara/viem-v2-integration@3.3.0` (a MAJOR
ahead of installed Para 2.12.0 — compat risk) → deferred with Para.

**✅ Shipped this session (commits `b1d0615`, `6d84670`, `83f09d4`; typecheck clean):**
- `buildKernelFromPrivateKey(pk, { address })` — CREATE2 address override so a fresh passkey
  controls the SAME deployed Kernel after rotation. Proven by caller-hook spike step [4].
- `storePodSeed(parent, seed)` in pod-identity.ts — re-store the escrow-recovered ed25519
  seed under the recovered identity (POD_ADDRESS AAD = new passkey PRF-EOA).
- `BackupWallet` (backup-signer.ts) now provider-agnostic: `{ address, signTypedData,
  getGuardianSigner?, recoveryReady }`. Injected → viem `WalletClient` guardian signer,
  `recoveryReady: true`. A backup that can derive the escrow key but NOT sign the guardian
  userOp is refused at setup (no trapped accounts).
- `auth.recoverAndRekey({ backup, targetAddress })` — full irreversible ceremony: mint fresh
  passkey → guardian `doRecovery` (rotate sudo to it) → rebuild Kernel at OLD address →
  decrypt escrow → `storePodSeed` under new identity → log in. Ordering fix: clear stale auth
  (which calls `clearPodIdentity`) BEFORE storing the recovered seed.
- `setupAccountRecovery` now: refuses non-`recoveryReady` backups; runs a **determinism
  round-trip self-check** (re-derive escrow key from a 2nd signature, confirm the bundle
  opens to the exact seed) BEFORE the irreversible on-chain install (sec-review note #1). Costs
  a second backup signature at setup.
- Portal `AccountRecoverPortal.svelte` — gated button replaced with the live flow: explicit
  irreversibility warning → `recoverAndRekey` → "Account recovered" success → into app.

**🔴 STILL REQUIRED before this is safe for funds / before relaxing the organiser payout gate
(`TicketSeriesEditor` `hasNativeWallet`):** the owner's OWN live end-to-end browser test on a
throwaway Arb Sepolia account — set up recovery with an injected backup, then recover on a
"fresh" device (clear IndexedDB), confirm: same Kernel address, new passkey controls it, old
passkey dead, tickets/dashboard decrypt (POD seed restored). The on-chain rotation and escrow
round-trip are spike-proven *individually*; the full wired path is not browser-verified.

**Not built (next):** funds-policy wiring in `TicketSeriesEditor` (tier relaxation once
verified), timelock + cancel window, social M-of-N (VSS), the replacement email-provider
backup branch, feed-signer secret folded into the bundle when client-side feed signing lands.

---

## PHASE 0 RESULTS (verified on Arb Sepolia 421614, sponsored, 2026-06-17)

**Package (verified vs `zerodevapp/zerodev-examples` for Kernel v3.1):**
`@zerodev/weighted-ecdsa-validator@5.4.4` — peers `viem ^2.28` (have 2.51.3) + `@zerodev/sdk
^5.4` (have 5.5.10). Installed in `apps/web`. Exports `createWeightedECDSAValidator`,
`getRecoveryAction`, `getValidatorAddress`, `getUpdateConfigCall`, `getCurrentSigners`.

**Mechanism (recovery.ts design — the primitive, PROVEN):** guardian = weighted-ECDSA
validator mounted as `plugins.regular`, plus `plugins.action: getRecoveryAction("0.7")`. A
guardian-signed userOp calls `doRecovery(ecdsaValidatorAddr, newOwnerEnableData)` which
rotates the **sudo ECDSA validator's owner** to a new key. Guardian can ONLY call doRecovery
(scoped by the action), never spend.

**Recovery action is a cross-chain singleton, live on Arb Sepolia:**
`0xe884C2868CC82c16177eC73a93f7D9E6F3A5DC6E`, selector `0xac39fd0f`. Same address in BOTH
example designs. Confirmed working — our recovery userOp executed against it on 421614.

**Spike `apps/web/scripts/recovery-spike.ts` — PASS.** Counterfactual account, guardian baked
in at creation. Result: rotation works · Kernel address preserved (0xE55dC51a…75A4dD before
and after) · new signer controls account · OLD signer DEAD ("Signature … invalid").

**KEY FINDING — address derives from the SUDO ROOT VALIDATOR ONLY.** Adding the guardian
(regular) + recovery action does NOT change the CREATE2 address (verified: identical address
sudo-only vs sudo+guardian+action). So existing accounts keep their address whether the
guardian is baked in (counterfactual) or installed post-deploy. Recovery is non-destructive
to identity/funds. ✅

**DECISION (owner, 2026-06-17): Path A — weighted-ECDSA validator.** It IS a multisig (signer
set + weights + threshold): "backup EOA" = 1 signer @ threshold 1; "social 2-of-3" = same
mechanism, more signers — so it scales to the owner's multi-method / social-recovery vision
with NO rewrite. v1 guardian = a single backup EOA (1-of-1). Path B (caller-hook) is ~1-of-N
and would need re-architecting for M-of-N → rejected as the base.

**ALREADY-DEPLOYED accounts (the realistic WoCo case) — use the CALLER-HOOK model, NOT
install-weighted-validator-as-the-target's-own-validator.** Most passkey Kernels are
`{ sudo: ecdsaValidator }` only and already deployed (sub-ENS / like deploys them).
`account.encodeModuleInstallCallData()` is EP0.6-only. I tried the v0.7 `installValidations`
(`pluginMigrations`) route to bolt a weighted guardian validator onto a deployed account and
use it as that account's own recovery validator. Findings (`recovery-spike-deployed.ts`, Arb
Sepolia):
- ✓ deploy sudo-only Kernel; ✓ install weighted guardian (sudo-signed userOp lands);
  `getCurrentSigners` confirms the signer config IS stored; `isInitialized(account)` = true.
- ✓ install the `doRecovery` executor ROUTE — REQUIRED FIX vs the SDK migration helper
  `getValidatorPluginInstallModuleData`, which truncates `selectorData` to the 4-byte selector
  → no executor route → `doRecovery` reverts `0x7352d91c` (= `InvalidSelector()`). Hand-build
  `selectorData = selector(4) + executor(0xe884…,20) + actionHook(20) + abi(selectorInitData=
  0xFF delegatecall, hookInitData)` (the SDK's own `getEncodedPluginsData` format) → route OK.
- ✗ guardian recovery userOp then fails validation: **AA23 `0x682a6e7c` = `InvalidValidator()`**
  even though the validator is initialized and the SDK selects use-mode. Conclusion: a
  post-deploy-installed weighted validator validating the target's OWN recovery userOp is not a
  supported Kernel v3.1 flow. (It only works baked-in at genesis — `recovery-spike.ts` PASS.)

**→ For deployed accounts adopt ZeroDev's actual deployed-recovery flow (`recovery_call.ts`):**
install the recovery action as a **fallback (module type 3)** + a **caller hook** that holds
the permitted guardian address(es); recovery is performed by a SEPARATE guardian account that
**calls** `target.doRecovery(newValidator, enableData)`. Both required singletons are **LIVE on
Arb Sepolia**: recovery action `0xe884C2868CC82c16177eC73a93f7D9E6F3A5DC6E` and caller hook
`0x990a9FC8189D96d59E3cE98bd87F42135a24a30E`. **M-of-N is preserved** by making the guardian
account itself a weighted-ECDSA multisig (backup EOA = 1-of-1; social = N signers, M threshold)
— so Path A's multisig value survives, just relocated to the guardian account.

**Phase 1 entry point:** verify the `recovery_call.ts` caller-hook flow end-to-end on a
*deployed* Arb Sepolia account (install fallback+hook via sudo userOp → guardian account calls
doRecovery → address preserved, old key dead), with the guardian as a weighted-ECDSA Kernel for
the M-of-N seam. Counterfactual accounts can still use the simpler baked-in Path A
(`recovery-spike.ts`). The rotation primitive + address-preservation are fully PROVEN.

Spike artifacts: `apps/web/scripts/recovery-spike.ts` (PASS — counterfactual baked-in),
`recovery-spike-deployed.ts` (deployed install-as-validator route: install OK, recovery
`InvalidValidator` — documents why we pivot to the caller-hook model).

---

## 1. Why this exists (the decision context)

The "passkeys shouldn't hold funds" rule conflated two different properties:

- **Signing security** — can an attacker misuse the key? Kernel already improved this
  (scoped gasless session keys, root never exposed to dapps, call policies).
- **Recoverability** — if the user loses the passkey, can they still get their funds out?
  **Kernel does nothing for this today.**

Our Kernel root is a **single** sudo validator: ECDSA over the PRF-derived secp256k1 key
(`signerToEcdsaValidator`, `plugins: { sudo: ecdsaValidator }`, `KERNEL_V3_1`). One key,
no guardian. Lose / revoke / fail-to-reproduce the passkey PRF → the account is
uncontrollable → **funds locked forever.**

A synced platform passkey (e.g. Google) gives cross-device **availability**, but **not
recovery**: WebAuthn does not reliably expose whether a credential is backed up, and a lost
or revoked Google credential has no rescue path today. This plan adds that rescue path.

**The rule to adopt:** "passkey accounts can hold funds" is a capability we *unlock by
shipping recovery* — not a default we flip because the signer got fancier. Until recovery +
a sweep escape-hatch ship, keep organiser crypto payouts requiring an external wallet
(current behaviour in `TicketSeriesEditor` — `hasNativeWallet` / `cryptoRecipientAddress`).

---

## 2. Goals & non-goals

**Goals**
- A user who loses their passkey can regain control of the **same Kernel address** (and its
  funds) via a recovery factor they control.
- Recovery factors are **non-custodial** — WoCo must not become able to move user funds
  (regulatory line: a WoCo-held guardian key would make us a custodian → MTL/KYC exposure).
- Daily UX is unchanged: passkey-only signing for normal operations.
- Always provide a **"sweep to external address"** action so funds are never structurally
  trapped even before/independent of recovery.

**Non-goals (call out explicitly)**
- **POD identity recovery — NOW IN SCOPE (design in §11).** Earlier this was deferred. The
  ed25519 POD identity (ticket signing / encryption) is derived from the **raw PRF key**, not
  the Kernel (invariant #1), so a Kernel signer rotation restores funds but NOT the original
  POD identity. Owner pulled this in scope (2026-06-18) — see §11 for the escrow + on-chain
  authority design and the auditor assessment.
- Not changing the daily signing model (no forced multisig on every op).
- Not building assisted/custodial recovery in v1.

---

## 3. ZeroDev tooling (VERIFY exact packages + Kernel v3.1 support at build)

ZeroDev/Kernel provides the needed primitives — confirm current package names/versions
against ZeroDev docs before coding (do **not** trust these names blindly):

- **Weighted ECDSA validator** (`@zerodev/weighted-ecdsa-validator`-style): N owners with
  weights + threshold. Basis for a multi-signer / guardian set.
- **Guardian-based recovery / signer rotation**: a guardian validator authorised ONLY to
  execute a recovery action that **changes the Kernel's sudo (root) validator** to a new
  signer the user controls. Guardians can rotate the signer; they **cannot** spend.
- **Kernel `changeSudoValidator` / root-validator swap** behind our existing
  `KernelSudoValidator` seam (invariant #4 was designed for exactly this).
- **Paymaster sponsorship** for the recovery userOp (the locked-out user has no gas; the
  recovery op is guardian-signed and must be sponsored — we already run a ZeroDev paymaster).

⚠️ Build-time verification items: exact package + version, Kernel v3.1 compatibility of the
recovery executor, whether rotation is `changeSudoValidator` vs install/uninstall validator,
and gas/sponsorship of the recovery op.

---

## 4. Recommended design — guardian-gated signer rotation (Option B)

Keep **ECDSA-over-PRF as the daily sudo signer** (UX unchanged). Add a **guardian validator**
that is scoped to a single action: rotate the sudo signer to a new key. Guardians cannot
move funds — only reset the signer. On recovery the Kernel **address is preserved**, so funds
and history survive.

```
Daily:     passkey PRF  ──sudo──▶  Kernel  (sign userOps, spend)   [unchanged]
Recovery:  guardian(s)  ──recovery action──▶  rotate sudo → new key the user controls
```

**Alternative — Option A (weighted multisig as the root).** Make the root a weighted-ECDSA
of [PRF key + recovery key(s)] with a threshold. Simpler to install, but it either changes
daily signing (threshold > 1) or gives a co-signer standing spend power (threshold = 1).
Prefer Option B; mention A as a fallback if the recovery executor proves incompatible with
Kernel v3.1.

### Recovery models (same mechanism — weighted-ECDSA guardian set — different guardians/threshold)

All of the below are **one guardian validator with N owners + an M-of-N threshold**, scoped
to the rotation action only. The *security/trust posture is entirely set by who the guardians
are and what M is.* Let the user choose a model at setup; support more than one over time.

1. **Self-custody (v1 default).** Guardian set = the user's own factors: a backup EOA
   (MetaMask) and/or a second passkey on another authenticator. Threshold 1-of-N. Simplest,
   zero third-party trust. Ship this first.

2. **Social recovery (M-of-N guardians).** Guardians = people/devices the user trusts —
   friends' wallets, a hardware key, a family member's account, a second device. Threshold
   **M-of-N** (e.g. 2-of-3) so no single guardian can act alone, and losing one guardian
   doesn't lock recovery. This is the strongest *non-custodial* option and the one worth
   leaning into — it degrades gracefully and needs no WoCo trust.
   - UX: a guardian-management screen (add/remove/replace, show threshold), and a recovery
     portal where guardians co-sign the rotation. Each guardian add/remove is a sudo-signed
     userOp.
   - Abuse bound: M-of-N + the timelock/cancel window means a malicious guardian minority
     can't hijack the account, and the live passkey can veto during the delay.

3. **Assisted / "custodian" recovery (WoCo as ONE guardian in a threshold — never unilateral).**
   Appealing for users with no crypto-savvy friends: WoCo participates as **one-of-N** in an
   M-of-N set (e.g. user-factor + WoCo + one more, 2-of-3), so WoCo **can help but can never
   move funds or recover alone**. This keeps it meaningfully non-custodial.
   - ⚠️ **Regulatory line:** the moment WoCo can *unilaterally* control or move user funds we
     are a **custodian** → money-transmitter / KYC / safeguarding obligations. A one-of-N
     threshold role where WoCo cannot act alone is the safe shape, but get explicit legal
     sign-off before shipping any WoCo-held guardian — and design the keys so WoCo's guardian
     is operationally isolated (HSM/separate signer), and ideally the user must also approve
     (so WoCo + attacker ≠ enough).
   - Recommend: ship models 1–2 first; treat model 3 as a later, legally-reviewed opt-in.

4. **Email/Para key as a guardian** — convenient middle ground (a guardian the user controls
   via Para's MPC). Fits as one factor inside model 2's set; note Para→Privy migration keeps
   the address stable.

### Optional hardening
- **Timelock + cancel window** on rotation (guardian initiates → N-hour delay → user with the
  live passkey can cancel) to blunt a malicious/compromised guardian.
- Re-key flow on recovery: user registers a **fresh** passkey, derives a new PRF key, and the
  rotation points sudo at it (so the lost credential is fully retired).

---

## 5. Flows

**Setup (opt-in "Set up account recovery" step):**
1. User (already on a passkey Kernel) chooses a recovery factor (connect backup EOA / register
   2nd passkey).
2. Install the guardian validator with that factor as guardian (one sudo-signed userOp,
   sponsored). Account deploys here if still counterfactual.
3. Persist a *hint* ("recovery configured") for UI; truth is on-chain.

**Daily:** unchanged — passkey PRF signs.

**Recovery (lost passkey):**
1. User proves control of a guardian factor.
2. Guardian submits the **recovery userOp** (sponsored) → rotates sudo to a new
   user-controlled key (freshly-registered passkey PRF key, or the guardian EOA).
3. (If timelock) wait window / allow cancel by the live passkey.
4. Same Kernel address, funds intact, new signer in control.

**Sweep escape-hatch (independent of recovery):** a "Withdraw all to external address" action
so funds can always be moved out to a self-custodied address while the passkey still works.

---

## 6. Server / client split (client-first)

- Validator install + recovery rotation are **client-side userOps** (sponsored). No server
  secret needed → aligns with `feedback_client_first_architecture`.
- Server's only possible role: an optional, non-authoritative "this account has recovery
  configured" hint for UI, and paymaster sponsorship policy for the recovery op. Truth is the
  on-chain validator set — rebuildable from chain.
- A dedicated **recovery portal route** (client page) where a guardian initiates rotation —
  this is the heaviest UX surface and the main test target.

---

## 7. What this unlocks — funds policy (ties to the Stripe/recipient work)

Gate the relaxation on stakes, not on "Kernel is secure":

- **Attendee low-value (tickets, dust):** can relax now with a "back up your passkey" nudge —
  tickets are POD-signed credentials, not bearer funds.
- **Organiser revenue (real money):** keep requiring an external payout wallet **until**
  recovery MVP **and** the sweep action are both shipped. Then allow passkey Kernel as a
  payout recipient *for accounts that have recovery configured*. Surface recovery state in
  `TicketSeriesEditor` where `cryptoRecipientAddress` is decided.

---

## 8. Effort & phasing

- **Phase 0 — spike (0.5–1d):** verify ZeroDev recovery package + Kernel v3.1 rotation on
  Arb Sepolia with a throwaway account (install guardian → rotate sudo → confirm address
  preserved, old key dead).
- **Phase 1 — MVP (3–5d):** backup-EOA guardian, setup userOp, recovery rotation, sweep
  action, dev-tested. Behind the `KernelSudoValidator` seam.
- **Phase 2 — productionise (1.5–3wk):** timelock + cancel, 2nd-passkey guardian, recovery
  portal UX, cross-device PRF reproduction testing, funds-policy wiring, review pass.

Code volume is moderate; the cost is **blast radius** — this is funds-critical, so treat
tests/review like the escrow audit gate. Don't enable organiser-payout-to-passkey until
Phase 1 (+ sweep) lands.

---

## 9. Open questions to resolve at build
- Exact ZeroDev recovery package, version, and Kernel v3.1 compatibility (rotate via
  `changeSudoValidator` vs install/uninstall validator?).
- Rotation target: re-register passkey (new PRF key) vs rotate to guardian EOA — support both?
- Timelock duration + cancel mechanics.
- Guardian set for v1 (backup EOA only, or also 2nd passkey?).
- Paymaster policy for the recovery op (sponsor a guardian-signed rotation — abuse bounds?).
- PRF determinism across platforms for the *new* passkey on re-key (test).

---

## 10. Integration points (current code)
- `apps/web/src/lib/auth/kernel-account.ts` — `KernelSudoValidator` seam, `buildKernel`,
  validator wiring (where the guardian validator + rotation action slot in).
- `apps/web/src/lib/auth/passkey-account.ts` — PRF key derivation (re-key on recovery).
- `apps/web/src/lib/creator/events/TicketSeriesEditor.svelte` — `hasNativeWallet` /
  `cryptoRecipientAddress` policy (relax once recovery ships).
- New: recovery setup UI + recovery portal route; optional `sweep` action.
- Plan refs: `docs/ZERODEV_PASSKEY_INTEGRATION_PLAN.md` (invariants),
  `project_signing_role_architecture`, `project_zerodev_passkey`.

---

## 11. POD identity & client-secret recovery (escrow + on-chain authority) — DESIGN

**Status:** design (2026-06-18), not built. Pulled in scope after the Phase-1 spike confirmed
funds recovery works but does NOT restore POD identity. Funds-critical → escrow-grade review.

### 11.1 Why a rotated Kernel cannot re-derive the same ed25519 key (settled)
POD = `ed25519 = f(deterministic EIP-712 signature by a secret key)` (`pod-identity.ts`:
`keccak256(getBytes(sig))` → ed25519 seed, fixed nonce). Determinism means **the identity IS
the secret**. For a passkey account the signer is the **raw PRF-EOA** (not the Kernel —
smart-account sigs aren't deterministic; invariant #1). After recovery the only thing
unchanged is the **Kernel address, which is PUBLIC** — and you cannot deterministically derive
a *secret* from a *public* value. The secret that changed (the PRF key) is the one that's gone.
**Conclusion: "same key, re-derived" is impossible.** The key can only be RECOVERED (escrow) or
made-not-to-matter (rotation + on-chain authority). Not a limitation we can engineer around.

### 11.2 POD has two jobs that recover differently
- **Signing** tickets/editions — **rotatable.** Anchor verification to the stable **Kernel
  address** + an on-chain (or attested) **POD-key authorization log** ("Kernel K authorizes POD
  pubkey X"). After recovery the recovered Kernel authorizes a NEW POD pubkey; verifiers accept
  a ticket signed by X iff the chain says K authorized X. Old editions stay valid; a different
  key each rotation is FINE — the Kernel is the durable identity, the ed25519 key is a
  rotatable credential. **No escrow needed.** Hang off WoCoEventV2's on-chain anchor.
- **Decryption** (organiser dashboard decrypts claim data encrypted to the POD-derived key) —
  **NOT rotatable.** Existing ciphertext only opens with the *original* private key; on-chain
  authority does nothing for data at rest. **Requires the identical key back → escrow.**

### 11.3 Escrow design (the part that needs the actual key back)
Encrypted **recovery bundle** = `{ podSeed, feedSignerPrivKey, … }`, recovered in the SAME
ceremony as the Kernel signer rotation (one threshold, one ceremony). Construction (the parts
that make it cryptographically sound):
- **Envelope:** random per-bundle DEK (XChaCha20-Poly1305 / AES-256-GCM) encrypts the bundle;
  only the DEK is wrapped to recovery factors.
- **Separate encryption keys from signing keys.** Do NOT ECIES to a guardian's secp256k1
  *signing* key (footgun-prone in JS). Each guardian derives a dedicated **X25519** encryption
  keypair (deterministically, like POD) and publishes the pubkey; wrap the DEK with libsodium
  `crypto_box`.
- **M-of-N:** **verifiable** secret sharing (Feldman/Pedersen) over the DEK — plain Shamir has
  no integrity check (a corrupt share is unattributable).
- **WoCo never holds plaintext or a sufficient share set** (keeps it non-custodial).
- **Versioned envelope format**; re-wrap + rotate the DEK on any guardian change (old shares
  stay valid for whoever cached them — standard escrow caveat).

### 11.4 Auditor assessment — sound + robust, with one unavoidable tradeoff
Same mechanism class as social-recovery / MPC wallets; sound given §11.3. Honest caveats:
- **Recoverability NECESSARILY creates an at-rest copy** whose confidentiality equals the
  **recovery-threshold strength**, not "only the lost device could produce it." For a 1-of-1
  backup EOA, POD confidentiality reduces to that EOA's security. Inherent to ALL recovery —
  must be a conscious choice, not a bug.
- **A timelock protects funds-rotation, NOT escrow confidentiality.** Once an attacker meets
  the unwrap threshold the plaintext is theirs immediately; there is no "cancel" for a
  decryption already performed. Funds and secrets have different protections.
- **Minimize what is escrowed** (smaller blast radius): escrow only what must be the identical
  key (decryption key, feed signer); let the signing identity rotate via §11.2's on-chain
  authority (no escrow). Defense-in-depth: signing survives even if escrow is unavailable.

### 11.5 Swarm feed signer — same envelope, cleaner fit
The feed signer is a secret secp256k1 key → identical escrow. And it motivates escrow MORE
cleanly than POD: Swarm feeds are **owner-addressed** (topic/owner embeds the signer address),
so rotating the signer **orphans every existing feed**. Continuity ⇒ same key back ⇒ escrow,
never rotate. Today all feeds use the server's single `FEED_PRIVATE_KEY` (centralised); this
becomes load-bearing when feed signing moves client-side / per-user
(`project_signing_role_architecture`). Fold `feedSignerPrivKey` into the §11.3 bundle.

### 11.6 Build order (decided 2026-06-18 — POD-first, escrow-only, feed-signer slot reserved)
**Principle:** build a GENERIC versioned `RecoveryBundle = { version, secrets: Record<name,
secret> }` encrypted as ONE envelope — NOT a POD-specific blob. v1 ships `secrets: { podSeed }`;
adding `feedSignerPrivKey` later is a content change in an already-defined format (same
threshold, same ceremony, NO new crypto). Reserves the feed-signer slot at zero cost without
implementing client-side feed signing now.

**Key simplification:** escrowing the POD seed returns the EXACT SAME ed25519 key, which
recovers BOTH jobs at once — keep signing (verifiers already trust the key → NO verifier/ticket
change) AND decrypt old data. So §11.2's on-chain authorization log is NOT needed for v1; it
only earns its keep for rotate-without-escrow or compromise-response. **Escrow-only is the
minimal robust path.**

1. **Now — POD recovery, escrow-only, 1-of-1 backup EOA.** Generic bundle `{ podSeed }`;
   DEK (AEAD) wrapped to the guardian's dedicated **X25519** key. Guardian derives that X25519
   key deterministically by signing a fixed message (the SAME deterministic-EIP-712 trick
   `requestPodIdentity` already relies on in prod) → no device-bound storage. Store ciphertext
   on a **Swarm feed `woco/recovery/{kernelAddress}`** (survives device loss; encrypted-to-
   guardian so public is fine; server feed signer writes ciphertext only, never plaintext).
   AAD-bind to the Kernel address (no transplant). Unwrap step in the recovery portal AFTER
   `recoverAccount` rotates the Kernel signer.
2. **Later — VSS M-of-N** (Feldman/Pedersen) over the same DEK for social recovery.
3. **When client-side feed signing lands** — add `feedSignerPrivKey` to the bundle (re-wrap).
   Feeds are owner-addressed so this is escrow-not-rotate (§11.5). No mechanism change.
4. **Optional, separate track — on-chain POD-key authorization log** (§11.2) for rotation
   hygiene / compromise response. Independent of 1–3.
- Re-key/re-wrap the DEK on any guardian change. Libs: libsodium (`crypto_box`, AEAD) + a
  vetted VSS impl — do NOT hand-roll ECIES or SSS.
