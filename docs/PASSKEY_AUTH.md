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
   (deterministic from passkey + RP ID + salt)
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

1. **User authenticates** — discoverable `navigator.credentials.get()` shows a
   passkey picker (no stored credential ID required). Falls back to creating a
   new passkey if none exist for the RP.
2. **PRF extension** returns a deterministic 32-byte secret derived from:
   - The passkey's internal secret
   - The **RP ID** (`woco.eth.limo` in production — shared across all ENS subdomains)
   - A fixed application salt: `SHA-256("woco-passkey-secp256k1-v1")`
3. **Key derivation**: `keccak256(prfOutput)` produces a valid secp256k1 private key.
4. **Ethereum address** is computed from the public key (standard `ethers.Wallet`).
5. **Session delegation** uses the derived key to sign EIP-712 typed data — identical
   to how wallet and local accounts work. The server cannot tell the difference.

## Key Properties

| Property | Detail |
|---|---|
| **Deterministic** | Same passkey + same RP ID + same salt = same Ethereum address, always |
| **No storage of secrets** | Private key exists only in memory during the session |
| **Cross-device sync** | Passkeys sync via iCloud Keychain, Google Password Manager, 1Password, etc. |
| **Biometric consent** | Every key derivation requires fingerprint/face/PIN |
| **Shared RP ID** | RP ID hardcoded to `woco.eth.limo` so all ENS subdomains (e.g. `org1.woco.eth.limo`) produce the same address |
| **Zero server changes** | Server sees standard EIP-712 signatures — signer-agnostic |
| **EIP-712 confirmation** | All EIP-712 signing shows a confirmation dialog — passkey users see what they're signing, same as local accounts |

## RP ID Strategy

The RP ID is the WebAuthn "relying party" identifier — it determines which passkeys
are visible and what PRF output is produced. Using `window.location.hostname` would
produce different Ethereum addresses on different domains, making identity unstable.

**Solution:** The RP ID is hardcoded to `woco.eth.limo` for any page on that domain
or its subdomains. Falls back to `window.location.hostname` for local development.

```typescript
function getPasskeyRpId(): string {
  const hostname = window.location.hostname;
  if (hostname === "woco.eth.limo" || hostname.endsWith(".woco.eth.limo")) {
    return "woco.eth.limo";
  }
  return hostname; // localhost dev fallback
}
```

This means:
- `woco.eth.limo` (main app) → RP ID = `woco.eth.limo`
- `org1.woco.eth.limo` (future ENS subdomain embed) → RP ID = `woco.eth.limo`
- `localhost` (dev) → RP ID = `localhost` (separate identity, expected)

**Result:** One passkey produces one stable Ethereum address across the main app and
all future ENS subdomain embeds. This is the foundation for the planned iframe embed
approach (see Embed Widget section in TECHNICAL_ARCHITECTURE.md).

**Important:** Passkeys are not portable across unrelated domains. The embed web
component running on an organizer's external site (e.g. `tickets.example.com`)
produces a different address — this is a browser security boundary. The iframe
embed approach (planned) solves this by loading the widget from a `woco.eth.limo`
subdomain.

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
User clicks "Create / Sign in with Passkey"
  → navigator.credentials.get() — discoverable mode (no allowCredentials)
  → Passkey picker shown — user selects their passkey
  → If no passkeys exist for this RP → falls back to navigator.credentials.create()
  → Biometric prompt (fingerprint/face/PIN)
  → PRF returns 32-byte secret
  → keccak256(secret) → private key → address
  → Store credential metadata + address in IndexedDB
  → User is "connected" (passkey badge + address shown)
```

### Returning User (Restore via picker)

```
User clicks "Sign in with Passkey"
  → navigator.credentials.get() — discoverable mode shows passkey picker
  → User selects existing WoCo passkey
  → Biometric prompt
  → Same PRF output → same private key → same address
  → User is connected with identical account
```

### Page Reload (Deferred / Silent)

```
Page loads → init() reads kind="passkey" + address from IndexedDB
  → User appears connected immediately (no biometric needed)
  → Existing session key (from encrypted IndexedDB) still works
  → Biometric only re-triggers when session expires and
    ensureSession() needs to create a new EIP-712 delegation
```

### Session Delegation (Deferred EIP-712)

```
User triggers action requiring auth (publish, claim, view tickets)
  → ensureSession() checks for existing valid delegation
  → If none: calls passkey signer → shows EIP-712 confirmation dialog
  → User reviews what they are signing, clicks "Sign"
  → Passkey biometric prompt
  → PRF derives key → signs EIP-712 AuthorizeSession
  → Delegation cached in IndexedDB (valid 1 year)
```

The passkey signer shows the same confirmation dialog as the local account signer —
users can always see what they are signing before approving.

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

## Embed Widget Passkey Claims

The embed widget (`<woco-tickets>`) supports passkey claims using a lightweight
implementation that avoids the ethers.js dependency:

- **Library**: `@noble/curves/secp256k1` + `@noble/hashes/sha3` (already bundled)
- **Signing**: EIP-191 `personal_sign` (not full EIP-712 session delegation)
- **Server verification**: `ethers.verifyMessage()` recovers address, compares to claimed address
- **Signature freshness**: 5-minute window (`PASSKEY_CLAIM_MAX_AGE_MS = 300_000`)
- **Message format**: `woco:claim:{eventId}:{seriesId}:{timestamp}`
- **Storage**: Credential metadata stored in `localStorage` (not IndexedDB)

The RP ID logic is identical — `woco.eth.limo` in production, hostname in dev.
On an organizer's external site the RP ID will be their domain, producing a
different address. The planned iframe embed approach solves this.

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

### Domain changes

The RP ID is hardcoded to `woco.eth.limo`. If WoCo moves to a different domain
and changes the RP ID, existing passkeys will produce different addresses on the
new RP ID. The ENS domain is chosen as the permanent RP ID precisely because ENS
names are long-lived and not tied to infrastructure (DNS, hosting, etc.).

### No new dependencies (main app)

The implementation uses only built-in browser APIs and existing project
dependencies:

- `navigator.credentials` — WebAuthn (built-in)
- `crypto.subtle` — SHA-256 for salt (built-in)
- `ethers` — keccak256, Wallet, signTypedData (existing)
- IndexedDB — credential metadata storage (existing wrapper)

### Embed widget adds (~35KB)

- `@noble/curves/secp256k1` — EIP-191 signing without ethers
- `@noble/hashes/sha3` — keccak256 without ethers

## Server Compatibility

The server's `verifyDelegation()` function uses `ethers.verifyTypedData()` to
check EIP-712 session delegation signatures. It recovers the signer address from
the signature and verifies it matches the claimed parent address. This process is
completely agnostic to how the private key was obtained — whether from MetaMask,
a local keypair, or a passkey PRF derivation.

For embed passkey claims, the server uses `ethers.verifyMessage()` (EIP-191) in
the claims route — a lighter verification path that doesn't require full session
delegation.

## Files

| File | Role |
|---|---|
| `packages/shared/src/auth/types.ts` | `AuthKind` union includes `"passkey"` |
| `packages/shared/src/auth/constants.ts` | Storage keys, PRF salt, `PASSKEY_CLAIM_MAX_AGE_MS`, `PASSKEY_CLAIM_PREFIX` |
| `apps/web/src/lib/auth/webauthn-prf.d.ts` | TypeScript type augmentation for PRF extension |
| `apps/web/src/lib/auth/passkey-account.ts` | Core: `authenticatePasskey()` (discoverable picker), `createPasskeyAccount()`, `restorePasskeyAccount()`, `getPasskeyRpId()` |
| `apps/web/src/lib/auth/signers/passkey-signer.ts` | EIP-712 signer — shows confirmation dialog before signing |
| `apps/web/src/lib/auth/auth-store.svelte.ts` | State machine: passkey branches, calls `authenticatePasskey()` |
| `apps/web/src/lib/components/auth/PasskeyLogin.svelte` | UI with provider logos |
| `apps/web/src/lib/components/auth/LoginModal.svelte` | Integrates PasskeyLogin |
| `apps/web/src/lib/components/auth/SessionStatus.svelte` | "passkey" badge label |
| `packages/embed/src/auth/webauthn-prf.d.ts` | PRF type augmentation for embed bundle |
| `packages/embed/src/auth/passkey.ts` | Embed passkey: `passkeyAuthenticate()`, `signClaimMessage()`, `getPasskeyRpId()` |
