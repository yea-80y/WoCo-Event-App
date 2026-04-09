# Cryptographic Security Audit -- WoCo Event Platform

**Date:** 2026-04-08
**Revision:** 2 (added findings 9.1-9.5 from second pass)
**Scope:** All cryptographic signing, key derivation, encryption, payment verification, and session management code.

---

## Executive Summary

The cryptographic architecture is **fundamentally sound**. The three-layer identity model (primary wallet -> session key -> POD/encryption keys) is well-conceived, library choices are strong (@noble/curves, ethers.js, Web Crypto API), and domain separation across EIP-712 signatures is correct.

**Critical issues** exist in the payment verification flow (txHash replay, insufficient confirmations) and the session authentication model (per-request signatures computed but never verified server-side). These must be fixed before scaling to production.

**21 findings total:** 2x P0, 5x P1, 6x P2, 8x P3.

---

## Findings

### 1. EIP-712 Session Delegation

**Files:** `apps/web/src/lib/auth/session-delegation.ts`, `apps/server/src/lib/auth/verify-delegation.ts`, `packages/shared/src/auth/eip712.ts`

#### What's good

- Random session key per delegation (`Wallet.createRandom()`)
- Session key signs proof-of-possession before delegation (`sessionProof`)
- Server verifies EIP-712 signature recovery matches claimed parent
- Host binding prevents cross-origin replay
- Local verification before storage (session-delegation.ts:65-73)
- Expiration and future-dating checks with 1-minute clock skew tolerance

#### FINDING 1.1: SESSION_DOMAIN lacks `salt` for app namespacing

**Severity: P2 (Medium)**

```ts
// packages/shared/src/auth/eip712.ts
export const SESSION_DOMAIN = {
  name: "WoCo Session",
  version: "1",
} as const;
```

Omitting `chainId` is acceptable for chain-agnostic session auth (host binding provides replay protection). However, omitting both `verifyingContract` and `salt` means any other app using the domain name "WoCo Session" could produce delegations that pass verification.

**Fix:** Add a `salt` field (random bytes32, hardcoded) to uniquely namespace WoCo's domain.

#### FINDING 1.2: sessionProof not verified server-side

**Severity: P2 (Medium-High)**

The session key signs `${host}:${nonce}` as proof-of-possession (session-delegation.ts:42), and this is included in the EIP-712 struct the parent signs. However, the server never independently verifies this proof -- it only verifies the parent's EIP-712 signature.

The proof-of-possession is validated *implicitly* because the parent signed the struct containing it, but there's no server enforcement that the `sessionProof` actually corresponds to the claimed `session` address. This closes a subtle attack vector where someone intercepts a delegation in-flight.

**Fix:** In `verifyDelegation()`, add: `verifyMessage("${message.host}:${message.nonce}", message.sessionProof) === message.session`.

#### FINDING 1.3: 1-year session expiry is excessive **Have we done this?

**Severity: P1 (Medium)**

```ts
// packages/shared/src/auth/constants.ts
export const SESSION_EXPIRY_MS = 365 * 24 * 60 * 60 * 1000;
```

A compromised session key (e.g., XSS extracting IndexedDB) gives an attacker a 1-year window to impersonate the user. The device key is non-extractable, but XSS running in the same origin CAN access IndexedDB and CAN use the CryptoKey handle to decrypt the session key via Web Crypto API. Industry standard for session tokens is hours to days.

**Fix:** Reduce to 7-30 days. Consider implementing session rotation where the server can signal the client to re-delegate.

#### FINDING 1.4: No server-side session revocation **is this decentrailsed?

**Severity: P1 (Medium)**

If a session key is compromised, there's no way to revoke it server-side. The only "revocation" is client-side `clearSession()`. An attacker with the session key and delegation can use it until expiry.

**Fix:** Implement a server-side revocation list (store nonce -> revoked, check in `verifyDelegation()`). Or allow users to invalidate all sessions by signing a new delegation with a "revoke all" purpose.

---

### 2. POD Identity Derivation (EIP-712 -> ed25519)

**Files:** `apps/web/src/lib/auth/pod-identity.ts`, `apps/web/src/lib/pod/keys.ts`

#### What's good

- Fixed nonce (`WOCO-POD-IDENTITY-V1`) ensures deterministic derivation
- Separate EIP-712 domain from session delegation (correct domain separation)
- @noble/ed25519 is a well-audited library

#### FINDING 2.1: Seed derived from string representation of signature **No users so its fine to do - is this just a more secure way for us to derive the ed25519 account?

**Severity: P3 (Low-Medium)**

```ts
// pod-identity.ts:40
const seed = keccak256(toUtf8Bytes(signature));
```

`signature` is a hex string (0x-prefixed, 130 chars). `toUtf8Bytes` encodes the *ASCII characters* of the hex string, not the raw 65 signature bytes. This is deterministic and high-entropy, so it works -- but it deviates from convention.

The standard approach: `keccak256(getBytes(signature))` -- hashing the raw 65 bytes.

**Note:** Changing this is a **breaking change** for existing users (their POD identity would change). Only fix if no users have derived POD identities yet, or plan a migration.

#### FINDING 2.2: ed25519 naming clarity **Have you fixed this? 

**Severity: P3 (Info)**

`seedToEd25519()` returns 32 bytes called `privateKey`, but in ed25519 terminology this is a *seed* (the private key is the 64-byte SHA-512 expansion). @noble/ed25519 handles this correctly internally, but the naming could cause interop confusion.

---

### 3. Encryption (ECIES: X25519 + HKDF + AES-GCM)

**Files:** `packages/shared/src/crypto/ecies.ts`, `packages/shared/src/crypto/keys.ts`, `packages/shared/src/crypto/constants.ts`

#### What's good -- this is well done

- HKDF-SHA256 with domain separation (`"woco/encryption/v1"`) to derive encryption key from POD seed
- Separate key for signing (ed25519) and encryption (X25519) -- correct practice
- Ephemeral ECDH per message (forward secrecy)
- AES-256-GCM via Web Crypto (hardware-accelerated, constant-time)
- HKDF salt = ephemeral public key (domain separation per message)
- ECIES_INFO = `"woco/order/v1"` for HKDF info string

#### FINDING 3.1: Empty salt in HKDF for key derivation from POD seed **What should we do here? what is domain seperation?

**Severity: P3 (Low)**

```ts
// crypto/keys.ts:74
const encSeed = hkdf(sha256, podSeed, new Uint8Array(0), "woco/encryption/v1", 32);
```

Empty salt is spec-compliant and secure. A non-empty fixed salt would provide slightly stronger domain separation. Not a vulnerability.

#### FINDING 3.2: ENCRYPTION_DOMAIN/TYPES are dead code **Did you remove?

**Severity: P3 (Info)**

`packages/shared/src/crypto/constants.ts` defines `ENCRYPTION_DOMAIN`, `ENCRYPTION_TYPES`, and `ENCRYPTION_NONCE` -- but these are never used anywhere. The encryption key is derived via HKDF from the POD seed (which is the better approach, avoiding an extra wallet popup). These unused constants should be removed.

---

### 4. Client-Side Key Storage

**Files:** `apps/web/src/lib/auth/storage/encryption.ts`, `apps/web/src/lib/auth/storage/indexeddb.ts`

#### What's good

- Device key is AES-256-GCM, non-extractable (`extractable: false`)
- Random 12-byte IV per encryption operation
- IndexedDB stores CryptoKey objects natively (key material never in JS heap)

#### FINDING 4.1: No authenticated data (AAD) in AES-GCM **Did you do this? Does this follow best practice and fundamentally secure?

**Severity: P3 (Low)**

AES-GCM supports Additional Authenticated Data (AAD) which can bind the ciphertext to a context. Using AAD with the storage key name (e.g., `"woco:auth:session-key"`) would prevent ciphertext substitution attacks where an attacker swaps encrypted blobs between storage keys.

**Fix:** Pass the storage key as `additionalData` in the encrypt/decrypt calls.

---

### 5. Payment Verification

**Files:** `apps/server/src/lib/payment/verify.ts`, `apps/server/src/routes/claims.ts`, `apps/server/src/lib/payment/constants.ts`

#### FINDING 5.1: CRITICAL -- No txHash uniqueness check (payment replay)

**Severity: P0 (Critical)**

The server verifies the transaction on-chain but **does not record which txHashes have already been used for claims**. An attacker could:

1. Make one legitimate payment
2. Submit the same txHash for multiple claim requests (different series, or for friends)

The server would verify the same on-chain transaction each time and approve each claim.

**Fix:** Maintain a server-side set of consumed txHashes (in-memory Set + optional persistent backing). Reject any txHash already used. Check *before* the claim queue to fail fast.

#### FINDING 5.2: CRITICAL -- MIN_CONFIRMATIONS = 1 is insufficient

**Severity: P0 (Critical)**

```ts
// apps/server/src/lib/payment/constants.ts:29
export const MIN_CONFIRMATIONS = 1;
```

A single confirmation is vulnerable to chain reorganisations. 1-block reorgs happen regularly on mainnet.

**Fix:**
- Mainnet ETH (1): 12 confirmations
- Base (8453): 3 confirmations
- Optimism (10): 3 confirmations
- Sepolia (11155111): 3 confirmations

Consider making this configurable per chain.

#### FINDING 5.3: Escrow contract -- no reentrancy guard

**Severity: P2 (Medium)**

`WoCoEscrow.sol` uses `.call{value: amount}("")` for ETH transfers. The contract does follow checks-effects-interactions pattern (zeroing balances before external calls), which mitigates reentrancy. However, the `release()` function makes *two* external calls (fee transfer then organiser transfer), and a malicious feeRecipient could theoretically interfere.

**Fix:** Add OpenZeppelin's `ReentrancyGuard` to `release()` and `resolveDispute()`. It's cheap insurance.

#### FINDING 5.4: No token array length limit in escrow **Did you do this? Even though its low impact do you not think we should do anyway, to stop any possible attack vector?

**Severity: P3 (Low)**

`release()` and `resolveDispute()` iterate over `tokens[]` with no length limit. A gas-exhaustion griefing attack is possible but low impact since organisers control their own release calls.

---

### 6. Passkey/Wallet-Signed Claims (EIP-191)

**Files:** `apps/server/src/routes/claims.ts:115-145`

#### What's good

- 5-minute signature expiry (`PASSKEY_CLAIM_MAX_AGE_MS = 300_000`)
- Message includes eventId + seriesId + timestamp (replay-resistant within window)
- Server recovers address from signature (never trusts client-supplied address)

#### FINDING 6.1: Message format uses `:` delimiter **What do you suggest is best here? JSON or ABI-encoded? Which is the most robust and best for us to scale with?

**Severity: P3 (Low)**

```ts
const message = PASSKEY_CLAIM_PREFIX + eventId + ":" + seriesId + ":" + timestamp;
```

If any field contained `:`, the message could be ambiguous. Since eventId and seriesId are hex and timestamp is a number, this is safe in practice. A JSON or ABI-encoded format would be more robust for future-proofing.

---

### 7. Email Claim Security

#### FINDING 7.1: In-memory rate limiting resets on restart **What do we do here? What is the decentralised approach?

**Severity: P2 (Medium)**

```ts
const emailClaimRateMap = new Map<string, number[]>();
```

Rate limiter state is lost on every server restart, allowing burst attacks after deploys.

**Fix:** Use a persistent store (file-backed, SQLite, or Redis) for rate limit state.

#### FINDING 7.2: IP-based rate limiting bypassable **How would proof-of-work work? I want to keep away from email verification - can SSO help here? 

**Severity: P2 (Medium)**

Rate limiting by `x-forwarded-for` is trivially bypassed with VPN/proxy rotation. For Devcon scale, additional protections are needed (email verification, proof-of-work challenge, CAPTCHA).

---

### 8. Mock Payment Page -- Dead Code with XSS

**Severity: P1 (to remove)**

**Files:** `apps/server/src/routes/claims.ts:315-601`

The mock payment page (`GET/POST mock-payment-page` and `mock-payment` routes) is **dead code**:
- No frontend component imports, links to, or references these endpoints
- No other server route calls them
- They are only reachable by manually constructing the URL
- CLAUDE.md build status already says "Mock payment page endpoints were built then removed" -- but the code was never actually deleted

The HTML generation has insufficient sanitisation (only escapes `"`, not `<>&'`), making it vulnerable to reflected XSS on the API domain.

**Fix:** Remove the entire mock payment page block (~290 lines from claims.ts).

---

### 9. Additional Findings (second-pass review)

#### FINDING 9.1: Per-request session signature computed but never verified **Did you do option A? You mention in your notes EIP-191 - what do you mean you mean here?

**Severity: P1 (High)**

**Files:** `apps/web/src/lib/auth/auth-store.svelte.ts:383-403`, `apps/web/src/lib/api/client.ts:30-49`, `apps/server/src/middleware/auth.ts`

The client signs every request body with the session key:

```ts
// auth-store.svelte.ts:396
const result = await signWithSession(payload);  // signs JSON.stringify(body) with session key
```

But the server's `requireAuth` middleware **only verifies the parent's EIP-712 delegation** -- it never checks the per-request session signature. The session signature is computed on the client, then discarded. The session address is sent as a plain string in the request body.

**Impact:** The delegation bundle is the entire authentication token. Anyone who observes one delegation (e.g., from a logged request, network intercept, or shared debug output) can make arbitrary authenticated requests for any endpoint and any request body until the session expires. The session key provides no additional security because its signatures are never verified.

**Fix:** Either:
- **(A) Verify session signatures server-side:** Add session signature verification to `requireAuth`. The client already sends `signed.sessionAddress` -- also send `signed.signature`, and verify `verifyMessage(bodyHash, signature) === sessionAddress` on the server. This makes the session key a real authentication factor.
- **(B) Remove the dead signing code:** If option A is too much churn, remove `signWithSession()`, `signRequest()`, and the payload signing from `authPost`/`authGet`. Document that the delegation bundle alone is the auth token. This is honest about the security model even if weaker.

Option A is strongly recommended.

#### FINDING 9.2: API key claim mode uses non-constant-time comparison **Did you do this? Will this then remove this risk?

**Severity: P1 (Medium-High)**

**File:** `apps/server/src/routes/claims.ts:148-151`

```ts
const apiKey = rawBody.apiKey as string;
const expected = process.env.ORGANIZER_API_KEY;
if (!expected || apiKey !== expected) {
  return c.json({ ok: false, error: "Invalid API key" }, 403);
}
```

JavaScript's `!==` is not guaranteed to be constant-time. For a shared secret comparison, this can leak the API key length and character-by-character match via timing side-channel. While exploiting this requires many requests and precise timing, it's a well-known vulnerability class.

**Fix:** Use `crypto.timingSafeEqual(Buffer.from(apiKey), Buffer.from(expected))` with a length check first (if lengths differ, reject immediately -- length is not secret for fixed-format keys).

#### FINDING 9.3: Email hashing uses unsalted SHA-256 **Will the legacy lookup not create potential dead code? The app doesnt really have any users. Would this just impact claims that have already been made via email?

**Severity: P2 (Medium)**

**File:** `apps/server/src/lib/event/claim-service.ts:49-51`

```ts
export function hashEmail(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}
```

Unsalted SHA-256 of email addresses is reversible via rainbow table for common emails. These hashes are stored in Swarm feeds which are **publicly readable**. An attacker could enumerate common email addresses and match them against published claim hashes.

**Fix:** Use HMAC-SHA256 with a server-side secret as the key: `createHmac("sha256", process.env.EMAIL_HASH_SECRET).update(email.trim().toLowerCase()).digest("hex")`. This makes hashes uncomputable without the secret.

**Note:** This is a **breaking change** for existing claim deduplication. Existing hashes won't match new ones. Plan migration: keep old hashes for legacy lookup, use HMAC for new claims.

#### FINDING 9.4: Server never verifies ed25519 ticket signatures **Is this the organisers ed25519 signature or the claimer?

**Severity: P2 (Medium)**

**Files:** `apps/web/src/lib/pod/signing.ts` (client only), `apps/server/src/lib/event/claim-service.ts:170-172`

`verifyTicket()` exists only client-side. The server's `claimTicket()` downloads the original signed ticket from Swarm and creates a claimed version, but **never verifies the ed25519 signature**. If Swarm feed data were tampered with (compromised feed key, man-in-the-middle on the Bee node), the server would accept forged tickets.

Currently low risk because the server controls the feed private key and talks to a local Bee node, but this violates defence-in-depth -- the ticket signature exists precisely for this verification.

**Fix:** Port `verifyTicket()` to the server (or share it via `packages/shared`) and call it in `claimTicket()` before creating the claimed version.

#### FINDING 9.5: clientCodeHash is always ZeroHash **I want to try and push the registry so its something that is checked via a wallet like metamask etc - I feel its best placed for it. So do you think we keep in for now? does it add alot of weight keeping?

**Severity: P3 (Advisory)**

**File:** `apps/web/src/lib/auth/session-delegation.ts:53`

```ts
clientCodeHash: ZeroHash,
```

The session delegation includes a `clientCodeHash` field (bytes32) that is always set to all zeros. This was designed for content-hash-based frontend integrity verification (the content hash registry feature) but is never populated or checked.

Not a vulnerability -- the field is signed into the EIP-712 message so it can't be changed after signing. But it provides no security value in its current state. Document as "reserved for future content hash registry integration" or remove the field if no longer planned.

---

## Priority Summary

| Priority | # | Finding | Action |
|----------|---|---------|--------|
| **P0** | 5.1 | txHash replay in payment verification | Add consumed-txHash tracking |
| **P0** | 5.2 | MIN_CONFIRMATIONS = 1 | Increase to 3-12 per chain |
| **P1** | 9.1 | Session signature never verified server-side | Verify session sig in requireAuth, or remove dead signing code |
| **P1** | 9.2 | API key non-constant-time comparison | Use crypto.timingSafeEqual() |
| **P1** | 8 | Mock payment dead code with XSS | Remove ~290 lines from claims.ts |
| **P1** | 1.3 | 1-year session expiry | Reduce to 7-30 days |
| **P1** | 1.4 | No session revocation | Add server-side nonce revocation |
| **P2** | 9.3 | Unsalted email hashing | Use HMAC-SHA256 with server secret |
| **P2** | 9.4 | Server doesn't verify ticket signatures | Port verifyTicket to server |
| **P2** | 1.1 | SESSION_DOMAIN lacks salt | Add salt to EIP-712 domains |
| **P2** | 1.2 | sessionProof not verified server-side | Add server-side verification |
| **P2** | 5.3 | Escrow no reentrancy guard | Add ReentrancyGuard |
| **P2** | 7.1 | In-memory rate limiting | Use persistent store |
| **P2** | 7.2 | IP rate limiting bypassable | Add additional claim protections |
| **P3** | 9.5 | clientCodeHash always ZeroHash | Document or remove |
| **P3** | 2.1 | Seed uses toUtf8Bytes on hex string | Use getBytes() (breaking change) |
| **P3** | 2.2 | ed25519 seed/key naming | Rename for clarity |
| **P3** | 3.1 | Empty HKDF salt | Add fixed application salt |
| **P3** | 3.2 | Dead ENCRYPTION_DOMAIN constants | Remove unused code |
| **P3** | 4.1 | No AAD in device-key AES-GCM | Add storage key as AAD |
| **P3** | 5.4 | No token array length in escrow | Add max length check |
| **P3** | 6.1 | Claim message delimiter | Consider structured format |

---

## Fix Plan

### Phase 1: Critical Payment Security + Session Auth (P0 + P1-critical)

These must be fixed before any real-money payment flow or production deployment.

**1a. txHash replay prevention** (new: `apps/server/src/lib/payment/tx-registry.ts`, modify: `claims.ts`)

- Create a `TxRegistry` that tracks consumed transaction hashes
- In-memory `Set<string>` backed by a JSON file (survives restarts)
- Check txHash uniqueness *before* entering the claim queue (fail fast)
- Insert into claims.ts payment verification block, after `verifyPayment()` succeeds

**1b. Per-chain confirmation thresholds** (modify: `apps/server/src/lib/payment/constants.ts`)

- Replace `MIN_CONFIRMATIONS = 1` with per-chain config:
  - Mainnet (1): 12
  - Base (8453): 3
  - Optimism (10): 3
  - Sepolia (11155111): 3
- Update `verifyPayment()` to accept chainId and look up the threshold

**1c. Session signature verification** (modify: `apps/server/src/middleware/auth.ts`)

- Client already sends `signed.signature` -- verify it server-side
- In `requireAuth`, after delegation verification: hash the request body, verify the session key signed that hash
- This makes intercepted delegation bundles useless without the session private key
- Requires client to also send the signature (currently computed but not transmitted -- check `authPost` to confirm whether it's included in the request)

**1d. API key constant-time comparison** (modify: `apps/server/src/routes/claims.ts`)

- Replace `apiKey !== expected` with `crypto.timingSafeEqual(Buffer.from(apiKey), Buffer.from(expected))`
- Add length pre-check (reject immediately if lengths differ)

### Phase 2: Remove Dead Code + Session Hardening (P1)

**2a. Remove mock payment page** (modify: `apps/server/src/routes/claims.ts`)

- Delete the `GET mock-payment-page` route (lines ~315-492)
- Delete the `POST mock-payment` route (lines ~498-601)
- Update CLAUDE.md build status note

**2b. Reduce session expiry** (modify: `packages/shared/src/auth/constants.ts`)

- Change `SESSION_EXPIRY_MS` from 365 days to 30 days
- One-line change; existing sessions will naturally expire

**2c. Add session revocation** (new: `apps/server/src/lib/auth/revocation.ts`, modify: `verify-delegation.ts`)

- Server-side `Map<string, number>` mapping nonce -> revoked timestamp, backed by JSON file
- Check in `verifyDelegation()`: if `message.nonce` is in revocation set, reject
- New endpoint: `POST /api/auth/revoke-session` (authenticated) -- adds current session nonce to revocation set
- Optional: `POST /api/auth/revoke-all` -- stores a "revoke all before timestamp" per parent address

### Phase 3: Hardening (P2)

**3a. HMAC email hashing** (modify: `apps/server/src/lib/event/claim-service.ts`)

- Replace `createHash("sha256")` with `createHmac("sha256", process.env.EMAIL_HASH_SECRET)`
- Add `EMAIL_HASH_SECRET` to .env.example and production .env
- Migration: dual-check (old hash OR new HMAC) for deduplication during transition period

**3b. Server-side ticket signature verification** (new: `apps/server/src/lib/pod/verify.ts` or share from `packages/shared`)

- Port `verifyTicket()` to run on the server (uses @noble/ed25519, already a dependency)
- Call in `claimTicket()` before creating the claimed ticket
- Reject claims for tickets with invalid signatures

**3c. Add salt to EIP-712 domains** (modify: `packages/shared/src/auth/eip712.ts`)

- Add `salt: "0x..."` (generate once, hardcode) to SESSION_DOMAIN and POD_IDENTITY_DOMAIN
- **Breaking change** for existing sessions/POD identities -- coordinate with session expiry reduction (old sessions expire, users re-delegate with new domain)

**3d. Verify sessionProof server-side** (modify: `apps/server/src/lib/auth/verify-delegation.ts`)

- After EIP-712 signature verification, add:
  ```ts
  const proofSigner = verifyMessage(`${message.host}:${message.nonce}`, message.sessionProof);
  if (proofSigner.toLowerCase() !== message.session.toLowerCase()) {
    return { valid: false, error: "Session proof does not match session address" };
  }
  ```

**3e. Escrow reentrancy guard** (modify: `contracts/src/WoCoEscrow.sol`)

- Import/implement ReentrancyGuard
- Add `nonReentrant` modifier to `release()` and `resolveDispute()`

**3f. Persistent rate limiting** (modify: `apps/server/src/routes/claims.ts`)

- Replace in-memory `Map` with file-backed or SQLite-backed store
- Survives restarts, still fast enough for the traffic level

### Phase 4: Polish (P3)

- Remove dead `ENCRYPTION_DOMAIN`/`ENCRYPTION_TYPES`/`ENCRYPTION_NONCE` from `packages/shared/src/crypto/constants.ts`
- Add AAD to device-key encryption (pass storage key name as `additionalData`)
- Add max token array length check to escrow contract (e.g., `require(tokens.length <= 20)`)
- Document `clientCodeHash` as reserved for content hash registry, or remove the field
- Document the `toUtf8Bytes` vs `getBytes` decision (don't change if users already have POD identities)
- Rename `seedToEd25519` return value from `privateKey` to `seed` for clarity
