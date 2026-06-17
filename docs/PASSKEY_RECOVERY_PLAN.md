# Passkey Account Recovery — Design / Build Plan

**Status:** Phase 0 spike DONE + PASSING on Arb Sepolia (2026-06-17). Phase 1 has ONE open
design decision (deployed-account install path) — see "Phase 0 results" below before building.
**Owner intent (2026-06-17):** let ZeroDev Kernel passkey accounts safely *hold/receive
funds* by adding a recovery path, instead of the current blanket "passkey accounts can't
receive funds" rule.

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

**PARTIALLY PROVEN — install on an ALREADY-DEPLOYED account (the realistic WoCo case).** Most
passkey Kernels are `{ sudo: ecdsaValidator }` only and already deployed (sub-ENS / like
deploys them). `account.encodeModuleInstallCallData()` is **EP0.6-only**. The v0.7 path is
`installValidations` (via `createKernelAccount({ pluginMigrations })`). Spike
`recovery-spike-deployed.ts` progress on Arb Sepolia:
- ✓ deploy sudo-only Kernel
- ✓ install the weighted guardian validator post-deploy (sudo-signed userOp lands)
- ✓ install the `doRecovery` executor ROUTE — REQUIRED FIX: the migration helper
  `getValidatorPluginInstallModuleData` truncates `selectorData` to the 4-byte selector, so no
  executor route exists → `doRecovery` reverts `0x7352d91c`. Hand-building `selectorData` as
  `selector(4) + executor(20=0xe884…) + actionHook(20) + abi(selectorInitData=0xFF
  delegatecall, hookInitData)` — i.e. the SDK's own `getEncodedPluginsData` format — installs
  the route and clears that revert.
- ✗ guardian recovery userOp fails VALIDATION: **AA23 reverted `0x682a6e7c`**. The weighted
  validator's per-account signer config is not initialized by the hand-built
  `installValidations` enable data (it works baked-in at genesis — `recovery-spike.ts` PASS).

**Phase 1 first task:** finish the weighted validator's post-deploy on-install initialization
(likely an SDK encoding gap in the `pluginMigrations`/`installValidations` path; consider
ZeroDev support — funds-critical) so `0x682a6e7c` clears. Until then, recovery setup is proven
for *counterfactual* accounts and the rotation primitive itself is fully proven; deployed-
account setup is one bounded encoding fix away.

Spike artifacts: `apps/web/scripts/recovery-spike.ts` (PASS — counterfactual), 
`recovery-spike-deployed.ts` (deployed: install OK, recovery validation AA23 — resume point).

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
- **POD identity recovery is OUT OF SCOPE.** The ed25519 POD identity (ticket signing /
  encryption) is derived from the **raw PRF key**, not from the Kernel (invariant #1).
  Rotating the Kernel's signer restores control of the *smart account / funds*, NOT the
  POD-derived ticket-signing identity. Losing the passkey still loses POD identity. That is
  a separate problem (e.g. POD key escrow / re-issue) — note it, don't solve it here.
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
