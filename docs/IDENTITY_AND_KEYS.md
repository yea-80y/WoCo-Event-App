# Identity and keys

Every key a WoCo account has, what derives it, what it signs, and why it exists.

**Verified against `main` (94364b56) on 2026-10-05.** Every constant below is quoted from the
file that defines it; that file is the authority, not this document.

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
  │  A KERNEL NEVER SIGNS THE SEED DERIVATION (invariant #1). For email    │
  │  it is signed by the RAW Web3Auth key beneath it, because a smart      │
  │  account's 1271 signatures are non-deterministic. A PASSKEY account    │
  │  signs nothing for it: its seed is HKDF of the PRF output (§2, #642).  │
  └──┬──────────────────────────────────┬───────────────────────────────────┘
     │ AuthorizeSession                 │ the seed: a deterministic signature by
     │ (per session, by the Kernel       │ the RAW key (wallet/email, fixed nonce),
     │  or the EOA)                     │ or HKDF of the PRF output (passkey)
     ▼                                  ▼
  ┌──────────────────────┐    ┌──────────────────────────────────────────────┐
  │ SESSION KEY          │    │ IDENTITY SEED - 32 bytes, NOT a key          │
  │ secp256k1, random    │    │ the HKDF root of everything below            │
  │ 30-day expiry        │    └──────┬────────────────┬───────────────┬──────┘
  │ Signs every API      │           │                │               │
  │ request (EIP-191)    │           ▼                ▼               ▼
  └──────────────────────┘  ┌────────────────┐ ┌──────────────┐ ┌──────────────┐
                            │ ISSUING KEY    │ │ CONTENT-FEED │ │ ENCRYPTION   │
                            │ secp256k1      │ │ SIGNER       │ │ KEYPAIR      │
                            │ "woco/issuing/ │ │ secp256k1    │ │ X-Wing       │
                            │  v1/{gen}"     │ │ "woco/feed-  │ │ (ML-KEM-768  │
                            │ Signs          │ │  signer/v1"  │ │  + X25519)   │
                            │ manifests,     │ │ Owns the     │ │ Opens sealed │
                            │ certs, binding │ │ user's       │ │ orders and   │
                            │ Identity = its │ │ content      │ │ contact      │
                            │ 20-byte ADDRESS│ │ chunks       │ │ lists        │
                            └────────────────┘ └──────────────┘ └──────────────┘
```

Four keys: the parent, the session key, the issuing key and the content-feed signer. The seed is
not one of them; it is the root that also yields the encryption keypair. The count is not
incidental - each key exists because a *role* had to be separated, not because a layer was
convenient. There used to be a fifth, an ed25519 holder identity derived from the seed; it is gone
from every launch path (§3a). The classical X25519 key (`woco/encryption/v1`) still derives from
the seed for the quarantined credits rail only.

---

## 2. Sign-to-derive: ONE signature, and everything hangs off it

There is exactly one sign-to-derive step left. The identity seed is produced this way; the
content-feed signer used to have a second signature of its own and no longer does — it is an
HKDF sibling of this seed (§5).

**Who signs matters more than it looks.** For an email login the signer here is the
**raw secp256k1 key beneath the Kernel** — the Web3Auth key — obtained via `_getSeedSigner()`,
never `_getSigner()`. (A passkey login does not sign here at all — see below.) This is "invariant #1" in
`apps/web/src/lib/auth/auth-store.svelte.ts`: a Kernel's ERC-1271 signature is
non-deterministic, so deriving from it would corrupt the user's encryption and ticket-signing
identity on every login. It is also why the message's `address` field carries the raw key's
address rather than the Kernel's, and why the "never sign-to-derive for a smart account" rule in
§8 is consistent with this rather than contradicting it: we never do — we reach past the smart
account to the deterministic key underneath. Coinbase Smart Wallet has no such key to reach,
which is exactly why it is switched off.

```
signature = wallet.signTypedData(DOMAIN, TYPES, { purpose, address, nonce: FIXED })
seed      = keccak256(canonicalSignatureBytes(signature))   // 65 bytes: low s, v 27/28
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
are deferred to the first action that needs them, not taken at login — except for a passkey,
whose seed needs no signature and is set up at login (below).

**Passkey accounts are the exception: their seed is not a signature (#642).** A passkey has a
symmetric secret to start from — the 32-byte PRF output — so the seed roots on it:

```
seed = HKDF-SHA256(prfOutput, salt = "", info = "woco/identity-seed/passkey-prf/v1", 32)
```

Rooted on the signature, the seed was reproducible by anyone who could recover the Kernel owner
key (`keccak256(prfOutput)`) from its public key, which every owner signature reveals. Rooted
here, nothing between the authenticator and the seed passes through a secp256k1 key; the owner
key and the seed are both one-way images of the PRF output and neither reaches the other. The
portability envelope's two keys moved with it (`woco/recovery/portability/{soc-owner,hpke}/v2`),
because that envelope carries a recovered account's seed. Establishing the seed takes no
signature and no dialog — the biometric that produced the PRF output is the consent — and it
happens at login while that output is in memory, unless the recovery binding says the credential
was rotated in or the login could not read its portability envelope. A found envelope that names a
different seed is never overwritten by the back-fill: an account's seed does not change. All three
labels live in `packages/shared/src/crypto/passkey-prf.ts` and are pinned by
`identity-vectors.test.ts`; `PASSKEY_PRF_SALT_INPUT` is frozen twice over as a result.
What this does NOT cover: the Kernel owner, sessions and SOC signatures stay secp256k1, and a
recovered account's seed is still whatever its escrow carried (stored seed wins). The at-rest
slot's AAD moved to `woco/device/identity-seed/v2:{addr}` with it, so every device re-derives
under the new rule rather than keeping a seed from the old one.

**On the device, locked under the passkey (#746).** A passkey account's seed is not kept under
the browser's device key. It is AES-GCM under a key from the PRF output
(`woco/device/seed-kek/v1`, AAD `woco/device/identity-seed/v3:{seedAddr}:{parent}`), and survives
sign-out (it opens only with the passkey). The lock's label is pinned but sticky, not
identity-frozen: changing it costs each device one re-fetch of its seed.

An unlock - the sign-in, or the one confirm `auth.ensureOrganiserUnlock()` asks before an
organiser action - opens the seed for a window (`SEED_UNLOCK_POLICY`, two hours), through a copy
under the device key (`woco/device/identity-seed-window/v1:{seedAddr}:{parent}`) that a reload
opens silently and never extends; an expired copy is deleted, and an open tab locks on time. The
window is GitHub's sudo mode: the app's promise, not cryptography, and a browser gate on the
organiser screens rather than an API boundary.

Everyday posts never ask. They sign with the content-feed signer, an HKDF child of the seed that
opens neither the seed, the attendee-data key nor the issuing key, kept under the device key with
no expiry (`woco/device/feed-signer/v1:{seedAddr}:{parent}`, `ensureContentSigner()`). Sign-out, a
heal and a removed device delete the window copy and the cached signer; a relock keeps the signer.
Passive reads use a public record of the feed-signer address, checked against the account.

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
- **Hash one encoding of the signature.** v as 0/1 or 27/28, s low or high, 65 bytes or the
  64-byte compact form all recover the same address, so a wallet may return any of them.
  `canonicalSignatureBytes` (`packages/shared/src/auth/canonical-signature.ts`) maps them all to
  low s, v 27/28 before hashing, and refuses anything else (#186). Canonical input passes through
  unchanged. The wallet backup's escrow master (`deriveGuardianKeys`) is hashed the same way.
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

One 32-byte seed produces the issuing key, the content-feed signer and the encryption keypair,
and their independence is the whole point. (An ed25519 holder key and a classical X25519 key
still derive from it for two out-of-launch-scope rails - but nothing on a launch path derives
them, and no auth path knows about them: §3a.)

| Key | Curve | Derivation | Defined in |
|---|---|---|---|
| Issuing | secp256k1 | `HKDF(sha256, seed, salt="", info="woco/issuing/v1/"+gen, 48)` → scalar | `packages/shared/src/crypto/issuing.ts` |
| Content-feed signer | secp256k1 | `HKDF(sha256, seed, salt="", info="woco/feed-signer/v1", 48)` → scalar (§5) | `packages/shared/src/crypto/feed-signer.ts` |
| Encryption (#642) | X-Wing (ML-KEM-768 + X25519) | `X-Wing.keygen(HKDF(sha256, seed, salt="", info="woco/encryption/xwing/v1", 32))` | `packages/shared/src/crypto/xwing.ts` |
| Encryption, classical (credits rail only) | X25519 | `HKDF(sha256, seed, salt="", info="woco/encryption/v1", 32)` | `packages/shared/src/crypto/keys.ts` |

X-Wing replaced X25519 on every launch rail: orders and contact lists are sealed to this key, and
the recovery escrow's key wrap uses the same KEM under the guardian's own key. The X25519 key
survives only for the quarantined credits rail and the private statement-topic salt
(`statement/discipline.ts`). Sealing is HPKE (RFC 9180) over the X-Wing KEM, one box format `{ v: 2, enc, ct }` bound to its use and its subject
(`packages/shared/src/crypto/sealed-box.ts`). Both modules are subpath imports, loaded only where
a box is sealed or opened.

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
ed25519 account.** The seed is 32 bytes — `keccak256` of one EIP-712 signature, or HKDF of the
PRF output for a passkey — and it is the root for every derivation. ed25519 happens to use it
*verbatim*; the encryption and issuing keys
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
and it stays encrypted on public storage. This runs on every sale, even for an event with no
order-form fields at all.

Since #642 the box is the **v2 sealed box** (`packages/shared/src/crypto/sealed-box.ts`): HPKE
(RFC 9180) base mode with the X-Wing hybrid KEM (ML-KEM-768 + X25519), HKDF-SHA256 and
AES-256-GCM. A box copied off public storage today stays closed to a future quantum computer, and
it holds while either half of the hybrid does.

```
box  = { v: 2, enc, ct }                 // suite implied by v; any other v is refused
info = "woco/order/v2"
aad  = "woco/order/v2:{eventId}:{seriesId}"   // a box lifted into another event/series fails
```

The organiser's X-Wing key is an HKDF sibling of their seed (`woco/encryption/xwing/v1`), so they
derive it on any device with no prompt and the platform never holds it. Its 1216-byte **public**
key is too big to sit in every event feed, so the server publishes it at create as its own chunk
(on the WoCo batch too when the event lives on Etherna, and whitelisted before the create
succeeds) and the feed carries only `encryptionKeyRef`, its content address
(`packages/shared/src/event/order-key.ts`). A buyer's browser fetches the chunk from the WoCo
gateway and refuses it unless it hashes to the ref; the order form renders only with a verified
key, and a checkout with an order form is refused rather than taken unsealed. The organiser's
client refuses to sign a server-assembled feed naming any other ref. Its reference goes **on
chain** as the ticket's `orderRef`; the dashboard opens each order with the slot's own series.
Checkout takes only references the server issued itself — over canonical bytes, so a copy of a box
lands on its original's reference, with a signed token from `prepare-order` — and one completed
sale per reference, so no ticket can carry another buyer's sealed details (#661,
`apps/server/src/lib/stripe/order-ref.ts`).

**Paid-only storage (#546).** The box reaches Swarm only once its sale is paid. Until then the
server holds the ciphertext (`.data/held-orders/`); an unpaid hold is deleted after 24 hours. A
paid box is stored on a dedicated attendee batch, and the server records which batch slot holds
each chunk (`attendee-slots.json`), so an operator can erase one order on request by overwriting
those slots (`lib/attendee-batch/burn.ts`). That reaches every storer of our stamp; it cannot
reach a copy someone else stamped, or a retrieval cache. When a browser sent no box, the server seals a minimal order
itself (ticket type, the buyer's email and address).

Contact lists use the same box with `woco/marketing-list/v2:{owner}`, gzipped first (a size
signal only exploitable with chosen content AND repeated observation; a list too large to store
is the certain failure). The recovery escrow wraps its key with the same KEM through HPKE.

The retired X25519-only ECIES survives only inside the credits rail
(`apps/web/src/lib/credits/legacy-seal.ts`, out of launch scope); `crypto/ecies.ts` is gone, and
`apps/web/test/no-legacy-seal.test.ts` fails if anything else uses the old seal.

---

## 7. When each key is established

Nothing is signed at login. Login only connects.

| Trigger | What it establishes |
|---|---|
| First action needing the API | `auth.ensureAccountSetup({ identity: false })` → the EIP-712 delegation |
| Publish, or first dashboard decrypt | `auth.ensureAccountSetup({ identity: true })` → the delegation and the seed, whichever this device lacks |
| Publish (issuance) | `ensureIssuingKey()` → HKDF from the seed, no prompt |
| First content write | the content-feed signer → HKDF from the seed, no prompt of its own |
| An organiser action on a passkey account | `auth.ensureOrganiserUnlock()` → opens the locked seed for the unlock window (§2) |

`ensureAccountSetup` is the ONE entry point. It plans the outstanding steps
(`lib/auth/account-setup-plan.ts`) and, for external wallets only, explains them first; call sites
never chain `ensureSession()` and `ensureIdentitySeed()` themselves, and never count the prompts.
How many a person sees depends on the login kind: a passkey sees no dialog (its session is signed
silently and its seed comes from the PRF output), a web3auth login signs both silently - the seed
at login, because its raw key is in memory and ethers signs with RFC-6979, falling back to one
confirm if that fails - and an external wallet shows two popups. The silent web3auth seed is what
makes a cold device render that user's own profile and avatar instead of a blank. The issuing key
and the feed signer are computed from the seed, so once it exists they are free.

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
| Passkey | `passkey` | ZeroDev Kernel on Arbitrum One. Root validator: ECDSA over a secp256k1 key derived from the passkey's PRF output, moved to WeightedECDSA (every passkey a co-owner) when a second passkey is added (§9) | Live. The only kind that can organise (#768) |
| Email | `web3auth` | Also a Kernel | Live, on a Web3Auth **devnet** project. Can upgrade in place to a passkey (§9) |
| Wallets | `web3` | MetaMask / WalletConnect EOA | Live |
| Coinbase | `coinbase` | Coinbase Smart Wallet | Built, `coinbaseLoginAllowed = false` |
| Zupass | `zupass` | — | In the union, **not implemented** |

**Why Coinbase Smart Wallet is off** is worth understanding, because it is the clearest
illustration of what sign-to-derive costs. A smart account's signatures are not
byte-reproducible: ERC-6492-wrapped before deployment, bare ERC-1271 after — definitional, not a
quirk. Feeds already park CSW users; the identity seed does not. So a CSW user's
ticket-signing and dashboard-decryption identity would **fork on an ordinary logout→login**. The
fix is a CSW escrow path (a random seed and feed key, escrowed and restored per device), not a
workaround. The rule it establishes: **never sign-to-derive for a smart account.**

Passkey and email logins are both Kernels. An email account's credential can rotate on guardian
recovery, so its identity stability depends on escrow (stored seed wins). A passkey account adds
no email or wallet backup (§9); its way back is its synced passkey and the devices it has linked,
and its seed travels between devices sealed. `apps/web/src/lib/auth/` carries the full state
machine; `auth-store.svelte.ts` is the entry point.

A Kernel can hold a sub-ENS name, and the registry treats the account as the holder: whatever
the account can be made to do, the name follows. WoCo's Kernels install only the guardian hook,
and that must stay so. A session key or an executor module on a name-holding Kernel would be
holder authority outside the registry's own rules (audit 950 design review).

**Removed, and not to be reintroduced from older docs:** the Para embedded wallet and the local
encrypted browser account were both deleted to cut eager bundle size (`e127c97`).
`SiteLoginModal.svelte` carries a comment explaining why.

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

`host` is in the signed payload and the server refuses any host not in **`ALLOWED_HOSTS`**
(`SESSION_DOMAIN` deliberately carries no chainId). That bounds which hosts a delegation can name,
but `host` is the client's own claim: it does not prove which origin asked for the signature, so a
wallet user tricked into signing on another site yields a valid delegation. The other fields
(`purpose`, `statement`, `clientCodeHash`) are not checked. A frontend host missing from
`ALLOWED_HOSTS` gets a 403 on every authenticated call.

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

**Known limit: `issuedAt` is the device's clock.** The server accepts a delegation dated up to 60 s
ahead of its own time, so one minted just before a revoke-all on a fast clock outlives it by up
to that minute. Left as is: minting a delegation takes the parent key, and whoever holds that can
mint a fresh one after the revoke anyway. Removing the passkey is what ends that (#186).

### More than one passkey: every passkey a co-owner (#746)

An account starts with one passkey: its PRF-derived key is the owner on ZeroDev's ECDSAValidator,
the Kernel root. When it adds its second passkey, ONE sponsored userOp moves the root to ZeroDev's
**WeightedECDSAValidator** - one signer per passkey, weight 1, threshold 1 - so any one passkey
signs userOps and ERC-1271 alone, and nothing ever moves between devices. That op is a batch,
`[changeRootValidator(weighted, no hook, list), uninstallValidation(ECDSA)]`: without the uninstall
the first passkey would keep an ERC-1271 path (names) that taking it off the list cannot close.
Later changes are `renew(list)`. Every list is 1..10 distinct keys, weight 1, threshold 1, no delay -
the validator accepts an empty list or an unreachable threshold, and the account is then locked for
good. Facts pinned against the bytecode deployed on Arbitrum One: WoCo-Contracts
`test/WeightedRootKernel.t.sol`. Calls: `apps/web/src/lib/auth/co-owner-calls.ts`; flows:
`co-owner-flows.ts`; reads: `kernel-account.ts` (`readKernelRoot`, `readCoOwners`,
`readKernelSignerFor`); constants: `@woco/shared/kernel/co-owners`.

**Who may sign in.** The server asks the chain (`accountSignerKind` in `lib/auth/kernel-owner.ts`):
the ECDSA owner while the root is ECDSA (unchanged), a key on the weighted list once co-owned. A
co-owned account is durably recorded (`kernel-deployed.json` `root: "weighted"`), after which an
unreadable chain refuses and the first passkey's counterfactual - true forever - is never evidence.
Each removed key is floored durably (`removed`), so no older read brings it back. A positive list
answer confirms for one minute.

**Device records.** Every added passkey still gets an EIP-712 `DeviceGrant { parent, grantee,
credentialTag, issuedAt, nonce }` (domain "WoCo Device Grant"), now signed by ANY co-owner and
registered at `POST /api/auth/device-grants`: it carries the date the screen shows, and its removal
(`RevokeDeviceGrant`) refuses that device at once (`DEVICE_REMOVED`), ahead of the minute-long chain
answer. On a co-owned account only the list admits: a key with a record that is NOT on the list is
refused as removed, even when a listed key signed its record - so a record removal that never arrived
cannot keep a removed passkey signed in. Devices linked by a record alone before co-owners stop
signing in when their account switches; the list shows them for removal. Removing a passkey takes it off the list FIRST, then removes the record - never the other way,
or a device with onchain control would be signed out while able to put itself back. The first
passkey has no record; the removal route floors it instead. Store: `.data/device-grants.json`.

**A device's role comes from the chain.** On the list = an owner on that device (recovery binding,
`_upgradeIfCoOwner` at restore, `_loginAddedPasskey` at sign-in). Every owner check that decides a
sign-in reads the list too (`readKernelSignerFor`: the key itself on the list, `NOT_ON_LIST` off it),
or the first passkey would read "no owner" after the switch.

**Adding another device.** The device being added makes its own passkey and shows a code (QR or 26
characters; not a URL, so only WoCo's own scanner can use it). Any of the account's devices scans it
and confirms with a fresh passkey sheet; it puts the new key on the list, registers its record (a
failed record takes the key off again), then sends the account and seed sealed (X-Wing) to a key that
lives only in the new device's memory for this pairing. Transport: a 10-minute in-memory mailbox
(`/api/pairing`) holding bytes the server cannot read (`pairing-channel.ts`, `device-link.ts`).
"Add a password manager here" does the same on one device: a fresh confirm, a passkey in the other
manager, on the list, its record.

**A removed device keeps what it already holds.** Removal stops a passkey signing in and acting
onchain, but the account's keys all come from one seed that never changes: a removed device can still
open attendee details it can reach and publish as the account. Hence "only your own devices - never
someone else's, staff included". A new attendee key on removal is deferred work.

**New-passkey alert.** Each device remembers the chain's list as last seen; a key added since then
is named on the next open ("Yes, it was me / No - remove it"). `new-passkey-alert.ts`.

**Unlocked accounts only.** An account's FIRST device record needs the unlock that names need - a
ticket in the account, Stripe verification, or a confirmed invite (`checkAttendeeGate`,
`routes/device-grants.ts`): each device stamps storage and every list change spends sponsored gas,
which nothing locked may do. Removal is never gated. Every sponsored userOp is first answered by
WoCo's ZeroDev policy webhook (`routes/zerodev-policy.ts`, #758), which pays only for WoCo's own
shapes - the switch and `renew` among them, and never a list that would lock an account.

**No email or wallet backups on passkey accounts (#746 step 5).** Every Protect-your-account backup
escrows the seed to an email or wallet key - a second way to the keys an organiser's attendee data is
sealed to, and a permanent one, since a Swarm copy cannot be recalled. So a passkey account adds none
(`setupAccountRecovery` refuses; Protect sends it to Your passkeys); existing ones stay removable.
Email-login accounts keep their options. A passkey account's way back is its synced passkey and the
devices it links. The refusal is the app's: the server cannot tell a passkey account from an email one.

**Organising needs a passkey account (#746 step 5, #768).** The organiser workspace opens only for a
passkey account (`lib/auth/organiser-account.ts`, gated in `CreatorApp.svelte` so deep links land on
the explanation), and "Start hosting" signs up with a passkey only. The server cannot tell a passkey
smart account from an email one - both are an EOA owning a Kernel, and the PRF never reaches it - but
it can tell a wallet: `verifyDelegation` reports `parentKind` ("eoa" when the wallet signed for
itself), and `POST /api/stripe/connect` refuses anything but "kernel". An email-login user organises
from a new passkey account; rotating their Kernel to a passkey would keep the email-rooted seed
(an in-place upgrade with a fresh passkey-rooted seed is planned, not built). Stripe onboarding links
and the embedded onboarding session refuse a non-smart-account parent too.

Paths that deliberately need no session: guest Stripe checkout from the embed widget, the door
scanner (a door-pass header instead), and the ENS CCIP-Read gateway. The ticket page needs no
server at all: it is a static file with the ticket in the URL fragment (#690); the old `/t/…`
route answers 410.

Server side: `apps/server/src/middleware/auth.ts` and
`apps/server/src/lib/auth/verify-delegation.ts`. Client side:
`apps/web/src/lib/api/client.ts` (`authPost` / `authGet` / `buildAuthHeaders`).

---

### An email account upgraded to a passkey, in place (#746)

Organising needs a passkey account, and an email or Google account would otherwise lose its
tickets to a fresh one. Instead it can hand itself to a new passkey: same Kernel address, so
tickets, names, the unlock and followers stay (all keyed by the account). Flow:
`apps/web/src/lib/auth/upgrade-to-passkey.ts` (pure, tested), its I/O in `upgrade-to-passkey-live.ts`,
the screen in `creator/gate/UpgradeToPasskey.svelte`.

- **Who.** Email/Google accounts, locked ones included. Not wallet accounts (no Kernel to switch),
  and not an account that hosts events or websites - its feed signer is pinned where the money path
  reads it (`event-feed-signers.json` is write-once; a site's events index carries it). Not a locked
  account that is already deployed either: its backup removal is an op only an unlocked account is
  paid for.
- **The op.** ONE sponsored userOp, signed by the email key: the co-owner switch with a list of ONE
  key, the passkey's, and the ECDSA validation uninstalled. A counterfactual account deploys in it.
  The email key is never kept as a co-owner (any co-owner holds full control). The server pays it
  as the `upgrade` shape (`lib/zerodev/sponsor-policy.ts`); for a locked account only against an
  intent its own session asked for just before (`POST /api/auth/upgrade-intent`, 10 a day per
  network - the webhook never sees the person's IP). No platform-wide cap: limits stop bad actors,
  the ZeroDev plan grows with demand. Any recovery route (email or wallet backups) is removed first,
  by its own op. Fork-tested: WoCo-Contracts `test/WeightedRootUpgradeFork.t.sol`.
- **The seed.** The new seed is the passkey's PRF seed (`passkeyIdentitySeed`) - never derived from,
  signed by or passed through the email key - sealed to the passkey only: its locked copy and its
  portability envelope, which is read back before the op. The old seed leaves the device once the
  op lands. Residual against a fresh account: a future break of the email key's curve links the
  email to the account address (who, not what) - the data keys never depended on it.
- **What moves to the new feed signer.** Anything a reader looks for under the CURRENT signer: the
  profile and an unconfirmed referral statement are copied before the op; likes and follows are
  retracted under the old signer before the op (`value: false`) and re-posted under the new one after,
  each only once the old signer reads it not-true again - a like pressed while the op was refused
  already counts, there - so the account never counts twice. The one residual: another device still
  signed in with the email key can write under the old signer until its session dies (at most the
  server's 5-minute owner cache; usually seconds). A visitor reading by the OLD signer (a confirmed referral's
  `refereeFeed`) sees the old copy, which stays.
- **Order and resume.** A device marker (`upgrade-marker.ts`, no secrets) records each stage. A
  refused op changes nothing past the prepared state: the same passkey retries it, or "Undo" puts
  the likes back. A tab closed after the op lands finishes at the next passkey sign-in.
- **The email login afterwards** is refused with "This account now opens with your passkey": at once
  on the upgrading device (tombstone), off the chain elsewhere - in the slow sign-in before anything
  is written, after the fast path in the background, and when a fresh session is refused.

## 10. Signing roles, in one table

| Signer | Signs | Never signs |
|---|---|---|
| Parent account | `AuthorizeSession`; issuer-registry rotation statements (EIP-712); on a co-owned passkey account, any one passkey signs userOps and ERC-1271 alone | API requests, feeds, tickets — **and, for a Kernel, the seed derivation** (§2) |
| Session key | Every authenticated API request (EIP-191 canonical challenge) | Anything durable |
| Content-feed signer | The user's content chunks (profile, event, site, likes, follows) | Credentials |
| Issuing key | `woco.manifest.v2`, `woco.cert.v1`, the issuer binding | Individual editions |
| Holder identity (ed25519) | Cert possession challenges, credit statements — **both out of launch scope**, and it is derived on demand from the seed rather than held (§3a) | Tickets. Editions. Manifests. Anything on a live path |
| **Ticket burner (secp256k1)** | **The ticket.** One per-purchase key signs one canonical message, then is discarded. Its address is the on-chain `slotOwner` — the verifier's trust root | Anything else, ever |
| Platform feed key | More than its name suggests: the directory pointer, the **site events index** (a deliberate trust carrier — see below), the creator site directory, the issuer-registry log relay, recovery status, the marketing-list pointer, shop config, the passport collection, **and any event or site feed whose client sent no feed signer** | Producing a signature for a key it does not hold — it cannot forge a user's signed object |
| Ticket sponsor wallet | Chain transactions: `registerEvent`, `batchClaimFor` | Anything a user authors |
| Names sponsor (a separate key) | Sub-ENS mints, and relaying holder-signed pointer and release writes | Anything that repoints a name on its own - the platform holds no such key |
| Attendee-batch stamper | Postage stamps for paid order chunks, and the burners that erase one (#546) | Any feed or user content |
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
author**. Nothing in the bytes contradicts it. Since #670 the server pins each event's signer at
create (`.data/event-feed-signers.json`, write-once), so a request can no longer re-point the money
path - but that record is still server state, not something a reader can check.

The repository already contains the fix for this shape of problem, applied to a different key:
the **issuer registry** (`packages/shared/src/issuer/types.ts`) is parent-signed EIP-712
statements in the parent's own feed, so any client verifies `parent → issuerAddress` from the
bytes alone and the server "attests nothing a verifier needs to believe". The same pattern would
close signer discovery. It has not been applied there yet.
