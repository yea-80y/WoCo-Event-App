# ZeroDev Passkey Wallet — Integration Plan (item #1b)

**Decision (2026-05-30, CTO/crypto-lead):** Build **Option 1 — ECDSA-over-PRF Kernel** for the
buildathon. Native passkey-validator (Option 2) is a documented post-buildathon hardening step
(see "Option 2 migration" below + roadmap slide). Research findings that led here are at the
bottom.

---

## BUILD PROGRESS

| Phase | Status | Commit |
|-------|--------|--------|
| 0 — deps + env + smoke test | ✅ done (paymaster 500 deferred to Phase 5) | `d6b7304` |
| 1 — `kernel-account.ts` | ✅ done | `e0fd245` |
| 2 — auth-store wiring (Kernel parent, POD on PRF-EOA) | ✅ done | `fcb69c7` |
| 3 — scoped ZeroDev session keys | ✅ done | _this commit_ |
| 4 — sub-ENS `claimSubEnsViaPermit` | ⬜ **NEXT** | — |
| 5 — verify end-to-end on Arb Sepolia (+ fix paymaster 500) | ⬜ | — |

All UNCOMMITTED→COMMITTED on `main`; frontend NOT yet deployed to Swarm (user runs `npm run deploy`).
typecheck (`npm run check -w @woco/web`) is GREEN for this work — 23 pre-existing errors live in
builder files (GatewayPicker/BrandTab/EventsTab/MultiSiteBuilder) and are unrelated tech debt.

**What Phase 2 actually built (so Phase 3 doesn't re-derive it):**
- `kernel-account.ts` exposes `KernelSudoValidator`, `BuiltKernel`, `buildKernelFromPrivateKey(pk)`
  → `{ address (lowercased, deterministic), account, kernelClient, sudo }`, and
  `createKernelTypedDataSigner(account)`. All ZeroDev/viem imports are dynamic (lazy chunk).
- auth-store: passkey `_parent` = Kernel address (stored as `PARENT_ADDRESS`); `_getSigner()` passkey
  → Kernel 1271/6492 sig. `_ensureKernel()` rebuilds + asserts address == stored parent.
- POD invariant kept: `_getPodSigner()` (raw PRF Wallet) + `_getPodAddress()` (PRF-EOA, kind-aware);
  `StorageKeys.POD_ADDRESS` persists the PRF-EOA so POD restores without biometric and
  `restorePodSeed` never sees the Kernel address. Pre-upgrade sessions force a clean re-login.
- In-memory `_kernel: BuiltKernel | null` is the cache to reuse in Phase 3 (`getWocoSessionClient`).

**What Phase 3 actually built (so Phase 4 doesn't re-derive it):**
- `kernel-account.ts` adds `createWocoSessionKey(builtKernel)` → mints a fresh secp256k1 session key,
  scopes it with `toCallPolicy` (V0_0_5, pinned to `registerWithPermit` on `WOCO_REGISTRAR_ADDRESS`),
  `toGasPolicy({ allowed: 0n, enforcePaymaster: true })` (session key can NEVER spend Kernel ETH —
  gasless-only) and `toTimestampPolicy` (30-day TTL); `serializePermissionAccount` → encrypt
  (`AAD.WOCO_AA_SESSION(kernelAddress)`) → IndexedDB `StorageKeys.WOCO_AA_SESSION`. ECDSA sudo signs
  the enable data in-memory — NO extra passkey prompt.
- `getWocoSessionClient(kernelAddress)` → decrypt + `deserializePermissionAccount` → gasless
  `KernelAccountClient` (no passkey). `hasWocoSessionKey()` / `clearWocoSessionKey()` helpers; logout
  drops the slot in auth-store `clearAllAuth()`.
- `WOCO_REGISTRAR_ADDRESS = 0x7c0DE55…` exported (single source of truth; matches prod env + permit
  response). FLAG: the `0x206e5e2f…` default in `apps/server/.../sub-ens-contract.ts` is STALE —
  overridden by env in prod. Phase 4 MUST cross-check this constant against the live permit
  `registrarAddress` and refuse on mismatch (else the call policy silently rejects the userOp).
- `@zerodev/permissions` import paths confirmed: root (`toPermissionValidator`,
  `serialize/deserializePermissionAccount`), `/signers` (`toECDSASigner`), `/policies`
  (`toCallPolicy`+`CallPolicyVersion`, `toGasPolicy`, `toTimestampPolicy`).

---

## RESUME HERE — Phase 3 (copy-paste into a fresh chat)

> Continue ZeroDev passkey wallet — item #1b, Option 1 (ECDSA-over-PRF Kernel), Arb Sepolia (421614).
> Plan is LOCKED — do NOT re-litigate the option. Read `docs/ZERODEV_PASSKEY_INTEGRATION_PLAN.md`
> (esp. "BUILD PROGRESS" + Phase 3/4/5 + Security invariants) and `docs/SUBENS_PROFILES_HANDOVER.md`.
> Phases 0–2 are committed and typecheck-green (last commit `fcb69c7`); `kernel-account.ts` +
> auth-store Kernel wiring exist. Work with your cryptographic-expert/CTO hat on; flag anything unsafe.
>
> WORK ORDER (build + `npm run check -w @woco/web` + commit per phase; SEQUENTIAL tool calls):
> 1. Phase 3 — add to `apps/web/src/lib/auth/kernel-account.ts`: `createWocoSessionKey(builtKernel)`
>    using `@zerodev/permissions` (`toECDSASigner` from `/signers`, `toPermissionValidator`,
>    `toCallPolicy` scoped to WoCoRegistrar `0x7c0DE55a1713e6C1a53Db50314C7CB608179aAf1` (+EAS later)
>    + `toGasPolicy` + `toTimestampPolicy`) → mount as `plugins.regular` alongside `plugins.sudo`
>    (the cached `_kernel.sudo.validator`) → `serializePermissionAccount(sessionAccount, sessionPk)`
>    → encrypt via `./storage/encryption.ts` (AAD bound to the Kernel address) → IndexedDB.
>    `getWocoSessionClient()`: `deserializePermissionAccount` → `createKernelAccountClient` w/ paymaster
>    → gasless `sendUserOperation`, no further passkey prompts. NEVER `toSudoPolicy` in prod (invariant #3).
> 2. Phase 4 — `apps/web/src/lib/api/sub-ens.ts` `claimSubEnsViaPermit()`: `authPost('/api/sub-ens/permit')`
>    → build `registerWithPermit(...)` calldata → session-client `sendUserOperation` → `waitForUserOperationReceipt`.
>    Keep `claimSubEnsLabel()` (sponsor `/claim`) as the Para/email fallback. `SubENSPicker.svelte`
>    (`apps/web/src/lib/creator/builder/`) chooses permit path when `auth.kind === "passkey"`.
> 3. Phase 5 — verify on Arb Sepolia; fix the paymaster HTTP 500 dashboard-side
>    (`dashboard.zerodev.app/paymasters` — enable gas policy / fund self-funded tank).
>
> INVARIANTS (already upheld; keep them): POD stays on raw PRF key + PRF-EOA address, never the Kernel.
> Server `verify-delegation.ts` already handles 1271/6492 — no server change. `passkey-account.ts`
> stays UNTOUCHED. Session keys are SCOPED (toCallPolicy), never sudo, in production.
> WORKING STYLE: sequential / small tool batches, absolute paths, verify each step. Commit per phase.

---

## START NEXT CHAT (copy-paste)

> Read `docs/ZERODEV_PASSKEY_INTEGRATION_PLAN.md` (full) and `docs/SUBENS_PROFILES_HANDOVER.md`.
> We're building **item #1b — ZeroDev passkey wallet, Option 1 (ECDSA-over-PRF Kernel)** on
> Arbitrum Sepolia (chain 421614). Plan is locked; do NOT re-litigate the option choice.
> Reuse `apps/web/src/lib/auth/passkey-account.ts` (PRF→secp256k1) untouched as the Kernel's
> sudo signer. Keep POD identity derivation on the raw PRF key (deterministic) — never on the
> Kernel. Server verifier `verify-delegation.ts` already handles ERC-1271/6492 — no server change
> for auth. Work the phases in order, build + typecheck after each, commit at each milestone.
> ZeroDev project is already provisioned:
> `VITE_ZERODEV_RPC=https://rpc.zerodev.app/api/v3/fa58debd-2af8-429f-b753-b75ca8edc17c/chain/421614?selfFunded=true`
> Time is critical — proceed at pace. Start at Phase 0: add that env var, verify the RPC answers
> `eth_chainId` (421614), then run the quick gasless smoke test (NOT a gate — Arb Sepolia gas is
> free, fund a faucet tank if needed and move on) and go straight into Phase 1. Read with your
> cryptographic-expert/CTO hat on; flag anything unsafe but don't stall on the gas question.

---

## What "Option 1" is (one line)

ZeroDev **Kernel** (ERC-4337 smart account) on Arb Sepolia, whose **sudo signer** is our existing
PRF-derived secp256k1 key, wrapped by `@zerodev/ecdsa-validator`. Gasless via ZeroDev paymaster.
Scoped **on-chain session keys** (`@zerodev/permissions`) for WoCo txns (sub-ENS mint, EAS).

**This delivers the full buildathon story** — Kernel + session keys + gasless paymaster +
Arbitrum-native + passkey login — with maximum reuse and zero security regression vs today.

## Two different "session" concepts — DO NOT CONFLATE

| Layer | Name | Purpose | Status |
|-------|------|---------|--------|
| Our HTTP auth | **session delegation** (EIP-712 `AuthorizeSession`) | authenticates requests to our Hono server | exists; reused as-is |
| On-chain AA | **ZeroDev session key** (`toPermissionValidator`) | authorizes userOps without re-prompting the passkey | NEW in this work |

They are independent. The Kernel signs the HTTP `AuthorizeSession` as the parent (ERC-1271); the
ZeroDev session key signs on-chain userOps.

---

## Security invariants (crypto-lead, enforce these)

1. **POD identity stays deterministic and wallet-independent.** Derive the ed25519 POD seed from a
   signature by the **raw PRF secp256k1 key** (ethers `Wallet`, RFC-6979 → deterministic), with a
   **fixed address field = the PRF-EOA address**. NEVER derive POD from a Kernel/smart-account
   signature (non-deterministic → corrupts the user's encryption + ticket-signing identity). This
   keeps POD safe across the future Option 2 swap.
2. **No security regression vs today.** The PRF key already lives in JS memory in the shipped
   passkey login; Option 1 keeps exactly that and *adds* session-key isolation. No new key
   exposure, no new server.
3. **Session keys are scoped, not sudo.** Use `toCallPolicy` to restrict the on-chain session key
   to `WoCoRegistrar` (and later the EAS contract) only, plus `toGasPolicy` + `toTimestampPolicy`.
   Never ship `toSudoPolicy({})` to production — it's only acceptable in a throwaway spike.
4. **Pluggable validator.** Put the sudo signer behind a small interface so swapping ECDSA →
   passkey-validator (Option 2) is a localized change, never a rewrite.
5. **Server unchanged for auth.** `verify-delegation.ts` already verifies EOA/1271/6492 via viem's
   universal validator (same path CSW uses). Do not touch it.

---

## Dependencies (apps/web)

Add (lazy-loaded, kept out of the main chunk like Para/CSW):
```
@zerodev/sdk@^5.5  @zerodev/ecdsa-validator@^5.4  @zerodev/permissions@^5.6  viem@^2.28
```
`viem` is new to apps/web (currently ethers v6). Scope it to the wallet layer; do not migrate
existing ethers code. EntryPoint **0.7**, `KERNEL_V3_1` (stable) or `V3_3`.

**User action required before coding:** create a ZeroDev project (dashboard), enable the Arb
Sepolia paymaster gas policy, and provide the bundler/paymaster RPC URL as `VITE_ZERODEV_RPC`
(client env). No private keys involved — this is a public project endpoint.

**Project provisioned (2026-05-30):**
- Project ID: `fa58debd-2af8-429f-b753-b75ca8edc17c`
- `VITE_ZERODEV_RPC=https://rpc.zerodev.app/api/v3/fa58debd-2af8-429f-b753-b75ca8edc17c/chain/421614?selfFunded=true`
  (bundler + paymaster, single endpoint). `selfFunded=true` = paymaster draws from a self-funded
  gas tank (free-tier default, NOT "user pays own gas") — end-user UX is still gasless on testnet.
- Passkey-server URL (Option 2 ONLY, not used in Option 1):
  `https://passkeys.zerodev.app/api/v3/fa58debd-2af8-429f-b753-b75ca8edc17c`
- **Phase 5 must explicitly verify** a sponsored userOp lands on-chain. If sponsorship errors, fix
  is dashboard-side (gas policy enabled / tank funded), not SDK code.
- **Sponsorship protection = Gas Policies, NOT a domain allowlist** (ZeroDev has no origin allowlist).
  Dashboard → project → Gas Policies (`dashboard.zerodev.app/paymasters`). Policy types: project /
  contract / wallet + rate limits + spend caps. Before mainnet, scope a **contract policy** to our
  Arb Sepolia contracts only — `WoCoRegistrar 0x7c0DE55a1713e6C1a53Db50314C7CB608179aAf1` (+ EAS
  later) — so the public RPC URL can't be used to drain the gas tank on arbitrary txns. Mirrors the
  on-chain session-key `toCallPolicy` scoping. Testnet: default policy is fine to start.

---

## Phase plan (build + typecheck + commit per phase)

### Phase 0 — ZeroDev project + env + quick gasless smoke test
- Create project, Arb Sepolia, paymaster gas policy on. (Done — see "Project provisioned" above.)
- Add `VITE_ZERODEV_RPC` to `apps/web/.env` (and document in CLAUDE.md env list).
- Verify the RPC answers `eth_chainId` → `0x66eee` (421614) from a scratch script.
- **Quick smoke test, NOT a gate — proceed regardless.** Throwaway script: random EOA →
  `signerToEcdsaValidator` → `createKernelAccount` → `createKernelAccountClient` w/ paymaster →
  `sendUserOperation` a no-op (to `zeroAddress`) → `waitForUserOperationReceipt`. Confirms the
  gasless path end-to-end in ~30 min. **Funding is a non-issue:** Arb Sepolia gas is free (faucet
  ETH), so `selfFunded` just means topping a testnet tank that costs nothing. If sponsorship needs
  a tank, fund it from a faucet and move on. Parallel track (user): ask the ZeroDev/Offchain Labs
  team about buildathon free-tier / sponsorship — potential partnership, not a blocker. Build
  continues either way.

### Phase 1 — `kernel-account.ts` (new module, the whole wallet layer)
`apps/web/src/lib/auth/kernel-account.ts` — all ZeroDev imports live here (lazy dynamic import
from auth-store, same pattern as `coinbase-account.ts`). Exposes:
- `type KernelSudoValidator` — the pluggable interface (today: ECDSA-from-privatekey; later:
  passkey-validator). Keeps the swap localized (invariant #4).
- `buildKernelFromPrivateKey(privateKey: string): Promise<{ address, account, kernelClient }>`
  - viem `createPublicClient` → Arb Sepolia via `VITE_ZERODEV_RPC`
  - `signerToEcdsaValidator(publicClient, { signer: privateKeyToAccount(pk), entryPoint, kernelVersion })`
  - `createKernelAccount(publicClient, { plugins: { sudo: ecdsaValidator }, entryPoint, kernelVersion })`
  - `createKernelAccountClient({ account, chain: arbitrumSepolia, bundlerTransport, paymaster: zerodevPaymaster })`
  - Kernel address is deterministic (CREATE2 from validator+owner) — stable across reloads.
- `createKernelTypedDataSigner(account): EIP712Signer` — adapts our ethers-shaped
  `(domain, types, value)` call into viem `account.signTypedData({ domain, types, primaryType, message })`.
  Returns the ERC-1271/6492 signature string the server already understands. (Mirrors
  `coinbase-signer.ts`.) primaryType = first key of `types` (e.g. `AuthorizeSession`).

### Phase 2 — wire into auth-store (keep `kind === "passkey"`)
`apps/web/src/lib/auth/auth-store.svelte.ts`:
- `loginPasskey()`: PRF ceremony (`authenticatePasskey()` — unchanged) → `buildKernelFromPrivateKey(privKey)`
  → `_parent = kernelAddress` (NOT the EOA), keep `_passkeyPrivateKey` + cache the kernel objects
  in memory. Store `PARENT_ADDRESS = kernelAddress`.
- `init()` passkey branch: parent = stored kernel address; rebuild the Kernel lazily on first
  `_ensurePasskeyKey()` (PRF ceremony then `buildKernelFromPrivateKey`); assert rebuilt address
  matches stored.
- `_getSigner()` passkey branch → `createKernelTypedDataSigner(kernelAccount)` (was
  `createPasskeySigner`). This is what signs the HTTP `AuthorizeSession`.
- **NEW** `_getPodSigner()`: for passkey kind returns a raw-PRF-key ethers signer
  (`createPasskeySigner(_passkeyPrivateKey, confirm)` — the OLD signer); for all other kinds it
  equals `_getSigner()` (today's behaviour). `ensurePodIdentity()` calls `_getPodSigner()`, and
  `requestPodIdentity()` is passed the **PRF-EOA address** as the stable address field
  (invariant #1).
- Sanity: existing passkey users get a new (kernel) address. Acceptable — attendee MyTickets +
  on-Swarm tickets aren't live yet (memory `project_attendee_no_mytickets`), and this is testnet.

### Phase 3 — on-chain ZeroDev session keys (scoped)
In `kernel-account.ts`:
- `createWocoSessionKey(kernelAccount, sudoValidator)`:
  - `sessionPk = generatePrivateKey()`; `sessionSigner = toECDSASigner({ signer: privateKeyToAccount(sessionPk) })`
  - `permissionPlugin = toPermissionValidator(publicClient, { signer: sessionSigner, policies: [toCallPolicy({...WoCoRegistrar/EAS}), toGasPolicy(...), toTimestampPolicy(...)], entryPoint, kernelVersion })`
  - `sessionAccount = createKernelAccount(..., { plugins: { sudo: sudoValidator, regular: permissionPlugin } })`
  - `serializePermissionAccount(sessionAccount, sessionPk)` → encrypt with our `encryption.ts`
    (AAD bound to kernel address) → IndexedDB. **One** passkey ceremony approves it.
- `getWocoSessionClient()`: `deserializePermissionAccount(...)` → `createKernelAccountClient` with
  paymaster → returns a client that `sendUserOperation`s gaslessly, no further passkey prompts.

### Phase 4 — move sub-ENS mint client-side (permit path)
`apps/web/src/lib/api/sub-ens.ts` + `SubENSPicker.svelte`:
- New `claimSubEnsViaPermit(opts)`:
  1. `authPost('/api/sub-ens/permit', { label, description, avatar })` → `{ sig, expiry, chainId, registrarAddress }` (route already live).
  2. Build the `registerWithPermit(label, owner=kernelAddress, contenthash, textKeys, textValues, expiry, sig)` calldata.
  3. `getWocoSessionClient().sendUserOperation({ callData: encodeCalls([{ to: registrarAddress, data }]) })` → gasless.
  4. `waitForUserOperationReceipt`.
- Keep `claimSubEnsLabel()` (sponsor `/api/sub-ens/claim`) as the fallback for email-only / no-wallet (Para) organisers.
- `SubENSPicker` chooses permit path when `kind === "passkey"` (Kernel present), else sponsor path.

### Phase 5 — verify end-to-end on Arb Sepolia
- Passkey login → kernel address shown.
- `ensureSession()` → one passkey prompt → `/api/health`-authenticated call succeeds (server
  verifies kernel 1271/6492 sig).
- POD: publish path derives a **stable** POD key across two logins (assert same `podPublicKeyHex`).
- Sub-ENS claim via permit → on-chain `registerWithPermit` userOp, gasless, label resolves.
- No server redeploy required for auth; only frontend `npm run deploy` (user) when shipping.

---

## File map (this work)

```
NEW  apps/web/src/lib/auth/kernel-account.ts          # ZeroDev Kernel + session-key layer (lazy)
EDIT apps/web/src/lib/auth/auth-store.svelte.ts       # passkey kind → Kernel; split POD signer
EDIT apps/web/src/lib/api/sub-ens.ts                  # claimSubEnsViaPermit (session-key userOp)
EDIT apps/web/src/lib/creator/builder/SubENSPicker.svelte  # permit path when Kernel present
KEEP apps/web/src/lib/auth/passkey-account.ts         # PRF→secp256k1, UNCHANGED (sudo signer + POD)
KEEP apps/server/src/lib/auth/verify-delegation.ts    # already 1271/6492 — UNCHANGED
EDIT apps/web/.env + CLAUDE.md                         # VITE_ZERODEV_RPC
```

---

## Option 2 migration (post-buildathon hardening — note for demo/roadmap)

**Option 2 = native `@zerodev/passkey-validator`:** the passkey's P-256 key is verified on-chain;
the signing key **never exists in JS** (hardware/enclave-bound) — XSS cannot exfiltrate it. This is
a real security upgrade over Option 1 and a strong roadmap talking point for the submission.

**Why it's deferred, not shipped now:**
- Needs a **passkey/WebAuthn server** (ZeroDev-hosted or self-hosted `/register|login/options|verify`)
  — a new component + a demo-time availability dependency.
- **Breaks deterministic POD.** Smart-account/WebAuthn signatures aren't deterministic, so POD's
  seed source must move to an **independent PRF-only ceremony** (the "hybrid": passkey-validator for
  the wallet, PRF purely for the POD seed). `@zerodev/passkey-validator` uses `@simplewebauthn`
  without PRF, so this is a *separate* WebAuthn `prf` eval, designed carefully.

**Why the swap is cheap (because of Option 1's design):**
- Sudo signer is behind `KernelSudoValidator` (invariant #4) → replace `signerToEcdsaValidator`
  with `toPasskeyValidator` in `kernel-account.ts` only.
- POD already lives on an independent PRF path (invariant #1) → it survives the swap untouched.

**Demo line:** "Today the smart wallet is passkey-gated with a derived key; the roadmap moves the
signer fully on-chain (P-256, key never leaves the secure enclave) — a localized validator swap our
architecture already accommodates."

---

## Research appendix (verified 2026-05-30)

- **Session keys (from `zerodevapp/zerodev-examples`):** owner builds `toPermissionValidator` with a
  `toECDSASigner` + policies, mounts as `plugins.regular` alongside `plugins.sudo`, then
  `serializePermissionAccount(account, sessionPk)`; agent `deserializePermissionAccount(...)` and
  `sendUserOperation`. Revoke via `kernelClient.uninstallPlugin({ plugin })`.
- **Verification:** Kernel `signMessage`/`signTypedData` → ERC-1271, ERC-6492-wrapped while
  counterfactual. viem universal validator handles both. **Our server already does this.**
- **Native passkey-validator** (`5.6.0`, peers `@zerodev/sdk@^5.4`, `viem@^2.28`,
  `@zerodev/webauthn-key`) **requires a passkey server** — confirmed from docs. This is the cost
  that keeps it out of Option 1.
- Packages/versions: `@zerodev/sdk@^5.5`, `@zerodev/ecdsa-validator@^5.4`, `@zerodev/permissions@^5.6`,
  `viem@^2.28`. EntryPoint 0.7, KERNEL_V3_1/3_3.
- Addresses (Arb Sepolia): WoCoRegistrar `0x7c0DE55a1713e6C1a53Db50314C7CB608179aAf1`,
  L2Registry `0x41Fb196Ae7D65E06880A240c8d1B91245Fb84807`, chain 421614.
