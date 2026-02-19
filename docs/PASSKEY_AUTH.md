# Passkey Authentication — Technical Overview

WoCo supports passkey-based authentication using the **WebAuthn PRF extension**
to deterministically derive an Ethereum (secp256k1) private key from a passkey.
This gives users a full crypto account with no seed phrases, no browser
extensions, and automatic cross-device sync via their existing password manager.

## How It Works

```
   Passkey (biometric)
         │
         ▼
   PRF extension returns 32 bytes
   (deterministic from passkey + salt)
         │
         ▼
   keccak256(prfOutput) → secp256k1 private key
         │
         ▼
   Ethereum address (standard derivation)
         │
         ▼
   EIP-712 session delegation (same as wallet/local)
```

1. **User creates a passkey** — standard WebAuthn `navigator.credentials.create()`
   with the PRF extension enabled.
2. **PRF extension** returns a deterministic 32-byte secret derived from:
   - The passkey's internal secret
   - A fixed application salt: `SHA-256("woco-passkey-secp256k1-v1")`
3. **Key derivation**: `keccak256(prfOutput)` produces a valid secp256k1 private key.
4. **Ethereum address** is computed from the public key (standard `ethers.Wallet`).
5. **Session delegation** uses the derived key to sign EIP-712 typed data — identical
   to how wallet and local accounts work. The server cannot tell the difference.

## Key Properties

| Property | Detail |
|---|---|
| **Deterministic** | Same passkey + same salt = same Ethereum address, always |
| **No storage of secrets** | Private key exists only in memory during the session |
| **Cross-device sync** | Passkeys sync via iCloud Keychain, Google Password Manager, 1Password, etc. |
| **Biometric consent** | Every key derivation requires fingerprint/face/PIN |
| **Domain-bound** | Passkeys are scoped to the RP ID (`gateway.woco-net.com`) |
| **Zero server changes** | Server sees standard EIP-712 signatures — signer-agnostic |

## What Gets Stored

### In IndexedDB (not secret)

| Key | Value | Purpose |
|---|---|---|
| `woco:auth:passkey-credential` | `{ credentialId, rpId }` | Identifies which passkey to use on restore |
| `woco:auth:kind` | `"passkey"` | Remembers auth method across page loads |
| `woco:auth:parent` | `"0x..."` | Ethereum address for UI display on reload |

### In Memory Only (never persisted)

| Value | Lifetime |
|---|---|
| secp256k1 private key | Cleared on logout or page close |

The credential ID is a public identifier (like a username) — it tells the browser
which passkey to prompt for. It cannot be used to derive the private key.

## Authentication Flow

### First Time (Create)

```
User clicks "Create Passkey Account"
  → navigator.credentials.create() with PRF extension
  → Biometric prompt (fingerprint/face/PIN)
  → PRF returns 32-byte secret
  → keccak256(secret) → private key → address
  → Store credential metadata + address in IndexedDB
  → User is "connected" (passkey badge + address shown)
```

### Returning User (Restore)

```
User clicks "Sign in with Passkey"
  → navigator.credentials.get() with stored credential ID + PRF
  → Biometric prompt
  → Same PRF output → same private key → same address
  → User is connected with identical account
```

### Page Reload (Deferred)

```
Page loads → init() reads kind="passkey" + address from IndexedDB
  → User appears connected immediately (no biometric needed)
  → Existing session key (from encrypted IndexedDB) still works
  → Biometric only re-triggers when session expires and
    ensureSession() needs to create a new EIP-712 delegation
```

## PRF Extension

The **PRF (Pseudo-Random Function)** extension is a WebAuthn Level 3 feature that
turns a passkey into a deterministic key derivation device. Given the same
credential and the same salt input, it always produces the same output.

- **Input salt**: `SHA-256("woco-passkey-secp256k1-v1")` — fixed per application
- **Output**: 32 bytes (256 bits) — sufficient entropy for secp256k1
- **Computation**: Happens inside the authenticator (TPM/Secure Enclave/cloud)
- **Supported by**: Chrome 132+, Safari 18+, most modern password managers

When PRF is not supported, the passkey option hides itself and the user falls
back to wallet authentication.

## Security Model

### What protects the private key?

The private key is never stored anywhere. It is re-derived from the passkey
each time via biometric authentication. An attacker would need:

1. **Physical access** to a device with the synced passkey, AND
2. **Biometric authentication** (fingerprint, face, or device PIN)

This is equivalent to the security of the passkey provider (iCloud Keychain,
Google Password Manager, 1Password, etc.).

### What if the passkey is deleted?

The Ethereum private key is **permanently lost**. There is no recovery mechanism.
This is the same as deleting a wallet's seed phrase. Users should:

- Ensure their passkey provider syncs across devices
- Consider also connecting a hardware wallet for high-value accounts

### What about domain changes?

Passkeys are bound to the **RP ID** (relying party identifier), which is the
domain hostname. If WoCo moves to a different domain, existing passkeys will
not work on the new domain. The PRF output is domain-specific.

Current RP ID: `gateway.woco-net.com`

### No new dependencies

The implementation uses only built-in browser APIs and existing project
dependencies:

- `navigator.credentials` — WebAuthn (built-in)
- `crypto.subtle` — SHA-256 for salt (built-in)
- `ethers` — keccak256, Wallet, signTypedData (existing)
- IndexedDB — credential metadata storage (existing wrapper)

## Server Compatibility

The server's `verifyDelegation()` function uses `ethers.verifyTypedData()` to
check EIP-712 session delegation signatures. It recovers the signer address from
the signature and verifies it matches the claimed parent address. This process is
completely agnostic to how the private key was obtained — whether from MetaMask,
a local keypair, or a passkey PRF derivation.

**No server code changes were required.**

## Files

| File | Role |
|---|---|
| `packages/shared/src/auth/types.ts` | `AuthKind` union includes `"passkey"` |
| `packages/shared/src/auth/constants.ts` | Storage key + PRF salt constant |
| `apps/web/src/lib/auth/webauthn-prf.d.ts` | TypeScript type augmentation for PRF |
| `apps/web/src/lib/auth/passkey-account.ts` | Core: create, restore, clear, detect |
| `apps/web/src/lib/auth/signers/passkey-signer.ts` | EIP-712 signer (no confirm dialog) |
| `apps/web/src/lib/auth/auth-store.svelte.ts` | State machine: passkey branches |
| `apps/web/src/lib/components/auth/PasskeyLogin.svelte` | UI with provider logos |
| `apps/web/src/lib/components/auth/LoginModal.svelte` | Integrates PasskeyLogin |
| `apps/web/src/lib/components/auth/SessionStatus.svelte` | "passkey" badge label |
