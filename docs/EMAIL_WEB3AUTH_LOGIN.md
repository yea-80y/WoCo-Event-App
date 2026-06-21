# Email / Web3Auth Login — Technical Overview

WoCo's "email / phone / social" sign-in is backed by **Web3Auth PnP (Plug-and-Play)**.
It replaced the earlier Para integration (`para-account.ts` is gone; the `para`
auth-kind is removed — see the payout-gate note below). Auth kind: **`web3auth`**.

Code:
- `apps/web/src/lib/auth/web3auth-account.ts` — login / silent restore / logout
- `apps/web/src/lib/auth/web3auth-config.ts` — SDK options + `extractRawPrivateKey`
- `apps/web/src/lib/components/auth/Web3AuthLogin.svelte` — UI
- Gotchas already captured in memory: `project_web3auth_v10_gotchas`

## How it works

```
  Email / phone / social factor
          │  (Web3Auth MPC network shares + device share)
          ▼
  Web3Auth reconstructs a standard secp256k1 private key, client-side
          │  exposed via provider `private_key`
          ▼
  viem privateKeyToAccount(pk)  →  Ethereum EOA (this is `parent`)
          │
          ▼
  EIP-712 session delegation + POD identity (same path as a web3 wallet)
```

1. `loginWithWeb3Auth()` opens the PnP modal; on success returns `{ address, privateKey }`.
   The raw key is held **in memory only** for the session (`_web3authPrivateKey`).
2. Web3Auth's own `localStorage` keeps the session alive across reloads;
   `restoreWeb3AuthSession()` (called from `auth-store.init()`) silently rehydrates
   the key with no UI.
3. The reconstructed EOA is the `parent` identity. It is a **real, self-custodied
   EOA usable on any EVM chain** — there is no smart-account wrapper (unlike passkey).

## Identity layers for a `web3auth` user

| Layer | Value | Notes |
|---|---|---|
| Parent | the Web3Auth EOA address | permanent identity |
| Request signer | `createLocalSigner(_web3authPrivateKey, …)` | signs `AuthorizeSession` (EIP-712) + per-request canonical sig |
| POD signer | **same** as request signer (`_getPodSigner` falls through to `_getSigner`) | deterministic EIP-712, fixed nonce |
| POD address | = parent (the EOA) | encryption AAD key + POD ed25519 derivation |

POD derivation is the standard path (`pod-identity.ts`): a fixed-nonce EIP-712
message signed by the EOA → `keccak256(getBytes(signature))` → ed25519 seed.

## Why Web3Auth needs **no** WoCo guardian recovery

Web3Auth is itself a key-recovery system: the secp256k1 key is reconstructed from
MPC network shares + the user's auth factor (email/social), so the **same EOA is
reproduced on any device** the user logs into. Same EOA → same deterministic
EIP-712 signature → same POD seed → same encryption/ticket identity, everywhere,
with nothing escrowed by us.

Contrast:
- **web3 wallet** — cross-device by the user's own seed phrase / wallet.
- **web3auth (email)** — cross-device by Web3Auth's MPC reconstruction.
- **passkey** — cross-device by the password-manager-synced passkey **only while
  the original passkey is intact**; after WoCo guardian *recovery* the rotated
  account is currently single-device → see [`CROSS_DEVICE_RECOVERY.md`](./CROSS_DEVICE_RECOVERY.md).
- **local** — single-device (raw key in IndexedDB, never synced).

## Crypto payouts (organiser)

A `web3auth` user's parent **can receive and withdraw funds on any chain** (it's a
plain EOA), so it is a valid crypto-payout recipient. The organiser payout gate
(`TicketSeriesEditor.svelte`) historically allowed only `web3 || para`; since
`para` was removed this **wrongly blocked web3auth users**. Fixed: the gate now
allows every fund-capable kind — `web3`, `web3auth` (EOAs, no caveat) and
`passkey`, `coinbase` (smart accounts, with a one-time cross-chain-deploy caveat).
