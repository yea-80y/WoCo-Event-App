# Identity and keys

Every key a WoCo account has, what derives it, what it signs, and why it exists.

**Verified against `main` on 2026-09-08.** Every constant below is quoted from the file that
defines it; that file is the authority, not this document.

> **Naming (2026-09-10).** The retired noun is gone from prose AND from every code name,
> file name and wire literal, so a future 0xPARC integration arrives into an empty
> namespace. The product noun is **object** (always compounded — `ObjectKind`,
> `objectEntry` — never a bare `object`/`Object` identifier); the key material is the
> **identity seed**. Topics are `woco/object/*`, the storage key is
> `woco:auth:identity-seed`. The ONE frozen thing is the account-keys EIP-712 message
> (`ACCOUNT_KEYS_DOMAIN` / `ACCOUNT_KEYS_TYPES` / `ACCOUNT_KEYS_NONCE` /
> `ACCOUNT_KEYS_PURPOSE`), renamed separately on the same day and byte-pinned since.

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
                              ┌──────────────┐ ┌─────────────────────┐
                              │ ENCRYPTION   │ │ ISSUING KEY         │
                              │ X25519       │ │ secp256k1           │
                              │ HKDF         │ │ HKDF, generation-   │
                              │ "woco/       │ │ parameterised       │
                              │  encryption/ │ │                     │
                              │  v1"         │ │ Signs editions +    │
                              │              │ │ manifests. Identity │
                              │ Opens sealed │ │ of record = its     │
                              │ orders       │ │ 20-byte ADDRESS     │
                              └──────────────┘ └─────────────────────┘
```

Four keys, and the count is not incidental — each one exists because a *role* had to be
separated, not because a layer was convenient. There used to be a fifth, an ed25519 holder
identity derived from the seed; it is gone from every launch path (§3a).

---

## 2. Sign-to-derive: ONE signature, and everything hangs off it

There is exactly one sign-to-derive step left. The object-data seed is produced this way; the
content-feed signer used to have a second signature of its own and no longer does — it is an
HKDF sibling of this seed (§5).

**Who signs matters more than it looks.** For a passkey or email login the signer here is the
**raw secp256k1 key beneath the Kernel** — the PRF-derived key, or the Web3Auth key — obtained
via `_getSeedSigner()`, never `_getSigner()`. This is "invariant #1" in
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
SESSION_DOMAIN       salt 0x6f4cd6d4…cbe3   (session delegation)
ACCOUNT_KEYS_DOMAIN  salt 0x8aee4359…085a   (the account seed — everything below it)
RECOVERY_ENC_DOMAIN  salt 0x7647dc11…8a20   (a guardian's escrow key)
```

— `packages/shared/src/auth/eip712.ts`

**A fresh device therefore needs two signatures**, once: the session delegation, and this. Both
are deferred to the first action that needs them, not taken at login.

**These bytes are FROZEN from launch.** The domain name, version and salt, the primary type name
`DeriveAccountKeys`, all three field names and types, the `purpose` string and the `nonce` are
every one of them signed input. Change any of them and every account derives a different seed:
sealed orders stop decrypting, issuer identities move, and every content chunk the user owns is
stranded under an address nothing looks at. The `purpose` string is the trap — it reads like UI
copy, wallets render it, and it is a key. `apps/web/test/identity-vectors.test.ts` fails on a
one-byte change. (The message was renamed off its retired predecessor on
2026-09-10 — a deliberate pre-launch break, made while there were no users to carry, so that the
sheet a person signs says what it does. The salt was deliberately not churned.)

Two details that took real defects to learn:

- **Hash the signature *bytes*, not the hex string.** `keccak256(getBytes(sig))` hashes 65
  bytes; `keccak256(toUtf8Bytes(sig))` would hash 132 ASCII characters. The byte form is the
  ecosystem standard. Changing which one you hash changes every user's identity.
- **External wallets get signed twice.** We control the nonce generation of our own signers
  (ethers → RFC-6979, deterministic). We do not control MetaMask's. So for external-wallet kinds
  the account-keys derivation signs twice and **throws on mismatch** — an irreproducible wallet
  would leave that user with a different encryption key, a different issuer address and a
  different feed signer on their next device, and the failure has to happen at setup, loudly,
  not at the door. It never falls back to platform signing as a consolation. (The check used to
  sit on the feed-signer signature; it moved up to the seed with everything else, and now covers
  all three keys instead of one.)

---

## 3. The siblings off one seed

One 32-byte seed produces two keys on two curves, and their independence is the whole point.
(A third sibling, an ed25519 holder key, still exists for two out-of-launch-scope rails — but
nothing on a launch path derives it, and no auth path knows about it: §3a.)

| Key | Curve | Derivation | Defined in |
|---|---|---|---|
| Encryption | X25519 | `HKDF(sha256, seed, salt="", info="woco/encryption/v1", 32)` | `packages/shared/src/crypto/keys.ts` |
| Issuing | secp256k1 | `HKDF(sha256, seed, salt="", info="woco/issuing/v1/"+gen, 48)` → scalar | `packages/shared/src/crypto/issuing.ts` |

### 3a. The ed25519 holder key is gone from every launch path (#518)

**Tickets are signed by the per-purchase burner key (secp256k1)**, verified against the on-chain
`slotOwner` (`packages/shared/src/ticket/canonical.ts`). Editions and manifests are signed by the
**issuing key**. `edition/types.ts` states it without qualification: *"no ed25519 anywhere on the
issuer side."* The ed25519 holder key signed **no ticket and owned no ticket** — so it was
removed from the auth store, from event create (`creatorObjectKey`), and from every gate binding
and checkout (`holderPubKey`, which was self-declared and verified against nothing, #345).

What is left, in full:

| Use | Kind | Status |
|---|---|---|
| `woco.cert-challenge.v1` possession signature | **signature** | Cert rail — **out of launch scope** |
| `woco.credit.v1` `holderSig` | **signature** | Credits rail — out of launch scope |

Both are frozen formats that specify the curve, so the key survives — but it is now derived
**lazily, by the rail that needs it, from the seed**, and dropped after the call:
`apps/web/src/lib/credits/holder-key.ts`, whose `@noble/ed25519` import is DYNAMIC so the curve
stays out of the eager bundle (pinned by `apps/web/test/no-eager-ed25519.test.ts`). No auth
surface exposes an ed25519 key any more; `ensureIdentitySeed()` returns a boolean saying whether
the SEED is available.

**Consequence for the certificate rail, stated plainly:** the platform now holds no holder
identity for any attendee, so `/api/events/:id/attendee-keys` serves none and the issuance
surface reports every attendee as un-certifiable. The organiser's paste path still works. The
join comes back when the cert rail migrates to secp256k1.

**The distinction that matters, because the obvious reading is wrong:** the **seed is not the
ed25519 account.** The seed is 32 bytes — `keccak256` of one EIP-712 signature — and it is the
root for every derivation. ed25519 happens to use it *verbatim*; the encryption and issuing keys
use it through HKDF. Dropping the ed25519 derivation from the launch paths therefore:

- keeps the seed,
- keeps the X25519 encryption key and the secp256k1 issuing key **byte-identical**,
- and costs **no extra user signature** — it removed a local computation, not a prompt.

HKDF's one-wayness is what makes this safe in the direction that matters: **a leaked issuing key
cannot recover the seed**, and therefore cannot reach the encryption key (or the holder key the
out-of-scope rails derive). The distinct `info` strings are what keep the siblings independent of
each other.

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
| Formats | `woco.manifest.v1`, `woco.ticket.v2`, the v1 cert format | `woco.manifest.v2`, `woco.edition.v1`, `woco.cert.v1` |
| Old formats | — | **Deleted and dispatch-refused.** Every verifier switches on `format` first; a v1 object fails that dispatch whole. Nothing branches on it. |

Three reasons the identity became an address rather than a public key: recovery yields an address
natively; it is the secp identity unit used everywhere else in the system; and 42 characters
versus 64 keeps issuer fields **shape-distinct** from every other 64-hex key in the codebase, so
one can never be pasted where the other belongs.

**The holder side did not move — but it did leave the launch paths.** A holder is still a bare
lowercase 64-hex ed25519 key, cert challenges are still ed25519-signed, and the credits rail
still signs with it. What #518 removed is everything ELSE that carried an ed25519 key around:
the auth store's copy, `creatorObjectKey` on event create, and `holderPubKey` on checkouts and gate
bindings. So the accurate one-line summary is: *the issuer went to secp256k1; the holder stayed
ed25519, and now only two out-of-scope rails ever derive it*.

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

## 5. The content-feed signer is a sibling of the seed, not a secret of its own

The feed signer is a **secp256k1 key whose address owns the user's content chunks**, derived
`HKDF(sha256, seed, salt="", info="woco/feed-signer/v1", 48) → scalar`
(`packages/shared/src/crypto/feed-signer.ts`) — the same construction as the issuing key, under
a different `info`.

**It used to be an independent secret**, established by a second sign-to-derive signature under
its own domain, then persisted and escrowed, with a rule that the stored copy always won. That
rule existed for a real reason: a passkey credential **rotates** on guardian recovery, so
anything re-derived from the credential after a recovery diverges, and a divergent feed key
silently orphans every feed the user owns.

Folding it into the seed keeps that property and removes the machinery:

- the seed is the single durable secret, in one AAD-bound slot (§7), so there is no second blob
  to keep in step and no way to restore half an account;
- a rotated credential still cannot fork the feeds, because it cannot change the **seed** — the
  seed comes back verbatim from escrow, and the signer falls out of it;
- the escrow bundle and the cross-device portability envelope both carry `identitySeed` and nothing
  else, so an envelope written by any path is complete by construction;
- one signature, not two, on a fresh device.

**Coinbase Smart Wallet remains parked.** Its 1271/6492 signatures are non-deterministic, so it
cannot establish a reproducible seed at all — the feed signer resolves to `null` and its content
falls back to the platform-signed path. That is the one remaining exception.

**External wallets are checked, not trusted.** We control the nonce generation of our own signers
(ethers → RFC-6979); MetaMask's is not ours. So for external-wallet kinds the account-keys
message is signed **twice** and a mismatch **throws** at setup — one wallet's irreproducible
signature would otherwise cost that user their encryption key, their issuer address and every
chunk they own, silently, on their next device. The check moved here from the old feed-signer
derivation when the feed signer stopped having a signature of its own; it now protects strictly
more.

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
| Publish, or first dashboard decrypt | `ensureIdentitySeed()` → the account seed (the only remaining derivation signature) |
| Publish (issuance) | `ensureIssuingKey()` → HKDF from the seed, no prompt |
| First content write | the content-feed signer → HKDF from the seed, no prompt of its own |

Only two rows there cost a signature. The issuing key and the feed signer are computed from the
seed, so once it exists they are free — and a web3auth login establishes the seed silently at
login (its raw key is in memory and ethers signs it with RFC-6979), which is what makes a cold
device render that user's own profile and avatar instead of a blank.

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
| Holder identity (ed25519) | Cert possession challenges, credit statements — **both out of launch scope**, and it is derived on demand from the seed rather than held (§3a) | Tickets. Editions. Manifests. Anything on a live path |
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
