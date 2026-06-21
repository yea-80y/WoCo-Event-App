# Email-Kernelize Plan — give Web3Auth (email/social) users a ZeroDev Kernel

Status: **P1+P2+P3 BUILT + typecheck-green (2026-06-21), committed (P1 d591bbf,
P2 e4c1900, P3 c4576e3). NOT yet LIVE-verified** — blocked on the frontend deploy
(LAUNCH_PLAN step 3; Web3Auth fails on localhost). Run the §Verify checklist the
moment the deploy lands. P4 (sub-ENS/shop for email) deferred. Changes 1–8 + 10
landed; change 9 (teardown) needed no code (clearAllAuth already universal).

**Phase B feed-signer decision (resolved here, per LAUNCH_PLAN step 1):** the
web3auth content-feed signer is derived **deterministically from the raw Web3Auth
secp256k1 key under its OWN domain** (e.g. `keccak256("woco/feed-signer/v1" ||
web3authKey)`), NOT from the Kernel and NOT from POD. Recovery = re-login (same
login → same Web3Auth key → same feed signer); no escrow needed. Mirrors the
passkey rule "feed signer ≠ POD seed" with a different root. Phase B (step 2)
implements it at the `TODO(swarm-id)` seam.

Status (historical): PLANNED (2026-06-21). Launch item. Zero real Web3Auth users → clean slate, no migration.
Decision context: memory `project_auth_provider_decision`. Keep Web3Auth, no Privy.
ORDER: this is step 1 in `docs/LAUNCH_PLAN.md` — it MUST land BEFORE Phase B feed
migration (identity flip before feed-signer flip) and its LIVE verify needs the frontend
deployed (Web3Auth fails on localhost). Also resolve here: the web3auth feed-signer source
that Phase B consumes (recommended: derive from the Web3Auth key, own domain).

## Goal

Today a Web3Auth (email/social/phone) login is a **plain EOA** → locked out of the gasless
on-chain rails (likes/follows/sub-ENS/shop) because an EOA can't be sponsored and has no ETH.
Make the email login mint a **ZeroDev Kernel** exactly like passkey, so email users are
first-class and can like/follow gaslessly at launch.

## Key insight (why this is small)

The Kernel layer is already signer-agnostic:
- `apps/web/src/lib/auth/kernel-account.ts` → `buildKernelFromPrivateKey(privateKey)` takes ANY
  raw secp256k1 key. Passkey feeds it the PRF key; **email feeds it the Web3Auth key.**
- `createEasSessionKey(builtKernel)` / `getEasSessionClient()` / `sendSessionUserOp()` are generic.
- `apps/web/src/lib/eas/attest.ts` `passkeySend()` works for ANY Kernel — only the `send()`
  switch on `auth.kind` currently excludes `web3auth`.

So this is mostly: route `web3auth` through the passkey-shaped Kernel path in `auth-store`,
**minus** the biometric / recovery-binding / portability-envelope machinery (email re-login is
itself deterministic recovery — same login → same Web3Auth key → same Kernel address).

## Invariants (DO NOT BREAK)

1. **POD stays on the raw key, NEVER the Kernel.** Smart-account (1271) sigs are
   non-deterministic and would corrupt the ed25519 POD identity + encryption. Email POD must
   derive from the raw Web3Auth secp256k1 key + its EOA address (RFC-6979 deterministic) —
   mirror passkey invariant #1 exactly. (`_getPodSigner` / `_getPodAddress` / `POD_ADDRESS`.)
2. **Parent identity becomes the Kernel address** (not the Web3Auth EOA). This is the on-chain
   identity for likes/follows/payout. `attester == parent` holds because the Kernel is msg.sender.
3. **Funds-critical Web3Auth determinism** (already documented in `web3auth-config.ts`): key =
   (login × VITE_WEB3AUTH_CLIENT_ID × network). Pinning these pins the Kernel address. Do not
   repoint a live deployment.
4. **Recovery backbone untouched** (`backup-signer.ts` / `connectWeb3AuthBackup`). Out of scope.

## File-by-file changes (`apps/web/src/lib/auth/auth-store.svelte.ts` unless noted)

State: keep `_web3authPrivateKey` (now the POD source + Kernel sudo source, like
`_passkeyPrivateKey`). Add a `_web3authPodAddress` (the Web3Auth EOA) analogous to `_podAddress`.

1. **`loginWeb3Auth()` (~531):** after `loginWithWeb3Auth()` returns `{address, privateKey}`:
   - `buildKernelFromPrivateKey(privateKey)` → `kernel`.
   - `_parent = kernel.address` (NOT the EOA); `_kernel = kernel`.
   - `_web3authPrivateKey = privateKey`; `_web3authPodAddress = address` (EOA).
   - Persist `PARENT_ADDRESS = kernel.address`, `POD_ADDRESS = address` (EOA), `AUTH_KIND=web3auth`.
   - `_clearStaleAuthForSwitch(kernel.address)` BEFORE restore (same order as passkey).
   - Mirror the passkey ordering; skip recovery-binding/portability (email doesn't need it).

2. **`_getSigner()` (~106):** change the `web3auth` branch from `createLocalSigner(rawKey)` to the
   **Kernel typed-data signer** (copy the passkey branch): `await _ensureKernelForWeb3Auth()` then
   `createKernelTypedDataSigner(_kernel.account)`. (Server verify-delegation already accepts 1271/6492.)

3. **`_getPodSigner()` (~125):** add a `web3auth` branch returning `createLocalSigner(_web3authPrivateKey)`
   — deterministic POD signer over the raw key (parallels the passkey PRF branch).

4. **`_getPodAddress()` (~144):** `if (_kind === "web3auth") return _web3authPodAddress ?? _parent;`

5. **Kernel build/restore:** `_ensureKernel()` (~308) is passkey-coupled (`_ensurePasskeyKey`).
   Add `_ensureKernelForWeb3Auth()` (or generalize): builds from `_web3authPrivateKey`, asserts
   `kernel.address === _parent`. No address override (no recovery binding for email).

6. **init/restore (~422):** the `web3auth` restore branch already calls `restoreWeb3AuthSession()`
   and sets `_web3authPrivateKey`. After that, set `_web3authPodAddress` from the restored EOA and
   build the Kernel (`_ensureKernelForWeb3Auth`), set `_parent = kernel.address`. Restore POD seed by
   the EOA address (already handled by `_getPodAddress` in `_restoreCachedAuth`).

7. **`ensureEasSessionKey()` (~816):** widen guard from `passkey`-only to `passkey || web3auth`
   (and route through whichever `_ensureKernel*` matches the kind). The mint is gasless + needs no
   prompt for email (raw key already in memory).

8. **`attest.ts` `send()` (~149):** add `case "web3auth":` to the Kernel/gasless branch (rename
   `passkeySend` → `kernelSend` for clarity). Email likes now go gasless via the EAS session key.
   Remove `web3auth` from the "not available" default.

9. **logout/clear (~1186, ~1219):** on `web3auth` logout also `clearEasSessionKey()` +
   `clearWocoSessionKey()` + `_kernel = null` (mirror passkey teardown) and `logoutWeb3Auth()`.

10. **Payout gate:** parent is now the Kernel address. Confirm the client payout-eligibility check
    (kind ∈ allowed) still passes for `web3auth`, and that crypto payout to a smart-account address
    is acceptable (it is — Kernel can hold/receive ERC-20+ETH). Server uses verified parent, no change.

## Phasing (small, revertable commits — see `feedback_commit_cadence`)

- **P1 — Kernelize identity:** changes 1–6. Email login yields a Kernel parent; AuthorizeSession
  signs as 1271; POD on the raw key. Verify login + publish + claim still work for email.
- **P2 — Gasless likes/follows:** changes 7–8. Email user can like an event + follow a profile;
  confirm on-chain attester == Kernel parent and `/api/likes/record` accepts it.
- **P3 — Teardown + payout:** changes 9–10. Logout cleanliness; payout-eligibility parity.
- **P4 (optional, post-launch):** sub-ENS + shop spend for email (same Kernel; should fall out
  naturally since those rails are Kernel-generic — verify, don't assume).

## Verify (LIVE, real browser + real Web3Auth login — no mocks)

1. Email login → DevTools: `auth.kind==='web3auth'`, `auth.parent` == a Kernel address (not the EOA).
2. Like an event → ZeroDev userOp succeeds gasless; on Arbiscan the EAS `attest` `msg.sender` ==
   `auth.parent`; `/api/likes/:type/:id` reflects it.
3. Reload page → silent restore rebuilds the SAME Kernel address; POD identity intact (decrypt a
   dashboard claim).
4. Follow a profile (subjectType=profile) → same checks.
5. Publish an event as the email user → POD-signed series verifies; claim a ticket.
6. Re-login on a different browser profile → SAME Kernel address (determinism check).

## Gotchas / watch-list

- **First userOp gas:** `sendSessionUserOp` already has the `VERIFICATION_GAS_FALLBACK = 3_000_000n`
  retry for the brand-new-account enable-mode path (see `project_zerodev_incident_202606` /
  `project_agent_commerce_aa23`). Email's first like will hit exactly that path — keep the retry.
- **EAS call policy:** the EAS session key is selector-only (attest/revoke) by design — do NOT add
  the nested ABI (it broke paymaster estimation). Reuse `createEasSessionKey` as-is.
- **POD address persistence:** `POD_ADDRESS` MUST be the Web3Auth EOA, `PARENT_ADDRESS` the Kernel.
  Mixing them = AAD mismatch wipes POD seed. Same trap passkey already documents.
- **No portability envelope for email:** do not copy passkey's `_verifyPortabilityEnvelope` /
  recovery-binding code — email recovery is "log in again" (deterministic key). Keep it simple.
- **ZeroDev chains:** Kernel is pinned to Arbitrum Sepolia (421614) in `kernel-account.ts`. Email
  Kernel rides the same chain + paymaster as passkey — no new infra.
- **Aggregate verifier (separate launch task):** if advertising email + phone + Google, configure
  a Web3Auth aggregate verifier so all methods → ONE identity (else different login = different key
  = different Kernel = "lost" account). Pin before launch.

## Out of scope (tracked elsewhere)

- Web3 wallet sponsorship via EIP-7702 (separate plan; verify 7702 on ZeroDev chains first).
- Privy (deferred + reversible; gated on concrete trigger).
- Recovery backbone changes.
