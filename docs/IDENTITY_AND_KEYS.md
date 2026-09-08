# Identity and keys

Every key a WoCo account has, what derives it, what it signs, and why it exists.

**Verified against `main` on 2026-09-08.** Every constant below is quoted from the file that
defines it; that file is the authority, not this document.

> **Naming.** "POD" is retired from prose — the standard word is **object data**, and the code
> speaks *editions*, *certs* and *holder identity*. But the **signed literals keep their exact
> bytes**: the EIP-712 domain is still `"WoCo POD Identity"`, the topics are still `woco/pod/*`,
> and the storage key is still the "POD seed". Those are frozen. Only names and copy changed.

---

## 1. The map

```
  ┌─────────────────────────────────────────────────────────────────────────┐
  │  PARENT ACCOUNT (secp256k1)                                            │
  │  MetaMask EOA · or a ZeroDev Kernel (passkey / email login)            │
  │  Permanent identity. Signs AuthorizeSession, then gets out of the      │
  │  way. Never signs a feed and never signs an API request.               │
  │                                                                        │
  │  A KERNEL NEVER SIGNS THE TWO DERIVATIONS (invariant #1). Those are    │
  │  signed by the RAW secp256k1 key beneath it — the passkey's PRF key    │
  │  or the Web3Auth key — because a smart account's 1271 signatures are   │
  │  non-deterministic. The derivation's `address` field is that raw       │
  │  key's address, NOT the Kernel's.                                      │
  └──┬──────────────────────────────────┬───────────────────────────────────┘
     │ AuthorizeSession                 │ two deterministic derivations, signed
     │ (per session, by the Kernel       │ by the RAW key (never the Kernel)
     │  or the EOA)                     │ (fixed nonce — same signature forever)
     ▼                                  │
  ┌──────────────────────┐              ├──────────────────────────────┐
  │ SESSION KEY          │              ▼                              ▼
  │ secp256k1, random    │    ┌───────────────────────┐   ┌────────────────────────┐
  │ 30-day expiry        │    │ OBJECT-DATA SEED      │   │ CONTENT-FEED SIGNER    │
  │ Signs every API      │    │ 32 bytes              │   │ secp256k1              │
  │ request (EIP-191)    │    │ keccak256(sig bytes)  │   │ keccak256(sig bytes)   │
  └──────────────────────┘    └──────┬────────────────┘   │ Owns the user's        │
                                     │                     │ content chunks         │
                    ┌────────────────┼──────────────────┐  └────────────────────────┘
                    │                │                  │
                    ▼                ▼                  ▼
        ┌───────────────────┐ ┌──────────────┐ ┌─────────────────────┐
        │ HOLDER IDENTITY   │ │ ENCRYPTION   │ │ ISSUING KEY         │
        │ ed25519           │ │ X25519       │ │ secp256k1           │
        │ seed used VERBATIM│ │ HKDF         │ │ HKDF, generation-   │
        │                   │ │ "woco/       │ │ parameterised       │
        │ SIGNS NOTHING on  │ │  encryption/ │ │                     │
        │ any launch-scope  │ │  v1"         │ │ Signs editions +    │
        │ path. Cert        │ │              │ │ manifests. Identity │
        │ challenges +      │ │ Opens sealed │ │ of record = its     │
        │ credits only.     │ │ orders       │ │ 20-byte ADDRESS     │
        │ LEFTOVER → #518   │ │              │ │                     │
        └───────────────────┘ └──────────────┘ └─────────────────────┘
```

Five keys, and the count is not incidental — each one exists because a *role* had to be
separated, not because a layer was convenient.

---

## 2. Sign-to-derive: the mechanism behind two of them

Both the object-data seed and the content-feed signer are produced the same way.

**Who signs matters more than it looks.** For a passkey or email login the signer here is the
**raw secp256k1 key beneath the Kernel** — the PRF-derived key, or the Web3Auth key — obtained
via `_getPodSigner()`, never `_getSigner()`. This is "invariant #1" in
`apps/web/src/lib/auth/auth-store.svelte.ts`: a Kernel's ERC-1271 signature is
non-deterministic, so deriving from it would corrupt the user's encryption and ticket-signing
identity on every login. It is also why the message's `address` field carries the raw key's
address rather than the Kernel's, and why the "never sign-to-derive for a smart account" rule in
§8 is consistent with this rather than contradicting it: we never do — we reach past the smart
account to the deterministic key underneath. Coinbase Smart Wallet has no such key to reach,
which is exactly why it is switched off.

```
signature = wallet.signTypedData(DOMAIN, TYPES, { purpose, address, nonce: FIXED })
seed      = keccak256(getBytes(signature))         // the 65 raw signature bytes
```

Two properties make this work. **Determinism**: the nonce is fixed, so the same wallet always
produces the same signature and therefore the same seed — recoverable on any device with no
server involvement. **Domain separation**: each derivation signs a *different* EIP-712 domain
with a *different* salt, so a signature phished for one purpose cannot be replayed to derive
another.

```
SESSION_DOMAIN            salt 0x6f4cd6d4…cbe3   (session delegation)
POD_IDENTITY_DOMAIN       salt 0x8aee4359…085a   (the object-data seed)
FEED_SIGNER_DERIVE_DOMAIN salt 0x589b7c35…ac0f   (the content-feed signer)
RECOVERY_ENC_DOMAIN       salt 0x7647dc11…8a20   (a guardian's escrow key)
```

— `packages/shared/src/auth/eip712.ts`

Two details that took real defects to learn:

- **Hash the signature *bytes*, not the hex string.** `keccak256(getBytes(sig))` hashes 65
  bytes; `keccak256(toUtf8Bytes(sig))` would hash 132 ASCII characters. The byte form is the
  ecosystem standard. Changing which one you hash changes every user's identity.
- **External wallets get signed twice.** We control the nonce generation of our own signers
  (ethers → RFC-6979, deterministic). We do not control MetaMask's. So the feed-signer derivation
  signs twice and **throws on mismatch** — a non-deterministic wallet would make the feed
  unrecoverable on the next device, and the failure has to happen at setup, loudly, not at the
  door. It never falls back to platform signing as a consolation.

---

## 3. The three siblings off one seed

One 32-byte seed produces three keys on three curves, and their independence is the whole point.

| Key | Curve | Derivation | Defined in |
|---|---|---|---|
| Holder identity | ed25519 | the seed **verbatim** | `apps/web/src/lib/pod/keys.ts` — **leftover, see §3a** |
| Encryption | X25519 | `HKDF(sha256, seed, salt="", info="woco/encryption/v1", 32)` | `packages/shared/src/crypto/keys.ts` |
| Issuing | secp256k1 | `HKDF(sha256, seed, salt="", info="woco/issuing/v1/"+gen, 48)` → scalar | `packages/shared/src/crypto/issuing.ts` |

### 3a. The ed25519 holder key is a leftover, and the seed is not it

**Tickets are signed by the per-purchase burner key (secp256k1)**, verified against the on-chain
`slotOwner` (`packages/shared/src/ticket/canonical.ts`). Editions and manifests are signed by the
**issuing key**. `edition/types.ts` states it without qualification: *"no ed25519 anywhere on the
issuer side."* The ed25519 holder key signs **no ticket and owns no ticket.**

What it still does, in full:

| Use | Kind | Status |
|---|---|---|
| `woco.cert-challenge.v1` possession signature | **signature** | Cert rail — **out of launch scope** |
| `woco.credit.v1` `holderSig` | **signature** | Credits rail — out of launch scope |
| `podPubKey` as owner-of-record | **identifier only** | Live, but *self-declared and never verified* (`routes/orders.ts:164`), and it feeds the cert-issuance surface |

So on every launch-scope path it signs nothing. Removal is tracked in
[#518](https://github.com/yea-80y/WoCo-Event-App/issues/518).

**The distinction that matters, because the obvious reading is wrong:** the **seed is not the
ed25519 account.** The seed is 32 bytes — `keccak256` of one EIP-712 signature — and it is the
root for all three derivations above. ed25519 happens to use it *verbatim*; the encryption and
issuing keys use it through HKDF. Deleting the ed25519 derivation therefore:

- keeps the seed,
- keeps the X25519 encryption key and the secp256k1 issuing key **byte-identical**,
- and costs **no extra user signature** — it removes a local computation, not a prompt.

HKDF's one-wayness is what makes this safe in the direction that matters: **a leaked issuing key
cannot recover the seed**, and therefore cannot reach the holder identity or the encryption key.
The distinct `info` strings are what keep the three independent of each other.

The 48-byte output for the issuing key is deliberate. 384 bits reduced `mod (n-1)` then `+1`
gives a scalar in `[1, n-1]` with bias around 2⁻¹²⁸, so there is **no retry loop and no throw**:
the "invalid scalar" case of naive 32-byte derivation cannot occur at all. `deriveIssuingKey`
throws on a malformed seed, never on a seed *value*.

### Why the issuing key is generation-parameterised

`gen` is appended to the HKDF info in decimal, which makes the issuing key **rotatable without a
new secret at rest**. A rotation is a public issuer-registry statement bumping the generation —
not a new escrow slot. Because the escrowed seed re-derives every generation byte-identically,
account recovery cannot fork the issuer identity. That is a structural guarantee, not a guard
someone has to remember to write.

---

## 4. What changed in the issuer-curve migration (#443)

This is the part most likely to be stale in anyone's head, including older docs in this
repository.

| | Before | Now |
|---|---|---|
| Issuer key | ed25519 (a second use of the holder key's curve) | **secp256k1**, HKDF sibling |
| Issuer identity of record | 64-hex ed25519 public key | **20-byte address** (`IssuerAddress`, `0x` + 40 hex) |
| Signature scheme | raw ed25519 | **EIP-191 `personal_sign`** over an ASCII message |
| Formats | `woco.manifest.v1`, `woco.ticket.v2`, `woco.pod-cert.v1` | `woco.manifest.v2`, `woco.edition.v1`, `woco.cert.v1` |
| Old formats | — | **Deleted and dispatch-refused.** Every verifier switches on `format` first; a v1 object fails that dispatch whole. Nothing branches on it. |

Three reasons the identity became an address rather than a public key: recovery yields an address
natively; it is the secp identity unit used everywhere else in the system; and 42 characters
versus 64 keeps issuer fields **shape-distinct** from every other 64-hex key in the codebase, so
one can never be pasted where the other belongs.

**The holder side did not move.** A holder is still a bare lowercase 64-hex ed25519 key, cert
challenges are still ed25519-signed, and the credits rail still signs with it. So the accurate
one-line summary is: *the issuer went to secp256k1; the holder stayed ed25519* — not that
ed25519 left the system.

### The v2 issuer signing scheme, and why it is not raw ECDSA

Every v2 issuer signature is EIP-191 `personal_sign` over a **domain-prefixed ASCII message**.
There are two shapes, not one:

```
woco-manifest-v2\n{0x + 64-hex digest}              83 bytes   (manifests, certs)
woco-issuer-binding-v1\n{parent}\n{gen}             ≥67 bytes  (the binding PoP)
```

Never raw ECDSA over a bare 32-byte digest — and the reason is a real cross-protocol attack, not
hygiene. The Swarm feed signer `personal_sign`s 32-byte chunk digests (bee-js wraps them
`\x19Ethereum Signed Message:\n32`). An unprefixed issuer scheme would therefore be forgeable
across the two protocols. What matters is that **no issuer message can ever be 32 bytes** — both
shapes are comfortably longer — and that their domain lines keep them disjoint from each other,
since the same key signs both. Pinned by
`packages/shared/test/crypto/cross-protocol.test.ts`.

Two further rules hold everywhere:

- **Verification recovers the address and compares.** Nothing in the system ever keys off
  signature bytes, because ECDSA signatures are malleable.
- **High-`s` signatures are refused, not normalised.** Without that refusal every signature has
  a second valid encoding.

Signing domains in use: `woco-manifest-v2`, `woco-cert-v1`, `woco-issuer-binding-v1`.

### The issuer-binding proof of possession

Every create payload carries an `IssuerBindingV1`, and the server pins `parent → issuerAddress`
at creation time. The signed message is exactly:

```
woco-issuer-binding-v1\n{0x + 40-hex lowercase parent}\n{gen}
```

**Why the signed manifests in the same payload are not proof enough:** a manifest proves its key
exists and signed *that manifest*. Manifests are public, so anyone could replay someone else's
into their own authenticated create and have a foreign issuer address pinned to their parent.
The binding closes it — the issuing key signs the *parent it belongs to*, and a replayer cannot
produce that for a parent the key never named.

The `issuer` field is deliberately redundant (recovery of `sig` already yields it) so the
verifier can tell "wrong key" from "garbled message" and say so, instead of silently pinning
whatever address a malformed signature recovers to. The server must check: recovered == `issuer`
**and** `issuer` == every manifest's `issuer` in the payload. The pin lands in
`.data/issuer-bindings.json`.

The parent address must arrive **lowercase**, and a checksummed one is refused rather than
folded: a checksummed parent signed here would verify against nothing.

---

## 5. The content-feed signer, and why it is stored rather than derived

The feed signer is a **secp256k1 key whose address owns the user's content chunks**. Derivation
only *seeds* it. After that the key is persisted and escrowed, and the stored copy is
authoritative.

That distinction is load-bearing. A passkey credential **rotates** on guardian recovery, so
anything re-derived from it after a recovery diverges — and a divergent feed key silently
orphans every feed the user owns. So:

- at rest: AES-256-GCM under a non-extractable device key in IndexedDB, with the parent address
  bound as AEAD **additional data** (`apps/web/src/lib/auth/feed-signer-store.ts`);
- across devices and after recovery: restored from the escrow bundle, same channel as the seed;
- keyed **per account**. A single global slot let a second account on the same browser overwrite
  — and, via the mismatch self-heal, *delete* — the first account's key.

An AAD mismatch on read drops only *this* account's slot, never the legacy shared slot, which
may still belong to a different account that has yet to migrate it.

The object-data seed is stored the same way, under the same rules.

---

## 6. Sealed order envelopes

When an attendee buys, their order data is encrypted so that **only the organiser** can read it,
and it stays encrypted on public storage. This runs on every claim, even for an event with no
order-form fields at all.

The construction is textbook ECIES (`packages/shared/src/crypto/ecies.ts`):

```
seal:  fresh ephemeral X25519 keypair
       shared = X25519(ephPriv, organiserPub)
       aesKey = HKDF-SHA256(shared, salt = ephPub, info = "woco/order/v1", 32)
       ct     = AES-256-GCM(aesKey, iv = 12 random bytes, plaintext)
       →  { ephemeralPublicKey, iv, ciphertext }

open:  shared = X25519(organiserPriv, ephPub)   → same HKDF → same key → decrypt
```

Properties, and where each comes from: forward secrecy per message (a fresh ephemeral key every
time); authenticated encryption (the GCM tag makes tampering a decryption failure); domain
separation (the ephemeral public key as HKDF salt); and only the recipient's private key opens
it. AES-GCM runs on Web Crypto, so it is hardware-accelerated and constant-time.

The organiser's X25519 **public** key is published in the event feed as `encryptionKey`. The
matching private key is the HKDF sibling of their object-data seed — so the organiser derives it
on any device with no extra prompt, and the platform never holds it. The sealed blob is uploaded
to Swarm and its 32-byte reference goes **on chain** as the ticket's `orderRef`.

There is a compressed variant, `sealJsonCompressed`, for payloads that scale with a user's data
(a marketing contact list, where hex encoding doubles the size against a server-side cap). It
gzips before sealing. That leaks a size signal about the plaintext, which is only exploitable by
an adversary who can both inject chosen content *and* repeatedly observe the sealed size
(CRIME/BREACH) — not reachable for a list an organiser writes at their own pace, and the
alternative is a list too large to store, which is a certain failure rather than a theoretical
one. `openJsonAuto` reads either form by sniffing the gzip magic number, because the framing has
to be decided before the payload can be parsed.

---

## 7. When each key is established

Nothing is signed at login. Login only connects.

| Trigger | What it establishes |
|---|---|
| First action needing the API | `ensureSession()` → the EIP-712 delegation |
| Publish, or first dashboard decrypt | `ensurePodIdentity()` → the object-data seed |
| Publish (issuance) | `ensureIssuingKey()` → derive from the seed |
| First content write | the content-feed signer (silent for raw-key logins) |

`ensureIssuingKey()` (`apps/web/src/lib/auth/issuing-key.ts`) is a thin wrapper with one rule:
**fail loud, never fall through.** With no seed available it throws. It must never quietly hand
back some other signer — the feed key, the session key, a fresh random key. Every one of those
"works" at signing time and produces credentials that verify against nothing, discovered at a
door. The one legitimate no-seed state is a recovered account whose escrow restore has not yet
run, and the error says exactly that.

---

## 8. Login methods

The authoritative list is the `AuthKind` union in `packages/shared/src/auth/types.ts`:
`"web3" | "passkey" | "web3auth" | "coinbase" | "zupass" | "none"`.

| Shown as | Kind | Parent account | State |
|---|---|---|---|
| Passkey | `passkey` | ZeroDev Kernel on Arbitrum One; sudo signer is a secp256k1 key derived from the passkey's PRF extension | Live |
| Email | `web3auth` | Also a Kernel | Live, on a Web3Auth **devnet** project |
| Wallets | `web3` | MetaMask / WalletConnect EOA | Live |
| Coinbase | `coinbase` | Coinbase Smart Wallet | Built, `coinbaseLoginAllowed = false` |
| Zupass | `zupass` | — | In the union, **not implemented** |

**Why Coinbase Smart Wallet is off** is worth understanding, because it is the clearest
illustration of what sign-to-derive costs. A smart account's signatures are not
byte-reproducible: ERC-6492-wrapped before deployment, bare ERC-1271 after — definitional, not a
quirk. Feeds already park CSW users; object-data identity does not. So a CSW user's
ticket-signing and dashboard-decryption identity would **fork on an ordinary logout→login**. The
fix is a CSW escrow path (a random seed and feed key, escrowed and restored per device), not a
workaround. The rule it establishes: **never sign-to-derive for a smart account.**

Passkey and email logins are both Kernels, so both are subject to credential rotation and both
depend on escrow for identity stability. `apps/web/src/lib/auth/` carries the full state machine;
`auth-store.svelte.ts` is the entry point.

**Removed, and not to be reintroduced from older docs:** the Para embedded wallet and the local
encrypted browser account were both deleted to cut eager bundle size. `SiteLoginModal.svelte:3`
and `backup-signer.ts:173` carry comments explaining why.

---

## 9. API authentication

Two independent layers. Neither happens at login — login only connects.

### The delegation (EIP-712, once per 30 days)

The parent wallet signs an `AuthorizeSession` message delegating to a freshly generated session
key:

```
AuthorizeSession {
  host, parent, session, purpose, nonce,
  issuedAt, expiresAt, sessionProof, clientCodeHash, statement
}
```

`host` is in the signed payload, which is why **`ALLOWED_HOSTS` is the host security guard** —
`SESSION_DOMAIN` deliberately carries no chainId, so the host is what scopes a delegation to an
origin. A frontend host missing from `ALLOWED_HOSTS` gets a 403 on every authenticated call.

### The per-request signature (EIP-191, every call)

The session key signs a canonical challenge:

```
woco-session-v1\n{METHOD}\n{path}\n{timestamp}\n{nonce}\n{sha256(rawBody)}
```

The server rebuilds it and `verifyMessage`s it. Timestamp window ±5 minutes. Everything travels
in headers:

```
X-Session-Address · X-Session-Delegation (b64 JSON) · X-Session-Sig
X-Session-Nonce   · X-Session-Timestamp
```

**The body hash is over raw bytes.** The server must call `c.req.text()` *before* any parse, and
the client must hash exactly the bytes it sends. A parse-and-restringify on either side changes
the bytes — different key order, different whitespace — and every request fails with a signature
error that looks like a key problem and is not.

### Two rules that hold everywhere

- **The server acts on the parent address it *verified*.** Never one from a request body. An
  address in a payload is a routing hint at most.
- **A rejection is classified.** `VerifyDelegationResult.code` distinguishes "mint a fresh
  delegation and retry" from "this cannot be fixed that way", so the client does not loop on an
  unfixable refusal.

Revocation: `POST /api/auth/revoke-session` (one nonce) or `/api/auth/revoke-all` (every session
for a parent issued before now). State lives in `.data/revoked-sessions.json` — losing that file
un-revokes.

Paths that deliberately need no session: guest Stripe checkout from the embed widget, the public
ticket page `/t/…`, and the ENS CCIP-Read gateway.

Server side: `apps/server/src/middleware/auth.ts` and
`apps/server/src/lib/auth/verify-delegation.ts`. Client side:
`apps/web/src/lib/api/client.ts` (`authPost` / `authGet` / `buildAuthHeaders`).

---

## 10. Signing roles, in one table

| Signer | Signs | Never signs |
|---|---|---|
| Parent account | `AuthorizeSession`; issuer-registry rotation statements (EIP-712) | API requests, feeds, tickets — **and, for a Kernel, the two derivations** (§2) |
| Session key | Every authenticated API request (EIP-191 canonical challenge) | Anything durable |
| Content-feed signer | The user's content chunks (profile, event, site, likes, follows) | Credentials |
| Issuing key | `woco.manifest.v2`, `woco.cert.v1`, the issuer binding | Individual editions |
| Holder identity (ed25519) | Cert possession challenges, credit statements — **both out of launch scope** | Tickets. Editions. Manifests. Anything on a live path (§3a) |
| **Ticket burner (secp256k1)** | **The ticket.** One per-purchase key signs one canonical message, then is discarded. Its address is the on-chain `slotOwner` — the verifier's trust root | Anything else, ever |
| Platform feed key | More than its name suggests: the directory pointer, the **site events index** (a deliberate trust carrier — see below), the creator site directory, the issuer-registry log relay, recovery status, the marketing-list pointer, shop config, the passport collection, **and any event or site feed whose client sent no feed signer** | Producing a signature for a key it does not hold — it cannot forge a user's signed object |
| Sponsor wallet | Chain transactions: `registerEvent`, `batchClaimFor` | Anything a user authors |
| ENS gateway key | CCIP-Read answers for `*.woco.eth` | Anything else |

The invariant behind the whole table: **the parent never signs feeds or requests, and no signer
ever substitutes for another.** Substitution is the failure this design exists to prevent,
because it produces credentials that look correct and verify against nothing.

### The honest limit: signer discovery

Read that platform-feed-key row carefully, because it marks the one place the server sits in the
**trust** path rather than the convenience path. A reader verifying an event's chunk needs to know
*which signer address should own it*, and today that answer comes from a platform-signed carrier —
the directory entry, or the site events index, which `routes/sites.ts` calls "a server-written
trust carrier ... consumed on the claim/payment path".

So a compromised server cannot forge a signed object, but it **can point a reader at a different
author**. Nothing in the bytes contradicts it.

The repository already contains the fix for this shape of problem, applied to a different key:
the **issuer registry** (`packages/shared/src/issuer/types.ts`) is parent-signed EIP-712
statements in the parent's own feed, so any client verifies `parent → issuerAddress` from the
bytes alone and the server "attests nothing a verifier needs to believe". The same pattern would
close signer discovery. It has not been applied there yet.
