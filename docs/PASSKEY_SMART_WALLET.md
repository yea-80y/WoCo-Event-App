# Passkey Smart Wallet — ZeroDev Kernel on Arbitrum

A seedless, gasless **ERC-4337 smart account** that a user gets just by logging in with a **passkey**.
Built on a **ZeroDev Kernel** on **Arbitrum Sepolia (`421614`)**. Companion to
[`BUILDATHON_SUBMISSION.md`](./BUILDATHON_SUBMISSION.md) (component **#1b**); it is the
account-abstraction layer underneath gasless [sub-ENS claims](./SUBENS_IDENTITY.md), gasless
[EAS likes/follows](./EAS_SOCIAL_GRAPH.md), and the bounded
[agent-commerce draw](./WOCO_AGENT_ARCHITECTURE.md).

---

## What it is (one line)

A ZeroDev **Kernel** whose **sudo signer** is a secp256k1 key **derived from the passkey's PRF
extension**, wrapped by `@zerodev/ecdsa-validator`; day-to-day actions are signed by **scoped on-chain
session keys** (`@zerodev/permissions`) and sent **gasless** via a ZeroDev paymaster. No seed phrase,
no second custody stack — the primitive we already run *is* the wallet (and, scoped differently, the
agent and shop spend-permission rails).

## Why a derived key, and not native P-256 (the honest design call)

There are two ways to back a passkey smart account:

| | **Option 1 — ECDSA-over-PRF (built)** | **Option 2 — native passkey-validator (roadmap)** |
|---|---|---|
| Signer | secp256k1 derived from passkey PRF | P-256 verified **on-chain**, key never in JS |
| Extra infra | none | requires a WebAuthn passkey server |
| POD identity | stays deterministic (see below) | needs a separate PRF-only ceremony |
| Security | no regression vs today's passkey login | XSS cannot exfiltrate the signer |

We built **Option 1** for the buildathon because it delivers the full story — Kernel + scoped
session keys + gasless paymaster + Arbitrum-native + passkey login — with **maximum reuse and zero
security regression** vs the passkey login we already ran (the PRF key already lived in JS memory;
Option 1 keeps exactly that and *adds* session-key isolation). Option 2 is a real hardening upgrade
but adds a passkey-server dependency and breaks deterministic POD, so it is a **localized validator
swap** parked for after the buildathon — see [Roadmap](#roadmap--option-2-native-passkey-validator).

## Scoped session keys — least privilege on-chain

The Kernel's sudo (PRF) key stays off the hot path. Routine actions are signed by **scoped session
keys** (`@zerodev/permissions`) bounded by **on-chain policies**, so a leaked session key can only do
what its policies allow. There are **two independent keys**, each in its own encrypted IndexedDB slot:

- **Sub-ENS key** — `toCallPolicy` pinned to **exactly `registerWithPermit` on the `WoCoRegistrar`**
  (function-selector scoped via the function ABI).
- **EAS likes/follows key** — a *separate* key, `toCallPolicy` pinned to EAS `attest` + `revoke` by
  **4-byte selector only** (no ABI). The split is deliberate: EAS's deeply-nested `AttestationRequest`
  tuple, baked into a shared key's enable-data, broke the paymaster's gas estimation and poisoned the
  sub-ENS path too — so each capability gets its own flat-enable-data key.

Both keys also carry:

- **`toTimestampPolicy`** — a 30-day TTL (mirrors the HTTP session window).
- **`toGasPolicy`** — a finite total-gas budget (0.2 ETH-equivalent; effectively unbounded on ~free
  Arb Sepolia gas, but still a finite cap so a leaked key can't drain the sponsor tank without limit).

Each key is minted with **one** passkey ceremony (the in-memory PRF sudo validator signs the enable
data — no extra biometric per action), serialized, encrypted (AAD bound to the Kernel address), and
stored in IndexedDB. After that, userOps land **gaslessly with no further passkey prompt**.
**`toSudoPolicy` is never used** — session keys are always scoped.

> **Honest note (gas policy):** `enforcePaymaster` is intentionally *not yet* set on these keys —
> ZeroDev's sponsor call simulates validation *before* attaching its paymaster, so enforcing it there
> tripped `PolicyFailed`. Restoring it (so a leaked key provably can't spend Kernel ETH on gas, beyond
> the call-policy + finite gas-cap bounds it already has) is a tracked post-buildathon item.

The **same Kernel**, with a delegated empty-account spender plus an `EQUAL`-recipient + per-draw-
ceiling call policy and a rate-limit policy, also backs the capped, non-custodial **spend-permission
rails** for the [shop](./SHOP_AND_LOYALTY.md) and [agent commerce](./WOCO_AGENT_ARCHITECTURE.md).

## Two different "session" concepts — never conflated

| Layer | What | Signs | Status |
|---|---|---|---|
| HTTP auth | **session delegation** (EIP-712 `AuthorizeSession`) | authenticates requests to our server | reused as-is |
| On-chain AA | **ZeroDev session key** (`toPermissionValidator`) | on-chain userOps, no re-prompt | new in this work |

They are independent. The **Kernel** signs the HTTP `AuthorizeSession` as the parent (an
ERC-1271/6492 signature); the **session key** signs on-chain userOps.

## POD identity stays independent of the wallet (the load-bearing invariant)

WoCo's POD identity (ed25519 — encryption + ticket signing) **must be deterministic**. So the POD seed
is derived from a signature by the **raw PRF secp256k1 key** (ethers `Wallet`, RFC-6979 →
deterministic) with a **fixed address field = the PRF-EOA address** — *never* from a Kernel/smart-
account signature (those are non-deterministic and would corrupt the user's encryption + ticket
identity). The PRF-EOA address is persisted so POD restores without a biometric prompt and never sees
the Kernel address. This keeps POD stable across the future Option 2 swap.

## Server-side: multi-chain signature verification

The server verifies the Kernel's `AuthorizeSession` as an **ERC-1271 / ERC-6492** signature using
viem's universal validator — **across every smart-account home chain** (Base for the
[Coinbase Smart Wallet](./ONCHAIN_TICKETING.md#3-coinbase-smart-wallet-login), **Arbitrum Sepolia for
the Kernel**). A single-chain pin previously 403'd every passkey request because a counterfactual
6492 sig only validates on its own chain; the multi-chain verifier is the fix. **Lesson baked in:**
any new smart-account kind on a new chain must be added to the verifier's candidate set.

## Account recovery & fund safety (post-buildathon — in development)

> **Not part of the buildathon submission.** This work started *after* submission and is in active
> development — it is **not yet funds-safe**. It is documented here only for completeness of the
> passkey-wallet roadmap.

A passkey can be lost — so a smart wallet meant to hold funds needs recovery that **doesn't** reintroduce
a seed phrase or a custodian. The approach being built is **guardian-gated signer rotation that
preserves the account address**, plus an escape hatch:

- **Setup ("Protect your account").** The user picks a **backup wallet** as guardian. One sudo
  (passkey) userOp installs a recovery **action** (an ERC-7579 fallback module) + a **caller hook**
  pinning the guardian's address. The guardian is itself a deterministic weighted-ECDSA Kernel — v1 =
  a single backup (1-of-1); **social M-of-N** reuses the exact same shape (more signers + a higher
  threshold), no rewrite. Sponsored; no server secret.
- **POD escrow, sealed first.** Recovering *funds* alone wouldn't restore tickets or dashboard
  decryption — those hang off the POD ed25519 identity keyed to the lost passkey. So setup also seals
  the **POD seed to the guardian's derived X25519 key (HPKE + XChaCha20)** and runs a **determinism self-check**
  (re-derive the guardian key from a second signature, confirm the bundle reopens to the exact seed)
  *before* the irreversible on-chain install — a non-reproducible backup signature fails loudly at
  setup, not silently at recovery time.
- **Recovery (new device, portal).** With only the backup wallet + the lost account's address: mint a
  fresh passkey → the guardian calls `doRecovery`, **rotating the deployed Kernel's sudo owner** to the
  new passkey → rebuild the Kernel **at the original address** (CREATE2 address override) so **funds +
  on-chain identity are intact** → decrypt the escrow and **re-store the original POD seed** under the
  new identity so tickets + decryption survive → log in. Guardians can **only rotate the signer, never
  spend**.
- **Escape hatch.** `sweepToExternal` sweeps native ETH + listed ERC-20s to a self-custodied address
  while the passkey still works — funds are never structurally trapped, independent of whether recovery
  was configured.

**State:** the rotation mechanism is **verified on-chain on Arb Sepolia** via a spike
(`recovery-spike-caller-hook.ts` — rotate succeeded, address preserved, old key retired); the in-app
setup + recover-and-rekey portal are **wired** (`AccountRecoverySetup.svelte` / `AccountRecoverPortal.svelte`,
`auth.recoverAndRekey`). The remaining gate before it is funds-safe is a **live in-browser end-to-end
test by the owner**. Design detail: [`PASSKEY_RECOVERY_PLAN.md`](./PASSKEY_RECOVERY_PLAN.md).

## Evidence it works end-to-end

- **Gasless, on-chain (Arbitrum Sepolia).** The same Kernel + scoped-session-key rail attests
  [EAS likes/follows](./EAS_SOCIAL_GRAPH.md) with **the user's own Kernel as the attester** — attest +
  revoke verified on-chain on 2026-06-11 (tx hashes in that doc) — and settles the bounded,
  non-custodial [agent-commerce USDC draw](./WOCO_AGENT_ARCHITECTURE.md)
  ([draw tx](https://sepolia.arbiscan.io/tx/0x0e8e688ffdc0e3d686b35beb36eae72f3b8b0d964c9744992be107941c0c44f1)).
  These are the on-chain proof the passkey Kernel + gasless session keys work end-to-end.
- **Gasless sub-ENS claim** — `registerWithPermit` from the scoped session key against a server-signed
  permit — was **built during the buildathon** and verified in development on Arb Sepolia: passkey
  login → Kernel address → one ceremony mints the session key → a gasless userOp lands and
  `label.woco.eth` resolves. Same rail the likes above prove on-chain.

## Roadmap — Option 2 (native passkey-validator)

Move the signer fully on-chain: `@zerodev/passkey-validator` verifies the passkey's **P-256** key
on-chain, so the signing key **never exists in JS** (hardware/enclave-bound) and XSS cannot exfiltrate
it. The swap is cheap **because of Option 1's design**: the sudo signer sits behind a pluggable
`KernelSudoValidator` interface (replace `signerToEcdsaValidator` with `toPasskeyValidator` in one
module), and POD already lives on an independent PRF path so it survives untouched. It is deferred
because it needs a WebAuthn passkey server and a carefully-designed separate PRF ceremony for POD.

## On-chain / config anchors (Arbitrum Sepolia `421614`)

| What | Value |
|---|---|
| Kernel version / EntryPoint | `KERNEL_V3_1` (stable) · EntryPoint **0.7** |
| Sub-ENS `WoCoRegistrar` (session-key call target) | `0x7c0DE55a1713e6C1a53Db50314C7CB608179aAf1` |
| Sub-ENS L2Registry (Durin) | `0x41Fb196Ae7D65E06880A240c8d1B91245Fb84807` |
| EAS (likes/follows call target) | `0x2521021fc8BF070473E1e1801D3c7B4aB701E1dE` |
| Recovery action (ERC-7579 fallback module, singleton) | `0xe884C2868CC82c16177eC73a93f7D9E6F3A5DC6E` |
| Recovery caller hook (singleton) | `0x990a9FC8189D96d59E3cE98bd87F42135a24a30E` |
| Agent-commerce draw (Kernel spend permission, verified) | [`0x0e8e688f…c0c44f1`](https://sepolia.arbiscan.io/tx/0x0e8e688ffdc0e3d686b35beb36eae72f3b8b0d964c9744992be107941c0c44f1) |

SDK: `@zerodev/sdk`, `@zerodev/ecdsa-validator`, `@zerodev/permissions`, `viem` — all lazy-loaded out
of the main chunk. Wallet layer lives in `apps/web/src/lib/auth/kernel-account.ts`; server verifier in
`apps/server/src/lib/auth/verify-delegation.ts` (+ `smart-wallet-client.ts`).

## Honest state

- **Arbitrum Sepolia (testnet).** Go-live is largely a config swap.
- **Option 1 (PRF-derived key) is built and on-chain-verified** (frontend Swarm deploy pending, like
  the other rails); Option 2 (native P-256, key never in JS) is the documented hardening step, not yet
  built.
- The gasless rails are **proven on-chain end-to-end** by the EAS likes (attester = Kernel) and the
  agent draw; the sub-ENS gasless claim was verified in development. The frontend like/following UI's
  Swarm deploy is pending. Before mainnet, scope the paymaster gas policy to our contracts only
  (mirrors the on-chain session-key `toCallPolicy`) so the public RPC can't drain the gas tank.
- **Live workaround:** during a June 2026 ZeroDev RPC incident the bundler intermittently returned a
  stub `verificationGasLimit` it then rejected; `sendSessionUserOp` retries with an explicit 3M limit
  (sized for a first-userOp deploy + enable-mode validation), and the paymaster signs the op actually
  sent, so sponsorship stays valid.
