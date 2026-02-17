# WoCo Technical Architecture

A complete technical reference for the WoCo decentralized event platform.
Everything documented here reflects the actual implementation — no aspirational features.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Authentication & Identity](#2-authentication--identity)
3. [Cryptographic Key Hierarchy](#3-cryptographic-key-hierarchy)
4. [EIP-712 Session Delegation](#4-eip-712-session-delegation)
5. [EIP-712 POD Identity Derivation](#5-eip-712-pod-identity-derivation)
6. [X25519 Encryption (ECIES)](#6-x25519-encryption-ecies)
7. [Device Storage Encryption](#7-device-storage-encryption)
8. [Ticket System](#8-ticket-system)
9. [Claiming Flow (End to End)](#9-claiming-flow-end-to-end)
10. [Organizer Dashboard](#10-organizer-dashboard)
11. [Swarm Storage Architecture](#11-swarm-storage-architecture)
12. [API Authentication Flow](#12-api-authentication-flow)

---

## 1. System Overview

WoCo is a decentralized event ticketing platform. Events are stored on the Swarm
decentralized storage network. Tickets are cryptographically signed. Attendee
order data is end-to-end encrypted — only the event organizer can read it.

**Stack:**
- Frontend: Vite + Svelte 5 + TypeScript (single-page app, hash-based routing)
- Backend: Hono + TypeScript (API server, acts as Swarm relay)
- Storage: Swarm Network feeds and bytes (no database)
- Auth: EIP-712 signed session delegation

**Key Principle — "Build first, sign later":** Users fill out the entire event
creation form before any wallet popups appear. Signing only happens at publish time.

---

## 2. Authentication & Identity

WoCo supports two login methods (a third, Zupass, is planned but not implemented):

### Method 1: Web3 Wallet (MetaMask, etc.)

1. User clicks "Connect Wallet" → browser extension popup (connect only, no signing)
2. `window.ethereum.request({ method: "eth_requestAccounts" })` returns the address
3. Address stored in IndexedDB as `woco:auth:parent`, kind set to `"web3"`
4. **No EIP-712 signing happens at this point** — signing is deferred

On page reload, `auth.init()` reads `window.ethereum.selectedAddress` (or sends
`eth_accounts`). If the address matches the stored parent, auth restores silently.
If the wallet switches accounts, all auth state is cleared automatically.

### Method 2: Local Browser Account

1. User clicks "Create Local Account"
2. Frontend generates a random secp256k1 keypair: `ethers.Wallet.createRandom()`
3. The private key and address are encrypted with the device key (AES-256-GCM)
   and stored in IndexedDB under `woco:auth:local-key`
4. This keypair acts identically to a web3 wallet for all downstream operations
5. Address stored as `woco:auth:parent`, kind set to `"local"`

On page reload, `auth.init()` restores the local account from IndexedDB.
The local key persists across sign-outs — only the session and POD identity
are cleared, so the user can log back in to the same identity.

### Deferred Signing

Neither login method triggers EIP-712 signatures at connect time. Two separate
EIP-712 signatures are required, and each is triggered lazily on the first action
that needs it:

1. **Session Delegation** — triggered on first authenticated API call (e.g. publish)
2. **POD Identity** — triggered on first ticket-related action (e.g. publish, claim)

For web3 wallets, each triggers a MetaMask popup. For local accounts, each shows
an in-app confirmation dialog displaying what is being signed.

---

## 3. Cryptographic Key Hierarchy

```
Parent Key (secp256k1)
│  Source: MetaMask wallet OR Wallet.createRandom()
│  Purpose: permanent identity, owns all derived keys
│
├── Session Key (secp256k1, ephemeral)
│   Source: Wallet.createRandom() — fresh per session
│   Authorized via: EIP-712 "AuthorizeSession" signed by parent
│   Purpose: signs API requests (no wallet popup per request)
│   Lifetime: 1 year (but cleared on sign-out)
│
├── POD Seed (32 bytes, deterministic)
│   Source: keccak256(EIP-712 "DerivePodIdentity" signature)
│   The fixed nonce makes this deterministic — same wallet always
│   produces the same seed
│   │
│   ├── Ed25519 Identity Keypair
│   │   Private key = POD seed bytes (used directly)
│   │   Public key = ed25519.getPublicKey(seed)
│   │   Purpose: signs tickets
│   │
│   └── X25519 Encryption Keypair
│       Private key = HKDF-SHA256(ikm=seed, salt=[], info="woco/encryption/v1", 32)
│       Public key = x25519.getPublicKey(private)
│       Purpose: encrypts attendee order data (ECIES)
│
└── Device Key (AES-256-GCM, non-extractable)
    Source: crypto.subtle.generateKey() — one per browser profile
    Stored as raw CryptoKey object in IndexedDB
    Purpose: encrypts all secrets at rest in IndexedDB
```

---

## 4. EIP-712 Session Delegation

Delegates a randomly-generated ephemeral session key so the frontend can sign
API requests without prompting the wallet on every call.

### Domain

```json
{ "name": "WoCo Session", "version": "1" }
```

### Type Definition

```
AuthorizeSession(
  string host,
  address parent,
  address session,
  string purpose,
  string nonce,
  string issuedAt,
  string expiresAt,
  bytes sessionProof,
  bytes32 clientCodeHash,
  string statement
)
```

### Field Values

| Field | Value |
|-------|-------|
| host | `window.location.host` (e.g. `"gateway.woco-net.com"`) |
| parent | Parent wallet address (checksummed) |
| session | Freshly generated session wallet address |
| purpose | `"session"` (fixed string) |
| nonce | `crypto.randomUUID()` — random, unique per session |
| issuedAt | ISO timestamp of signing time |
| expiresAt | ISO timestamp, 1 year from issuedAt |
| sessionProof | `sessionWallet.signMessage("${host}:${nonce}")` — proof the session key is controlled by this client |
| clientCodeHash | `0x0000...0000` (32 zero bytes, reserved for future use) |
| statement | `"Authorize ${sessionAddress} as session key for ${host}"` |

### Signing

- **Web3:** `BrowserProvider.getSigner(parent).signTypedData(domain, types, message)` → MetaMask popup
- **Local:** `new Wallet(privateKey).signTypedData(domain, types, message)` → in-app confirmation dialog

After signing, the frontend verifies the signature locally with `ethers.verifyTypedData`
before storing it.

### Backend Verification

On every authenticated API request, the backend (`requireAuth` middleware) checks:

1. Delegation message and parent signature are present
2. Not expired (`expiresAt > now`)
3. Not issued in the future (more than 60 seconds of clock skew rejected)
4. Host matches `ALLOWED_HOSTS` environment variable (if set)
5. Claimed session address matches `delegation.message.session`
6. `ethers.verifyTypedData(domain, types, message, parentSig)` recovers the parent address
7. Recovered address matches `delegation.message.parent`

On success, the backend sets `parentAddress` on the request context, which is used
for organizer ownership checks and claim identity.

---

## 5. EIP-712 POD Identity Derivation

Deterministically derives a 32-byte seed from the parent wallet. The same wallet
always produces the same seed, which means the same ed25519 identity — across
devices, browsers, and sessions.

### Domain

```json
{ "name": "WoCo POD Identity", "version": "1" }
```

### Type Definition

```
DerivePodIdentity(
  string purpose,
  address address,
  string nonce
)
```

### Field Values

| Field | Value |
|-------|-------|
| purpose | `"Derive deterministic POD signing identity"` |
| address | Parent wallet address |
| nonce | `"WOCO-POD-IDENTITY-V1"` — **fixed, never changes** |

The fixed nonce is what makes this deterministic. secp256k1 signing is deterministic
per RFC 6979 — same message always produces the same signature.

### Derivation Steps

```
1. signature = parent.signTypedData(domain, types, message)
   → 65-byte hex string (r ∥ s ∥ v)

2. seed = keccak256(toUtf8Bytes(signature))
   → Note: the hex string is treated as UTF-8 text, NOT parsed as raw bytes
   → Result: 32-byte hash

3. ed25519 private key = seed bytes (used directly as the 32-byte private key)

4. ed25519 public key = ed25519.getPublicKey(privateKey)
   → Standard scalar multiplication on the Ed25519 curve
   → Library: @noble/ed25519
```

The seed is stored encrypted in IndexedDB under `woco:auth:pod-seed`.

### X25519 Encryption Key Derivation (from POD seed)

The X25519 encryption keypair is derived from the same POD seed using HKDF,
requiring zero additional wallet interactions:

```
1. encryptionSeed = HKDF-SHA256(
     ikm   = podSeedBytes,        // 32 bytes
     salt  = [] (empty),
     info  = "woco/encryption/v1",
     len   = 32
   )

2. X25519 private key = encryptionSeed (32 bytes)

3. X25519 public key = x25519.getPublicKey(private)
```

The public key is stored in the event feed (`EventFeed.encryptionKey`) so anyone
claiming a ticket can encrypt data to the organizer.

---

## 6. X25519 Encryption (ECIES)

Order data submitted by attendees is end-to-end encrypted. Only the event
organizer can decrypt it. The scheme is ECIES (Elliptic Curve Integrated
Encryption Scheme).

### Algorithm Summary

```
Encrypt: ephemeral X25519 ECDH → HKDF-SHA256 → AES-256-GCM
Decrypt: recipient X25519 ECDH → HKDF-SHA256 → AES-256-GCM
```

### Encryption (`seal`)

```
1. Generate ephemeral X25519 keypair
   ephPrivate = 32 random bytes (crypto.getRandomValues)
   ephPublic  = x25519.getPublicKey(ephPrivate)

2. ECDH shared secret
   shared = x25519.getSharedSecret(ephPrivate, recipientPublicKey)
   → 32 bytes (Diffie-Hellman on Curve25519)

3. Key derivation
   aesKey = HKDF-SHA256(
     ikm  = shared,
     salt = ephPublic,        // domain separation
     info = "woco/order/v1",
     len  = 32
   )

4. Encryption
   iv = 12 random bytes (crypto.getRandomValues)
   ciphertext = AES-256-GCM(aesKey, iv, plaintext)
   → Ciphertext includes the 16-byte GCM authentication tag appended
```

### Output Format (`SealedBox`)

```typescript
{
  ephemeralPublicKey: string,  // 32 bytes as hex (no 0x prefix)
  iv: string,                  // 12 bytes as hex
  ciphertext: string           // variable length as hex (includes 16-byte GCM tag)
}
```

### Decryption (`open`)

```
1. shared = x25519.getSharedSecret(recipientPrivateKey, box.ephemeralPublicKey)
   → Same shared secret (DH commutativity)

2. aesKey = HKDF-SHA256(ikm=shared, salt=ephPublicKey, info="woco/order/v1", 32)
   → Same key derivation parameters → same AES key

3. plaintext = AES-256-GCM-decrypt(aesKey, box.iv, box.ciphertext)
   → Throws if ciphertext was tampered with (GCM authentication)
```

### What Gets Encrypted

Every ticket claim encrypts basic identity data to the organizer:

- **Wallet claims:** `{ seriesId, claimerAddress, fields? }`
- **Email claims:** `{ seriesId, claimerEmail, fields? }`

`fields` contains any custom order form data the organizer configured (name, email,
dietary preferences, etc.). The organizer decrypts this on the dashboard using their
X25519 private key (derived from their POD seed via HKDF).

### Security Properties

- **Forward secrecy per message:** Each encryption uses a fresh ephemeral keypair.
  Compromising the organizer's long-term key does not help decrypt past messages
  unless the attacker also has the ciphertexts.
- **Authentication:** AES-GCM provides authenticated encryption. Tampered
  ciphertexts are rejected.
- **Key separation:** The encryption key is domain-separated from the signing key
  via HKDF with a distinct info string (`"woco/encryption/v1"`).

---

## 7. Device Storage Encryption

All secrets stored in IndexedDB are encrypted with a device key.

### Device Key Generation

```
key = crypto.subtle.generateKey(
  { name: "AES-GCM", length: 256 },
  false,              // extractable = false
  ["encrypt", "decrypt"]
)
```

The `extractable: false` flag means the raw key material can never be read by
JavaScript — it stays inside the browser's Web Crypto implementation. The key
is stored as a native `CryptoKey` object in IndexedDB (IndexedDB supports
structured cloning of CryptoKey).

### Encryption (secrets → IndexedDB)

```
iv = 12 random bytes
ciphertext = AES-256-GCM(deviceKey, iv, JSON.stringify(data))
stored as: { iv: hexString, ct: hexString }
```

### What Is Stored Encrypted

| IndexedDB Key | Plaintext Content |
|---------------|-------------------|
| `woco:auth:session-key` | `{ privateKey: "0x...", address: "0x..." }` |
| `woco:auth:session-delegation` | `{ message: {…}, parentSig: "0x..." }` |
| `woco:auth:pod-seed` | `{ seed: "0x..." }` (the keccak256 hash) |
| `woco:auth:local-key` | `{ privateKey: "0x...", address: "0x..." }` |

The device key itself (`woco:device-key`) is stored as a raw CryptoKey — it is
NOT encrypted (it is the root of the encryption chain).

---

## 8. Ticket System

### Concepts

- **Series** = a ticket type for an event (e.g. "General Admission", "VIP").
  Has a `totalSupply`, metadata, and image.
- **Edition** = an individual ticket within a series, numbered 1 to totalSupply.
- **Signed Ticket** = a ticket signed by the event creator's ed25519 key.
- **Claimed Ticket** = a signed ticket plus claim metadata (who claimed it, when).

### Ticket Data Structure

```typescript
{
  podType: "woco.ticket.v1",
  eventId: string,
  seriesId: string,
  seriesName: string,
  edition: number,       // 1-based
  totalSupply: number,
  imageHash: string,     // Swarm hash of ticket image
  creator: string,       // ed25519 public key hex ("0x" + 64 chars)
  mintedAt: string       // ISO timestamp
}
```

### Signing Algorithm

```
message   = TextEncoder.encode(JSON.stringify(ticketData))
signature = ed25519.sign(message, privateKey)
```

- Algorithm: Ed25519 (Edwards-curve Digital Signature Algorithm)
- Library: `@noble/ed25519`
- Private key: 32 bytes (the POD seed)
- Signature: 64 bytes (r ∥ s), stored as hex without `0x` prefix

### Pre-Signing

All tickets for every series are signed at event creation time (before upload).
The `createSeriesTickets()` function loops from edition 1 to `totalSupply`,
signs each, and returns the array. All editions share the same `mintedAt` timestamp.

### Verification

```
message = TextEncoder.encode(JSON.stringify(ticket.data))
valid   = ed25519.verify(signature, message, publicKey)
```

Anyone with the creator's public key (stored in the event feed) can verify
that a ticket was genuinely signed by the event creator.

---

## 9. Claiming Flow (End to End)

### Frontend

1. User clicks "Claim ticket" on an event series
2. If claim mode is "both" → order form opens with wallet/email buttons at bottom
3. **Wallet claim:**
   - If not logged in → login modal appears (user picks web3 or local)
   - If session not delegated → EIP-712 signing (one popup, cached after that)
   - Server verifies the delegation and uses the verified address (not the request body)
4. **Email claim:** no login required — user provides email address (rate-limited by IP)
5. If event has order fields → user fills them in
6. Order data encrypted with organizer's X25519 public key (`sealJson`)
7. `POST /api/events/:eventId/series/:seriesId/claim` with:
   - `mode`: `"wallet"` or `"email"`
   - `walletAddress` or `email`
   - `encryptedOrder`: the `SealedBox`
   - Session delegation (wallet claims only, in request body)

**Authentication model by claim mode:**

- **Wallet claims** are authenticated via session delegation. The claimer must have
  a valid EIP-712 session delegation (one MetaMask popup on first claim, cached after
  that). The server uses the **verified parent address** from the delegation — not
  the address from the request body. This prevents impersonation (nobody can claim
  as your address without controlling your wallet).

- **Email claims** are unauthenticated but rate-limited (3 claims per IP per 15
  minutes). Email verification is not currently implemented — this is an acceptable
  trade-off because email claims don't grant the claimer any on-chain access. The
  organizer manually processes email claims via the dashboard.

- **API claims** (organizer backend-to-backend) are authenticated via API key.

**No POD identity derivation at claim time.** The claimer's ed25519 identity is not
needed — only their wallet address or email is recorded. POD identity derivation is
deferred to features that require it (event creation, dashboard access). The wallet
address or email hash serves as a lookup key for future features (POD signing, ticket
transfers, proof of attendance).

### Backend (claim-service.ts)

**Step 1 — Auth (wallet claims only):** Verifies session delegation inline —
extracts and validates the EIP-712 signature, recovers the parent address,
and uses it as the claimer identity. Email claims skip this step (rate-limited
by IP instead).

**Step 2 — Load metadata:** Reads editions feed page 0, slot 0. Downloads the
JSON metadata from Swarm: `{ totalSupply, pageCount, eventId, seriesId, name }`.

**Step 3 — Find next unclaimed slot:** Fetches all edition and claim pages in
parallel (`Promise.all`). Scans for the first slot where the claim is empty but
the edition exists.

Page layout:
- Page 0: 4096 bytes = 128 × 32-byte slots. Slot 0 = metadata ref. Slots 1-127 = tickets. Capacity: 127 tickets.
- Page N (N > 0): 4096 bytes = 128 × 32-byte slots. All 128 = tickets. Capacity: 128 tickets.

**Step 4 — Calculate edition number:**

```
Page 0: edition = slot number (slot 1 = edition 1, slot 2 = edition 2, ...)
Page N: edition = 127 + (N-1) × 128 + slot + 1
```

**Step 5 — Download original signed ticket** from Swarm bytes using the ref
from the editions slot.

**Step 6 — Create claimed ticket record:**

```typescript
{
  podType: "woco.ticket.claimed.v1",
  // ... all fields from original ticket ...
  ownerAddress: "0x...",           // for wallet claims
  ownerEmailHash: sha256(email),   // for email claims (lowercase, trimmed)
  claimedAt: ISO timestamp,
  originalPodHash: swarmRef,       // ref to the original signed ticket
  originalSignature: "...",        // original ed25519 signature
}
```

The email is hashed with SHA-256 (`crypto.createHash("sha256")`). The raw
email is never stored on Swarm.

**Step 7 — Upload claimed ticket** to Swarm bytes → get content hash (`claimedRef`).

**Step 8 — Write claim ref** into the claims feed slot (same page/slot position
as the edition).

**Step 9 — Upload encrypted order** (if provided) to Swarm bytes. Update the
claimers JSON feed with a new `ClaimerEntry` containing the order ref. This step
is awaited (not fire-and-forget) to prevent race conditions with concurrent claims.

**Step 10 — Update user collection** (wallet claims only, background/best-effort).
Appends a `CollectionEntry` to the user's personal feed at
`woco/pod/collection/{ethAddress}`.

**Step 11 — Return** the `ClaimedTicket` to the frontend, which shows a green
"Claimed #N" badge.

---

## 10. Organizer Dashboard

The dashboard lets event organizers view and manage claims for their events.

### Access Flow

1. Organizer navigates to `#/dashboard` → sees a list of their created events
   (filtered from the global event directory by matching `creatorAddress`)
2. Clicks an event → `#/dashboard/:eventId`
3. **Auth check:** must be logged in (`auth.isConnected`). If not, shows
   "Please sign in" message
4. **Ownership check:** `auth.parent` must match `event.creatorAddress`
5. **Load orders:** `GET /api/events/:id/orders` (authenticated, organizer-only).
   This endpoint reads every series' claimers JSON feed from Swarm and returns
   all `ClaimerEntry` records with their encrypted order data
6. **Decrypt orders:** The dashboard derives the organizer's X25519 private key
   from their POD seed (via HKDF). If the POD seed hasn't been derived yet,
   it triggers the EIP-712 "DerivePodIdentity" signing (MetaMask popup or
   in-app dialog). Each order's `SealedBox` is then decrypted with `openJson()`
7. **Display:** Orders grouped by series in a table showing edition, claimer
   (wallet address or decrypted email), claimed time, and any custom form fields

### Dashboard Features

- **CSV Export:** Downloads all orders for a series as CSV (edition, claimer,
  email, claimed time, plus custom form fields)
- **Webhook Relay:** Organizers can configure a webhook URL (stored in
  localStorage, never sent to the server). Decrypted order data can be forwarded
  to external services (SendGrid, Zapier, etc.) via the server's webhook relay
  endpoint. The server never sees the decrypted data — it only forwards it
- **Bulk Send:** Send all unsent orders to the webhook with 200ms delay between
  requests. Sent status is tracked in localStorage
- **Rate Limit:** 30 webhook relay requests per minute per organizer (server-enforced)

### Why POD Identity Is Needed Here

The dashboard is the one place where the organizer's POD identity is required
after event creation. The X25519 decryption key is derived from the POD seed,
which comes from the EIP-712 "DerivePodIdentity" signature. Without it, the
organizer cannot decrypt the attendee order data. This is why the organizer
sees an EIP-712 popup when first visiting the dashboard (if their POD seed
isn't already cached in IndexedDB).

---

## 11. Swarm Storage Architecture

All data is stored on the Swarm Network using two primitives:

- **Bytes** (`/bytes`): immutable content-addressed blobs. Upload data, get a
  64-character hex hash back. Used for tickets, images, order data.
- **Feeds**: mutable single-owner feeds. A feed is identified by an owner address
  and a topic. The owner can update the content, but the address stays the same.
  Used for event directory, event details, edition lists, claim lists, user collections.

### Feed Topic Map

| Topic Pattern | Content | Format |
|---------------|---------|--------|
| `woco/event/directory` | Global event listing | JSON feed |
| `woco/event/{eventId}` | Event details + series | JSON feed |
| `woco/pod/editions/{seriesId}` | Page 0: slot 0=metadata, slots 1-127=ticket refs | 4096-byte binary |
| `woco/pod/editions/{seriesId}/p{N}` | Pages 1+: 128 ticket refs per page | 4096-byte binary |
| `woco/pod/claims/{seriesId}` | Page 0: mirrors editions layout | 4096-byte binary |
| `woco/pod/claims/{seriesId}/p{N}` | Pages 1+: mirrors editions | 4096-byte binary |
| `woco/pod/claimers/{seriesId}` | Who claimed what (JSON array) | JSON feed |
| `woco/pod/collection/{ethAddress}` | User's claimed tickets | JSON feed |

### Binary Page Format (4096 bytes)

Each page holds 128 slots of 32 bytes each (128 × 32 = 4096). Each slot stores
a Swarm content hash (64 hex chars = 32 bytes). An empty slot is all zeros.

### JSON Feed Format

JSON is serialized, then padded with null bytes to exactly 4096 bytes. On read,
null bytes are stripped before parsing.

### Feed Ownership

All feeds are currently owned by a single platform signer (the `FEED_PRIVATE_KEY`
in the server's `.env`). This is a centralization trade-off for v1 — the server
acts as a Swarm relay. Future versions will allow users to own their own feeds.

---

## 12. API Authentication Flow

Every authenticated request follows this pattern:

```
Browser                              Server
  │                                    │
  │  POST /api/events                  │
  │  Headers:                          │
  │    X-Session-Address: 0x...        │
  │    X-Session-Delegation: base64({  │
  │      message: { host, parent,      │
  │        session, nonce, ... },       │
  │      parentSig: "0x..."            │
  │    })                              │
  │  Body signed by session key        │
  │ ──────────────────────────────────►│
  │                                    │  1. Parse delegation from header
  │                                    │  2. Check expiry
  │                                    │  3. Check host against ALLOWED_HOSTS
  │                                    │  4. Verify EIP-712 signature
  │                                    │     recovers parent address
  │                                    │  5. Confirm parent == message.parent
  │                                    │  6. Confirm session == message.session
  │                                    │  7. Set parentAddress on context
  │                                    │
  │  200 OK / 403 Forbidden           │
  │ ◄──────────────────────────────────│
```

The session key signs the request body, but the critical trust anchor is the
parent's EIP-712 signature over the session delegation. This proves the parent
wallet authorized this specific session key to act on its behalf.

---

## Libraries Used

| Library | Purpose |
|---------|---------|
| `ethers` (v6) | EIP-712 signing, wallet interaction, address utils |
| `@noble/ed25519` | Ed25519 ticket signing and verification |
| `@noble/hashes` | SHA-256, HKDF-SHA256, keccak256 |
| `@noble/curves` | X25519 ECDH key exchange |
| `@ethersphere/bee-js` | Swarm client (feeds, bytes, uploads) |
| Web Crypto API | AES-256-GCM (both device encryption and ECIES), random bytes |
