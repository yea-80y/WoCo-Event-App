# Coaster Credits — Attested Credentials Plan

STATUS (2026-08-11): DESIGN. Not started. Origin: the Rita 100 charity challenge
(Digital Dan, September 2026) as the pilot for a general ride-credit system.

Companion to `docs/SWARM_SOCIAL_PLAN.md` — this shares its indexer, its trust model
and its portability commitments. Read that first; this doc only states the deltas.

## The model in one paragraph

A **credit** is an issuer-signed attestation that a holder rode a coaster. Attestations
accumulate as Merkle leaves; an issuer periodically signs ONE manifest over a batch of
them and publishes it to Swarm. Counts are computed by an indexer that reads public
batches, verifies signatures, and publishes a rebuildable index. No chain per credit,
no pre-committed supply, no account required to hold one. The POD layer stays — as the
display/identity object (name, artwork, subject, issuer) — but holdings come from
attestations rather than on-chain slots.

## What a user actually holds — the shape, settled

**One POD per coaster, with a count attached. NOT one POD per ride.**

- `Rita, Alton Towers` is a POD type. A rider holds it once, forever, from their first ride.
- Their ride count is **derived**, not stored on the POD: it is the sum of `count` across
  every attested leaf naming `(holder, subject)`. Ride 200 adds a leaf, not a POD.
- The POD carries the identity and the artwork — the thing a rider recognises and collects.
  The count is a computed property of it.

Why not a POD per ride: a POD type is a fixed-supply, pre-signed Merkle batch registered
on-chain (`issuePodType`), so "one per ride" would mean pre-committing to how many rides
will ever happen on Rita and paying to register each one. The count belongs in the
attestation layer, which is unbounded and free.

**Nothing is minted when a credit is collected.** No transaction, no supply consumed, no
per-rider cost. Collecting a credit appends a leaf to the next batch. That is the whole
operation.

The only on-chain surfaces in the entire design are optional and fixed-cost: an anchor
(below), and eventually an issuer registry — one transaction per coaster, one per handover,
never per credit or per rider.

## Why not an on-chain slot per credit

On-chain ownership earns its keep for a **ticket**: money, escrow, resale, an adversarial
door. A ride credit has none of those. It is soulbound, nobody will litigate over it, and
the property actually wanted — "the park attests this happened" — is a signature, not a
chain. Per-credit gas is small on Arbitrum but structurally wrong: a free product with
unbounded volume, marginal cost denominated in ETH, a permanently funded hot wallet to
monitor, and a griefing surface. It also forces a pre-committed supply
(`MAX_POD_SUPPLY = 10_000`), which the Rita challenge's "+1 lap per £1000" mechanic
makes unknowable by design.

### Anchoring, not sampling

Anchoring N credits with one transaction does NOT mean recording every 5th or 10th and
losing the rest. One Merkle root commits to **all** of them: publish the root, and any
single credit is provable by its inclusion proof. `manifestRef` is already exactly this.

A root is not a pre-commitment to a count — it commits to whatever set exists when it is
computed. So a challenge that grows from 100 laps to 109 needs no reservation, no resize
and no migration. That "reserve N slots up front" problem was an artefact of the on-chain
slot model and is deleted along with it.

### The live tracker is NOT the anchor

Two separate things, easily conflated:

- **Live count** — updates on every scan, instantly, straight off the queue/batch. No
  chain, no wait, no cost. This is what the tracker widget and the stream overlay read.
- **Anchor** — an optional, periodic notarisation of the batch digest. Slow, rare, fixed
  cost. Once per riding day, or once at the end.

The anchor buys exactly one property: it stops the **issuer** rewriting history after the
fact. That matters here precisely because WoCo is the issuer at launch and is also the
party asserting the lap count — an independent timestamp means the count is credible
without trusting us. It is not needed for the tracker to work.

## Data structures

New in `packages/shared/src/credit/`. Reuses the LOCKED primitives in
`packages/shared/src/pod/{canonical,merkle}.ts` — same encoder, same tree scheme, same
ed25519 signing. Do not fork them.

### Leaf — one per (holder, subject, session)

A leaf is a **session**, not a single ride. Proving 47 rides must not need 47 proofs, and
"8 rides on 14 September" is how it will be displayed anyway.

```ts
interface CreditLeafV1 {
  format: "woco.credit.v1";
  /** keccak256("woco:coaster:v1:" + stableId). See "Subject identity" below. */
  subject: Bytes32Hex;
  /** The holder's parent address — their durable account identity, not a burner. */
  holder: Hex0x;
  /** Rides in this session. */
  count: number;
  /** YYYY-MM-DD, issuer's local date. */
  sessionDate: string;
  firstAt?: string;   // ISO
  lastAt?: string;    // ISO
  evidence: "nfc" | "device" | "self";
  /** Dedup key — makes a replayed upload idempotent. */
  nonce: string;
}
```

Leaf hash = `keccak256(dagCbor(leaf))`, mirroring `podLeafHash`.

### Batch manifest — one signature per batch

```ts
interface CreditManifestV1Body {
  format: "woco.credit.manifest.v1";
  issuerPubkey: Hex32;        // ed25519
  subject?: Bytes32Hex;       // set when the batch is single-subject
  leafCount: number;
  metadataRoot: Bytes32Hex;   // Merkle root over leaves
  encoding: "cbor-v1";
  treeScheme: "oz-simple-v1";
  issuedAt: string;
  /** Digest of the issuer's previous batch — makes issuer history a hash chain,
   *  so an indexer can walk it and omission is detectable. */
  prevBatch?: Bytes32Hex;
}
```

Signed ed25519 by the issuer → `SignedCreditManifestV1`. One signature, one Swarm upload,
N credits. Cost per credit is postage on a few hundred bytes, amortised.

### Portable credit — what the holder actually keeps

```ts
interface PortableCreditV1 {
  leaf: CreditLeafV1;
  proof: MerkleProofV1;
  manifest: SignedCreditManifestV1;  // header only, no leaves
  batchRef: Hex64;                   // Swarm ref of the full batch
}
```

A few hundred bytes, verifiable **standalone** — no server, no feed lookup, no chain.
This is the object that makes "you own it" true rather than aspirational.

## Subject identity — decide before writing code

A POD type is *an issuance batch attesting to a subject*, never the identity itself.

```
subject = keccak256("woco:coaster:v1:" + <stable coaster id>)
```

Use **RCDB ids** as the stable id. RCDB is the Roller Coaster DataBase (`rcdb.com`) — a
free public catalogue of essentially every coaster in the world, with a stable numeric id
per ride (Rita is `rcdb.com/2919.htm` → `rcdb:2919`). It is the community's de facto
reference and the existing credit apps already key on it, so it gives an import path for
self-reported history. Caveat: there is no public API or data licence, so treat it as a
**naming convention we reference**, never as a database to scrape or mirror.

Add `subject` to `PodDirectoryEntry`.

A holder's count for a coaster = sum across every batch naming that subject, from any
issuer. That one indirection buys three things that are otherwise impossible:

- **Growth without supply limits** — no registration, no cap, no top-up problem.
- **Issuer handover** — a park issues under its own key, same subject, counts merge
  instead of forking. See the issuer registry below.
- **Trust display** — "47 rides · 12 verified by Alton Towers · 35 by WoCo".

## Issuer registry — the one thing chain is genuinely right for

Handing issuing rights to a park is a **trust** question: at the time a batch was signed,
was that issuer authorised for that subject? Answering it without a live call to a WoCo
server is exactly what a chain is good at, and the cost profile is the inverse of
per-credit minting — one transaction per coaster, one per handover. Tens of transactions,
ever, not millions.

```
IssuerRegistry:  subject => { issuer: bytes32 (ed25519 pubkey), since: uint64, until: uint64 }
                 transferIssuer(subject, newIssuer)
                 revokeIssuer(subject)
```

Why not a signed delegation instead: revocation. A signed "Alton Towers may issue for
Nemesis" is easy to publish and free, but a verifier can never prove it *wasn't* revoked
without a live source of truth. Revocation is chain-shaped; issuance is not.

Recording the authorised **period** also means historical credits survive a handover — a
batch signed by WoCo in 2026 stays valid after the park takes over in 2027, because the
registry says WoCo was authorised then. Without that, handover silently invalidates
everyone's back-catalogue.

`contracts/src/ContentHashRegistry.sol` is the precedent for a minimal registry of this
shape. Defer building it until a second issuer actually exists — but design the subject
identity now so it can be added without migrating anything.

## Identity — the minimum a collector needs

Credits accrue to the **parent address** — the account's durable identity. Possession is
proven with whatever signer that account already uses (passkey, web3, …), through the
existing `ensureSession` / `signRequest` path. No new key type, and critically **no
server-generated user keys anywhere in this rail**.

- **Feed signer** — only to publish their OWN statements (self-reported credits, likes)
  or to take postage custody. Not needed to receive or prove attested credits. Arrives at P3.
- **POD signer (ed25519)** — only to ISSUE PODs or decrypt organiser data. A collector
  never needs one.

Require an account before the first credit. Passkey is one touch, no email, no password,
no PII — cheaper than a device key that later has to be migrated. Do NOT reintroduce the
local browser account (deleted in `e127c97` for bundle size).

### No burners here — and why the ticket rail has them

The ticket rail generates burners **server-side** (`apps/server/src/routes/stripe.ts:1258`)
for one specific reason: a card buyer completes checkout on Stripe and never returns to
the browser, so at mint time the server is the only party present. It signs each ticket's
canonical message with the burner, embeds that signature in the QR, and discards the key.

That constraint does not exist here — the fan is standing in front of the app. So credits
use the parent account directly and no key is ever generated for a user by us.

### Authenticity is not possession

The POD proves **authenticity** — the issuer signed it. It cannot prove **possession**,
because manifests and leaves are public data on Swarm; anyone can fetch and replay them.

Note what the ticket QR actually proves, since it is easy to over-read: the signature in
it is **static and pre-computed**, so it proves the ticket was genuinely *issued* for that
slot, not that the bearer holds a secret. It is a bearer token, and a photo of it presents
identically — the one-time-use nullifier is what stops reuse. See issue #264.

Real possession proof needs a secret only the holder has, signed **freshly** over a
server-issued challenge. Using the parent account's signer gives credits that property
from day one, which the ticket rail does not have.

### Durability, not "recovery"

Existing passkey recovery (`recovery-escrow.ts`) is **guardian-based** — it needs a backup
EOA whose deterministic EIP-712 signature derives the guardian keys. There is no email
factor. That is unusable for this audience: a 13-year-old is not setting up a backup wallet.

So do not promise recovery at v1, and do not build one. Because credits accrue to the
parent address, durability is just account durability: a passkey with PRF derives
deterministically and regenerates on any device the passkey syncs to (iCloud Keychain,
Google Password Manager). No guardian, no email, no seed phrase.

Losing the passkey with no guardian set loses the account. Acceptable for a first outing —
say so plainly in the UI rather than implying permanence. It becomes a real problem only
once collections are years deep, which is the point to revisit it.

## Presence proof — the ladder

A static QR proves someone scanned a URL. That is not proof, and this community will
demonstrate it on camera if the claim is overstated. Layered, strongest first:

1. **NTAG 424 DNA NFC tag** (~£1, no power, no signal). Each tap emits a unique
   cryptographic SUN message that cannot be cloned or replayed. Phone reads it natively
   (iOS background tag reading, Android). Tap → URL carrying the per-tap cryptogram →
   PWA queues it → syncs later. This is the only option that proves *physical presence*.
2. **Issuer device witness** — a marshal's tablet scans the rider and signs the session.
   Offline-native (see below). This is the Rita-day answer.
3. **Rotating code** on a device at the exit, ~30s validity. Proves proximity in time.
4. **GPS** — soft signal ONLY. Works in a PWA over HTTPS with permission, but is
   trivially spoofed (devtools override, Android mock-location), has no attestation, and
   its accuracy under ride structures cannot separate a ride exit from the adjacent path.
   For under-18s it is also the worst choice available (see Legal). Use for plausibility
   scoring, never as the basis of a credit.
5. **Self-reported** — keep it. The existing ecosystem runs on good will and verified
   credits should be additive, never a replacement. Mark leaves `evidence: "self"`.

Plus a physical-plausibility rule in the indexer: ride cycle time bounds how many credits
a holder can legitimately accrue per hour. Kills mass fraud without perfect security.

## Two keys, two questions — ed25519 vs EIP-191

These are constantly conflated. They answer different questions and are checked at
different times.

| | key | signs | proves | when checked |
|---|---|---|---|---|
| **Authenticity** | issuer ed25519 (POD identity) | the manifest | this credential really came from this issuer | once, at issuance (`verifySignedManifest`) |
| **Possession** | holder secp256k1 (burner/passkey) | a fresh challenge | I am the person holding it *right now* | per scan, EIP-191 |

For tickets, only the second is checked at the door: the pack carries `slotOwners` read
from the chain, so the chain — not the manifest — is the door's authority
(`packages/shared/src/checkin/types.ts`; the pack never carries the manifest).

For credits there is no chain, so the **batch manifest travels with the pack**: the
scanner verifies the issuer's ed25519 signature once on load, then EIP-191 per scan
against the holders named in the verified leaves. Strictly better than the ticket path —
same two guarantees, no chain read at the door.

## Offline

The existing scanner verifies **EIP-191 secp256k1** — `recoverMessageAddress` over
`buildTicketCanonicalMessage`, compared against pre-downloaded on-chain `slotOwner`
(`apps/web/src/lib/scanner/verify.ts`). The v1 path put the issuer's ed25519 edition sig
in the QR, but that sig is public feed data — it proved the ticket existed, not who held
it, which is why a one-time-use nullifier was doing the real work. It died with the v1 rail.

Direction matters and determines the day plan:

- **Issuer scans rider** — fully offline. Tablet holds the roster, verifies locally,
  queues to IndexedDB, signs and uploads the batch when signal returns.
- **Rider scans a poster** — cannot complete offline; collecting needs a network round
  trip. Queue the intent device-side and sync later.

Alton Towers sits in a valley with patchy signal at ride level, so option 1 is the
architecturally correct choice, not merely the diplomatic one.

## Portability — light clients, browser nodes, user-owned batches

Non-negotiables, all cheap now and expensive later (mirrors SWARM_SOCIAL_PLAN §
"Non-negotiable commitments"):

1. **Every credit verifies standalone.** Leaf + proof + signed manifest header. No
   dependency on our server, our feed, or our index.
2. **Content-addressed, never feed-slot-authoritative.** Feeds are pointers and indexes.
   A credit's identity is its hash, so it survives any re-hosting.
3. **Postage is separable from authorship.** Chunks are re-stampable under a different
   batch without re-signing (hash-preserving). Never bake the platform batch into the
   identity of anything.
4. **Dual custody.** The issuer publishes the canonical enumerable batch; the holder
   keeps their own `PortableCreditV1`. If a park stops paying postage, holders' credits
   survive. This is what makes the handover story honest.
5. **Subjects and holders are keyed by their own identifiers** — never WoCo-internal ids.

At P3 a browser node holds its own batch, re-stamps its own credits, and computes its own
totals with no indexer. Nothing above changes for that to happen.

## Indexer

Same component as SWARM_SOCIAL_PLAN P1 — **not yet built** (no social/statement indexer
exists in the tree). It reads issuer batch chains, verifies signatures, applies dedup by
`nonce` and the plausibility rule, and publishes a per-holder projection plus an evidence
manifest whose leaves point at the real batches. Server is a cache, not truth; the whole
index is rebuildable from public data.

Build it once for likes/follows/credits. Credits should be its second consumer, not a
parallel system.

## Scale

Cost per credit is one Merkle leaf. Cost per *batch* is one ed25519 signature plus one
Swarm upload, regardless of how many leaves it holds.

Worked example — 1,000 fans averaging 5 rides each on a busy day:

| | attested design | on-chain slot per credit |
|---|---|---|
| leaves / mints | 1,000 (one per rider per coaster per day) | 5,000 |
| signatures | 1 | 5,000 |
| Swarm uploads | 1 | — |
| on-chain txs | 0 | ≥50 batched, through one sponsor nonce |

The known write-path ceilings are untouched: `beeUploadSem` is 6-wide globally
(`upload-queue.ts:19`), one postage batch means concurrent stamps hit 423 Locked, and the
sponsor EOA serialises its nonce (`sponsor-nonce.ts`). A session batch is a single upload,
so none of those are on the critical path. The on-chain variant puts all three there.

Reads scale as normal cached HTTP — the index is a projection, servable from the edge.

## Security model

| threat | what stops it |
|---|---|
| Forging a credit | Needs the issuer's ed25519 key. Same trust root as ticket manifests. |
| Replaying a batch or leaf | Leaf `nonce` + indexer dedup; batches chain via `prevBatch`. |
| Issuer inflating counts later | Optional anchor timestamps the batch digest; backdating becomes detectable. |
| Indexer lying or omitting | Evidence manifest points at the real batches — count is list length, anyone can recount (SWARM_SOCIAL_PLAN commitment 4). |
| Someone claiming rides they didn't take | The presence ladder, plus the indexer's cycle-time plausibility rule. This is the weak link and should be stated honestly rather than overclaimed. |
| Self-reported passed off as verified | `evidence: "nfc" \| "device" \| "self"` on every leaf; surface it in the UI. |
| Losing the server | Every batch is public and signed; the index is rebuildable from Swarm. `.data` holds no truth. |

The property deliberately NOT claimed: that a credit proves someone physically rode. It
proves an issuer attested that they did. Strengthening that is what the presence ladder is
for, and no amount of cryptography substitutes for it.

## Phasing

- **P0** — subject identity + `PodDirectoryEntry.subject`. Cheapest thing to get wrong.
- **P1** — leaf + manifest schema in `packages/shared`, issuer signing path, batch upload.
- **P2** — indexer (shared with social), holdings reader gains an attested source.
- **P3** — PWA scan/queue/sync against the parent account's existing signer.
- **P4** — NFC tags, optional on-chain anchoring, self-report import.
- **Later, not now** — issuer registry, once a second issuer actually exists. Design the
  subject identity for it at P0 so it drops in with nothing to migrate.

## Legal — this is a children's service

A coaster credit app is "likely to be accessed by children", so the ICO's **Age
Appropriate Design Code** applies to all under-18s, not just under-13s. Consequences:
data minimisation, high-privacy defaults, geolocation OFF by default, no
identity-linked public leaderboards by default, and a DPIA before launch. Under-13
consent-based processing needs a parent — which is a positive argument for the
burner/passkey path, since it collects no personal data at all.

13 (DPA 2018 s.9) is only the age a child can consent for themselves. It is not the
line that governs the design.

## Open questions

- Mainnet vs Arb Sepolia for any anchoring at all (the POD rail is testnet-only today).
- Does the platform or the issuer hold the NFC tag keys, and who provisions tags?
- Self-report import from existing credit apps — is RCDB id mapping enough?
- Postage: platform batch `56198fde…` expires ~2026-08-26. A September pilot needs this
  resolved before anything is promised.
