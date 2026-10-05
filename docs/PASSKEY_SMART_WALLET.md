> Overview: [ARCHITECTURE.md](./ARCHITECTURE.md) · Keys: [IDENTITY_AND_KEYS.md](./IDENTITY_AND_KEYS.md) ·
> Addresses: [DEPLOYMENTS.md](./DEPLOYMENTS.md) · Recovery: [PASSKEY_RECOVERY_PLAN.md](./PASSKEY_RECOVERY_PLAN.md)

# Passkey Smart Wallet — ZeroDev Kernel on Arbitrum

A seedless **ERC-4337 smart account** that a user gets just by logging in with a **passkey**
(email logins through Web3Auth get one too). A **ZeroDev Kernel** on **Arbitrum One (`42161`)**.
It underlies account recovery, passkey co-owners and the bounded
[agent-commerce draw](./WOCO_AGENT_ARCHITECTURE.md) (off, `agentCommerceAllowed = false`).
Names and likes do not run through it any more - see below.

## Current state (2026-10-05)

- **Chain.** Kernel v3.1, EntryPoint 0.7, on Arbitrum One - `KERNEL_CHAIN_ID` in
  `packages/shared/src/kernel/chain.ts` (#489). Moved off Arbitrum Sepolia so a name holder
  answers ERC-1271 on the chain the sub-ENS registry asks on.
- **Owner key.** With one passkey the owner is `keccak256(PRF output)` - a secp256k1 key, frozen -
  on ZeroDev's ECDSAValidator, the Kernel root (`apps/web/src/lib/auth/passkey-account.ts`,
  `kernel-account.ts`).
- **Every passkey a co-owner (#746, #770, #771).** Adding a second passkey moves the root to
  ZeroDev's WeightedECDSAValidator in ONE sponsored batch: one signer per passkey, weight 1,
  threshold 1, so any passkey signs alone and nothing moves between devices. "Make main" is gone.
  Constants: `packages/shared/src/kernel/co-owners.ts`. Detail and the rules that keep an account
  from locking itself: IDENTITY_AND_KEYS, "More than one passkey".
- **The identity seed is not the owner key.** A passkey account's seed is HKDF of the PRF output
  (#724, `packages/shared/src/crypto/passkey-prf.ts`, labels frozen). No secp256k1 key and no
  Kernel signature sits between the authenticator and the seed. The seed is locked at rest under
  a PRF-derived key; an unlock lasts 2 h (`SEED_UNLOCK_POLICY`,
  `apps/web/src/lib/auth/seed-unlock-policy.ts`).
- **HTTP sessions.** The raw owner key signs `AuthorizeSession` with `parent` = the Kernel. The
  server admits it when that key owns the Kernel: its counterfactual CREATE2 address, the onchain
  ECDSA owner, or a key on the weighted list (`apps/server/src/lib/auth/kernel-owner.ts`).
  ERC-1271/6492 verification remains for Coinbase Smart Wallet (off) and older delegations.
- **No scoped session keys.** None survives on a device. The sub-ENS key went when every name
  became a sponsor-wallet mint (#501); the EAS key went with EAS (#475, #476). The permission
  machinery remains only for the shop spend permission (off, `shopAllowed = false`).
- **What the Kernel sends.** Only WoCo's own userOp shapes: recovery route install and removal,
  guardian edits, a guardian's recovery, the co-owner switch and `renew`. Each is paid by WoCo's
  self-funded paymaster only after our server's ZeroDev policy webhook approves it (#758, #766,
  #769; `apps/server/src/lib/zerodev/sponsor-policy.ts`). The policy checks the call shape, that
  the account is unlocked, and a per-op cost ceiling.
- **Devices.** Added passkeys carry signed device grants (#751, `apps/server/src/lib/auth/device-grants.ts`).
  "Your passkeys" adds and removes them (#759). Another device links by code through a sealed
  mailbox (#761-#763, `apps/web/src/lib/auth/pairing-channel.ts`). Organising needs a passkey
  account (#768).
- **Recovery.** Passkey accounts back up by linking a device, not by email or wallet (#767).
  Email-login accounts add guardians; a guardian rotates the owner through `WoCoGuardianHook`.
  See PASSKEY_RECOVERY_PLAN, "Current state".
- **Not built.** Option 2, the native P-256 validator (signing key never in JS).

Everything below the anchors table is the 2026-06 design and its history. Where it disagrees with
the list above, the list wins. Older text says POD for what is now the identity seed and objects
(formerly called POD; renamed object, 2026-09-10).

## Anchors (Arbitrum One `42161`)

Pinned in `packages/shared/src/kernel/`. Sub-ENS addresses: `packages/shared/src/sub-ens/addresses.ts`.

| What | Value |
|---|---|
| Kernel version / EntryPoint | `KERNEL_V3_1` · EntryPoint 0.7 `0x0000000071727De22E5E9d8BAf0edAc6f37da032` |
| ECDSAValidator (root with one passkey) | `0x845ADb2C711129d4f3966735eD98a9F09fC4cE57` |
| WeightedECDSAValidator (root once co-owned) | `0xeD89244160CfE273800B58b1B534031699dFeEEE` |
| WoCoGuardianHook (also on Arb Sepolia, same address) | `0xF43524473EBC651969BeCc748462ED27ed39d4Db` |
| ZeroDev caller hook (pre-#164 routes: recognised, never installed again) | `0x990a9FC8189D96d59E3cE98bd87F42135a24a30E` |
| ZeroDev recovery action (ERC-7579 fallback module) | `0xe884C2868CC82c16177eC73a93f7D9E6F3A5DC6E` |
| WoCo self-funded paymaster | `0xc99c11AD232a24e1158156b1F46495Cc8069c08f` |

SDK: `@zerodev/sdk`, `@zerodev/ecdsa-validator`, `@zerodev/weighted-ecdsa-validator`,
`@zerodev/permissions`, `viem` - all lazy-loaded out of the main chunk. Wallet layer:
`apps/web/src/lib/auth/kernel-account.ts`. Server: `apps/server/src/lib/auth/kernel-owner.ts`,
`verify-delegation.ts`, `smart-wallet-client.ts`.

---

## History - the 2026-06 design

### What it is (one line)

A ZeroDev **Kernel** whose **sudo signer** is a secp256k1 key **derived from the passkey's PRF
extension**, wrapped by `@zerodev/ecdsa-validator`; day-to-day actions are signed by **scoped on-chain
session keys** (`@zerodev/permissions`) and sent **gasless** via a ZeroDev paymaster. No seed phrase,
no second custody stack — the primitive we already run *is* the wallet (and, scoped differently, the
agent and shop spend-permission rails).

Now: the sudo signer is unchanged for a one-passkey account; co-owned accounts use the weighted
root; the scoped session keys are retired (see "Current state").

### Why a derived key, and not native P-256 (the honest design call)

There are two ways to back a passkey smart account:

| | **Option 1 — ECDSA-over-PRF (built)** | **Option 2 — native passkey-validator (roadmap)** |
|---|---|---|
| Signer | secp256k1 derived from passkey PRF | P-256 verified **on-chain**, key never in JS |
| Extra infra | none | requires a WebAuthn passkey server |
| POD identity | stays deterministic (see below) | needs a separate PRF-only ceremony |
| Security | no regression vs today's passkey login | XSS cannot exfiltrate the signer |

We built **Option 1** because it delivers the full story — Kernel + scoped
session keys + gasless paymaster + Arbitrum-native + passkey login — with **maximum reuse and zero
security regression** vs the passkey login we already ran (the PRF key already lived in JS memory;
Option 1 keeps exactly that and *adds* session-key isolation). Option 2 is a real hardening upgrade
but adds a passkey-server dependency and breaks deterministic POD, so it is a **localized validator
swap**, parked - see [Roadmap](#roadmap--option-2-native-passkey-validator).

Now: the "POD identity" row is out of date. Since #724 the seed is HKDF of the PRF output, not a
signature by the owner key, so it does not depend on which validator signs userOps.

### Scoped session keys - retired

Retired: no device-resident scoped key survives (#501, #475, #476). Kept as a record.

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

> **Honest note (gas policy):** `enforcePaymaster` was intentionally *not* set on these keys —
> ZeroDev's sponsor call simulates validation *before* attaching its paymaster, so enforcing it there
> tripped `PolicyFailed`.

The **same Kernel**, with a delegated empty-account spender plus an `EQUAL`-recipient + per-draw-
ceiling call policy and a rate-limit policy, also backs the capped, non-custodial **spend-permission
rails** for the [shop](./SHOP_AND_LOYALTY.md) and [agent commerce](./WOCO_AGENT_ARCHITECTURE.md).
(Still in the code, both off.)

### Two different "session" concepts — never conflated

| Layer | What | Signs | Status (2026-10-05) |
|---|---|---|---|
| HTTP auth | **session delegation** (EIP-712 `AuthorizeSession`) | authenticates requests to our server | live |
| Onchain AA | userOps signed by the Kernel root (owner key, or one co-owner) | recovery and co-owner changes | live, sponsored by policy |
| Onchain AA | **ZeroDev session key** (`toPermissionValidator`) | routine userOps, no re-prompt | retired |

They are independent. In 2026-06 the **Kernel** signed the HTTP `AuthorizeSession` as an
ERC-1271/6492 signature. Since the 2026-07 owner-key fix the raw owner key signs it and the server
checks that key owns the Kernel (`kernel-owner.ts`).

### POD identity stays independent of the wallet (the load-bearing invariant)

Now: the invariant holds, by a different route. The seed is HKDF of the PRF output (#724), and
an email account's seed is keccak256 of one deterministic EIP-712 signature - never a Kernel
signature. The 2026-06 text:

WoCo's POD identity (ed25519 — encryption + ticket signing) **must be deterministic**. So the POD seed
is derived from a signature by the **raw PRF secp256k1 key** (ethers `Wallet`, RFC-6979 →
deterministic) with a **fixed address field = the PRF-EOA address** — *never* from a Kernel/smart-
account signature (those are non-deterministic and would corrupt the user's encryption + ticket
identity). The PRF-EOA address is persisted so POD restores without a biometric prompt and never sees
the Kernel address. This keeps POD stable across the future Option 2 swap.

### Server-side: multi-chain signature verification

The server verifies ERC-1271 / ERC-6492 signatures with viem's universal validator **across every
smart-account home chain**: Base for the
[Coinbase Smart Wallet](./ONCHAIN_TICKETING.md#3-coinbase-smart-wallet-login), and the Kernel's
own chain (`KERNEL_CHAIN_ID`). A single-chain pin once 403'd every passkey request because a
counterfactual 6492 sig only validates on its own chain. **Lesson baked in:** any new
smart-account kind on a new chain must be added to the verifier's candidate set. Kernel sessions
no longer depend on this path (see the table above).

### Account recovery & fund safety (2026-06, superseded)

Superseded by PASSKEY_RECOVERY_PLAN "Current state". `sweepToExternal` was deleted with zero
callers (#166.2). The guardian hook is now `WoCoGuardianHook` (#164) and the escrow wraps with
X-Wing (#642). Kept as a record:

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

**State (2026-06):** the rotation mechanism was **verified on-chain on Arb Sepolia** via a spike
(`recovery-spike-caller-hook.ts` — rotate succeeded, address preserved, old key retired); the in-app
setup + recover-and-rekey portal were **wired** (`AccountRecoverySetup.svelte` / `AccountRecoverPortal.svelte`,
`auth.recoverAndRekey`).

### Evidence it worked end-to-end (2026-06, Arbitrum Sepolia)

Both rails below were later removed (EAS #475/#476; gasless name claims #501). Kept as a record.

- **Gasless, on-chain (Arbitrum Sepolia).** The same Kernel + scoped-session-key rail attested
  likes/follows on EAS with **the user's own Kernel as the attester** — attest +
  revoke verified on-chain on 2026-06-11 — and settled the bounded,
  non-custodial [agent-commerce USDC draw](./WOCO_AGENT_ARCHITECTURE.md)
  ([draw tx](https://sepolia.arbiscan.io/tx/0x0e8e688ffdc0e3d686b35beb36eae72f3b8b0d964c9744992be107941c0c44f1)).
- **Gasless sub-ENS claim** — `registerWithPermit` from the scoped session key against a server-signed
  permit — verified in development on Arb Sepolia: passkey
  login → Kernel address → one ceremony mints the session key → a gasless userOp lands and
  `label.woco.eth` resolves.

Arbitrum Sepolia anchors of that period: sub-ENS `WoCoRegistrar` `0x42c6464d65e79C4735A0b346d1c1b4690586d6F9`,
L2Registry `0xC38e08CB5a21B083F63149ea7597Ea8D05017cf8`, EAS `0x2521021fc8BF070473E1e1801D3c7B4aB701E1dE`.

### Roadmap — Option 2 (native passkey-validator)

Move the signer fully on-chain: `@zerodev/passkey-validator` verifies the passkey's **P-256** key
on-chain, so the signing key **never exists in JS** (hardware/enclave-bound) and XSS cannot exfiltrate
it. The swap is meant to be cheap: the sudo signer sits behind a pluggable `KernelSudoValidator`
interface in `kernel-account.ts`, and the identity seed already comes from the PRF output rather
than the owner key. It is deferred because it needs a WebAuthn passkey server. Not re-checked
against the co-owner (weighted) root.

### Workaround of record

During a June 2026 ZeroDev RPC incident the bundler intermittently returned a stub
`verificationGasLimit` it then rejected; the send path retried with an explicit 3M limit (sized
for a first-userOp deploy + enable-mode validation), and the paymaster signed the op actually
sent, so sponsorship stayed valid.
