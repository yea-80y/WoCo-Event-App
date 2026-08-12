# Coaster Credits — Rider-Signed Credentials Plan

STATUS (2026-08-12): DESIGN. Not started. Origin: the Rita 100 charity challenge
(Digital Dan, September 2026) as the pilot for a general ride-credit system.

Companion to `docs/SWARM_SOCIAL_PLAN.md` — this shares its indexer, its trust model and
its portability commitments. Read that first; this doc states only the deltas.

## The model in one paragraph

A **credit** is a statement, signed by the rider's own derived feed key and written to the
rider's own Swarm feed, saying they rode a given coaster. An **issuer** — a park, or a
challenge organiser — can optionally witness that statement, which raises its evidence
level from self-reported to verified. Counts are computed by an indexer that reads public
feeds, verifies signatures, and publishes a rebuildable index. No chain per credit, no
pre-committed supply, no server holding anyone's data. The POD layer stays as the
display/identity object; holdings are derived from statements rather than on-chain slots.

## What a user holds — settled

**One POD per coaster, with a count attached. NOT one POD per ride.**

- `Rita, Alton Towers` is a POD type. A rider holds it once, from their first ride, forever.
- Their ride count is **derived**: the sum of `count` across every statement naming
  `(holder, subject)`. Ride 200 adds a statement, not a POD.
- The POD carries identity and artwork — what a rider recognises and collects. The count
  is a computed property of it.

Why not a POD per ride: a POD type is a fixed-supply, pre-signed Merkle batch registered
on-chain (`issuePodType`), so per-ride would mean pre-committing to how many rides will ever
happen on Rita and paying to register each. Counts belong in the statement layer, which is
unbounded and free.

**Nothing is minted when a credit is collected.** No transaction, no supply consumed, no
per-rider cost. The rider signs a statement. That is the whole operation.

## Rider-signed base, issuer-witnessed upgrade

The rider is the author. This is the load-bearing decision and it is deliberate:

- It works **day one with no park involvement** — including the "just tap that you rode it"
  rollout, where no issuer exists at all.
- The rider's history lives in the rider's own feed, so it survives WoCo losing interest,
  a park pulling out, or any server dying. An issuer-authored design fails all three.
- It is the `SWARM_SOCIAL_PLAN` shape exactly — same primitive, same indexer, no new
  architecture.
- It matches the community norm. Existing credit apps are all honour-system; verified
  credits are an **additional tier**, never a replacement.

An issuer never authors a rider's history. It only ever adds a witness that references a
statement the rider already made.

### Who signs what

`project_signing_role_architecture` is a hard rule: the parent signs ONLY the one EIP-712
`AuthorizeSession` per session — never feeds, never requests, never tickets.

| actor | key | signs |
|---|---|---|
| Rider | derived **feed key** (secp256k1, sign-to-derive) | their own ride statements |
| Rider | same key | possession challenges, resale listings |
| Issuer device (exit) | issuer device key | rotating presence tokens (below) |
| Issuer | ed25519 | witness batches referencing rider statements |
| Rider's parent | — | **nothing in this rail** |

`SWARM_SOCIAL_PLAN` commitment 1 fixes the rider's key: "The user's derived feed key signs
every statement (sign-to-derive, the settled client-feed mechanism). NEVER the platform
`FEED_PRIVATE_KEY`, NEVER the 30-day session key." ed25519 is the POD identity — it signs
POD manifests, not statements.

The parent's only involvement anywhere is the one-time EIP-712 derivation signature that
produces the feed key. That is a key-stretch, not a feed write.

## The evidence ladder

Every statement carries an `evidence` level. The indexer and the UI must surface it —
conflating tiers is how a verified-credits product loses its credibility.

**1. `self` — rider signs alone.** They tap "I rode this". Worth exactly what a
self-reported count is worth today, which is not nothing: it is the existing ecosystem's
norm and it works with zero infrastructure.

**2. `presence` — rider's statement embeds a rotating issuer token.** The issuer's device
at the ride exit holds a key and signs `(subject, windowStart, nonce)` every ~30 seconds,
rendering it as a QR on a screen. The rider scans, receives the signed token, and includes
it in their own statement. The indexer verifies the issuer signature and that the window
matches the claimed time.

This is the answer to "can the signature come from the QR the rider scans" — yes, provided
it **rotates**. A static pre-signed QR is worth nothing: photograph it once and replay it
forever. Rotation is what makes it evidence.

Its honest limit: it proves someone was in front of that screen in that window, shared
across everyone who scanned it. It does not bind a specific person. Combined with the
plausibility rule below, that is enough to stop bulk fraud without pretending to more.

**3. `verified` — issuer scans the rider and witnesses.** The device reads the rider's
code and the issuer counter-signs a witness naming that holder. This binds identity, and
it is the only tier that genuinely proves a specific person rode. It needs staff or a
fixed installation, so it is an event/park-cooperation tier, not a default.

Plus a **plausibility rule** in the indexer: ride cycle time bounds how many credits a
holder can legitimately accrue per hour. Cheap, and it kills bulk fraud without needing
any tier to be perfect.

### Where park integration actually belongs

Verifying a rider is physically in the park by reading the park's own admission ticket is
the wrong shape, for two reasons. A park ticket QR is a static bearer token — a photo of a
friend's ticket passes it — so it proves someone holds *a* ticket, not that *you* are
there. And it would require the park to expose their ticket-verification surface, which is
their revenue-protection boundary and the last thing they will hand out.

The same commercial conversation gets a far better result: **the park becomes an issuer**.
They already know who scanned in and who rode; having them witness credits directly is
tier 3, needs no access to their internals, and is exactly the handover story this design
is built for. Ask for attestation, not for read access.

GPS stays a **soft plausibility signal only** — spoofable via devtools and mock-location
apps, no attestation, and unable to separate a ride exit from the adjacent path under ride
structures. It is also the worst possible signal for an under-18 audience (see Legal).
Never gate a credit on it.

## Data structures

New in `packages/shared/src/credit/`. Reuses the LOCKED primitives in
`packages/shared/src/pod/{canonical,merkle}.ts` — same encoder, same tree scheme. Do not
fork them.

### Rider statement — one per (holder, subject, session)

A statement is a **session**, not a single ride. Proving 47 rides must not need 47 proofs,
and "8 rides on 14 September" is how it will be displayed anyway.

```ts
interface CreditStatementV1 {
  format: "woco.credit.v1";
  /** keccak256("woco:coaster:v1:" + stableId). See "Subject identity". */
  subject: Bytes32Hex;
  /** The rider's derived feed-key address — the statement's author. */
  holder: Hex0x;
  count: number;
  sessionDate: string;      // YYYY-MM-DD
  firstAt?: string;         // ISO
  lastAt?: string;
  evidence: "self" | "presence" | "verified";
  /** Present when evidence is "presence": the rotating token scanned at the exit. */
  presenceToken?: PresenceTokenV1;
  /** Dedup key — makes a replayed write idempotent. */
  nonce: string;
}
```

Written to the rider's own feed, signed by their feed key. Storage is Swarm: the statement
is content-addressed, and the rider's feed points at it.

### Presence token — issued by a device, embedded by the rider

```ts
interface PresenceTokenV1 {
  format: "woco.presence.v1";
  subject: Bytes32Hex;
  deviceKey: Hex0x;         // the exit device's signing address
  windowStart: string;      // ISO, ~30s granularity
  nonce: string;
  sig: string;              // deviceKey's signature over the above
}
```

The device signs locally and needs no network — it can run all day offline at a ride exit.

### Issuer witness batch — tier 3 only

The issuer collects `(holder, subject, sessionDate)` tuples it observed, builds a Merkle
tree, and ed25519-signs ONE manifest over the batch — same envelope shape as
`ManifestV1Body`, with `prevBatch` chaining so an indexer can walk issuer history and
omission is detectable. One signature and one upload per batch, regardless of size.

A witness **references** rider statements; it never replaces or authors them.

## Subject identity

```
subject = keccak256("woco:coaster:v1:" + <stable coaster id>)
```

Use **RCDB ids** — the Roller Coaster DataBase (`rcdb.com`) catalogues essentially every
coaster with a stable numeric id (Rita is `rcdb.com/2919.htm` → `rcdb:2919`). It is the
community's de facto reference and the existing credit apps key on it, giving an import
path for self-reported history. No public API or data licence, so treat it as a **naming
convention we reference**, never a database to scrape or mirror.

Add `subject` to `PodDirectoryEntry`. A rider's count for a coaster is the sum across every
statement naming that subject, whatever its evidence level and whoever witnessed it. That
one indirection is what lets a park take over issuing without forking anyone's history.

## Identity — the minimum a rider needs

One key: the **derived feed key** (secp256k1, sign-to-derive). It authors statements, is
named as `holder`, and signs possession challenges.

- **POD signer (ed25519)** — only to ISSUE PODs or decrypt organiser data. A collector
  never needs one.
- **Parent** — signs the derivation message once. Nothing else, ever.

Why not the parent address as holder: two independent reasons, either sufficient. The
signing rule above; and a smart-account address can never be recovered from an ECDSA
signature — its address comes from the deployment recipe, not a key — which rules it out
for three of four login kinds (`auth-store.svelte.ts`: web3auth `:1298`, passkey `:1486`,
coinbase `:1423`; only web3 `:1183` is an EOA).

Do NOT reintroduce the local browser account (deleted in `e127c97` for bundle size).

### Durability

Existing passkey recovery (`recovery-escrow.ts`) is **guardian-based** — it needs a backup
EOA whose deterministic EIP-712 signature derives the guardian keys. No email factor. That
is unusable for this audience; a 13-year-old is not setting up a backup wallet.

Do not promise recovery at v1. Durability is account durability: a passkey with PRF derives
deterministically and regenerates on any device the passkey syncs to. Losing the passkey
with no guardian loses the account — acceptable for a first outing, but say so plainly
rather than implying permanence.

## Optional on-chain surfaces

Neither is required to ship. Both are fixed-cost — per coaster or per handover, never per
credit or per rider.

**Anchor.** Periodically publish a batch digest on-chain. Buys one property: it stops an
issuer rewriting history after the fact. Note the live tracker is NOT the anchor — the
tracker updates on every statement, instantly, free; the anchor is a slow notarisation on
top.

A Merkle root commits to whatever set exists when computed, so a challenge growing from 100
laps to 109 needs no reservation or resize. That "reserve N up front" problem was an
artefact of the on-chain slot model.

**Issuer registry.** `subject => { issuer, since, until }` with transfer and revoke.
Handing issuing rights to a park is a trust question — *was this issuer authorised for this
subject when the batch was signed?* — and answering it without a live call to a WoCo server
is what a chain is genuinely good at. Recording the authorised **period** means historical
credits survive a handover instead of being silently invalidated.

Why not a signed delegation: revocation. A verifier can never prove a delegation *wasn't*
revoked without a live source of truth. `contracts/src/ContentHashRegistry.sol` is the
precedent for the shape. Defer until a second issuer exists; design the subject identity
now so it drops in with nothing to migrate.

## The Rita 100 pilot

**Dan is the issuer, not WoCo.** His team holds the exit device and his key witnesses the
laps. That is honest — "attested by Dan" — and it avoids WoCo attesting to its own
marketing claim, which would be the weakest part of the story. If Alton Towers later
co-signs, that is a third layer on the same statements.

Fans self-sign or scan Dan's rotating token, depending on what the day allows. The
deliverables that matter are the public verifiable counter, an embeddable widget for
rita100.com, and a stream overlay — all of which read the live count, not the anchor.

Do not claim the system proves Dan physically rode 109 times. It proves he and his team
attested to it, tamper-evidently and in public. Overclaiming to an audience that will test
it on camera is the one unforced error available here.

## Scale

Cost per credit is one signed statement. Worked example — 1,000 fans averaging 5 rides:

| | rider-signed | on-chain slot per credit |
|---|---|---|
| statements | 1,000 (one per rider per coaster per day) | 5,000 mints |
| signatures | 1,000 rider-side (client CPU, free) | 5,000 |
| server writes | 1 witness batch, if tier 3 | — |
| on-chain txs | 0 | ≥50, through one sponsor nonce |

The known write-path ceilings stay off the critical path: `beeUploadSem` is 6-wide globally
(`upload-queue.ts:19`), one postage batch means concurrent stamps hit 423 Locked, and the
sponsor EOA serialises its nonce (`sponsor-nonce.ts`). Rider statements are client-signed
and the witness batch is a single upload. The on-chain variant puts all three on the path.

## Security model

| threat | what stops it |
|---|---|
| Forging someone else's statement | Needs their feed key. Same trust root as all client feeds. |
| Replaying a statement | `nonce` + indexer dedup. |
| Replaying a presence token | Token binds `windowStart`; indexer rejects stale windows. |
| Photographing the exit QR | Rotation — a captured token expires in ~30s. |
| Inflating a self-reported count | Nothing, by design. That is what `evidence: "self"` declares. |
| Bulk fraud across many accounts | Cycle-time plausibility rule + tier separation in the UI. |
| Issuer backdating a witness batch | Optional anchor timestamps the digest. |
| Indexer lying or omitting | Evidence manifest points at real statements — anyone can recount (`SWARM_SOCIAL_PLAN` commitment 4). |
| Losing the server | Statements are public, signed, rider-owned. The index is rebuildable. `.data` holds no truth. |

The property deliberately NOT claimed: that a credit proves someone physically rode. Tier 1
proves they said so; tier 2 that someone was at the exit; tier 3 that an issuer vouched for
them. No amount of cryptography substitutes for the ladder.

## Legal — this is a children's service

A coaster credit app is "likely to be accessed by children", so the ICO's **Age Appropriate
Design Code** applies to all under-18s, not just under-13s: data minimisation, high-privacy
defaults, geolocation OFF by default, no identity-linked public leaderboards by default,
DPIA before launch.

**Do not build an age rule.** Keying behaviour on age requires determining age, and age
assurance is a larger regulatory problem than the one it solves. Instead: **collect no email
from anyone in this rail, at any age.** Passkey for all. With no personal data there is no
lawful basis to establish, and the under-13 consent question never arises.

13 (DPA 2018 s.9) is only the age a child can consent for themselves. It is not the line
that governs the design.

## Phasing

- **P0** — subject identity + `PodDirectoryEntry.subject`. Cheapest thing to get wrong.
- **P1** — statement schema in `packages/shared`; rider signs and publishes to their own
  feed. Tier 1 only. Ships with no issuer and no park.
- **P2** — indexer (shared with likes/follows in `SWARM_SOCIAL_PLAN`, **not yet built**);
  holdings reader gains a statement source.
- **P3** — exit device app: rotating presence tokens, offline-capable. Tier 2.
- **P4** — issuer witness batches (tier 3), NFC tags, optional anchoring, self-report import.
- **Later** — issuer registry, once a second issuer exists.

## Open questions

- Where does the exit device's key live, and who provisions devices?
- Self-report import from existing credit apps — is RCDB id mapping enough?
- Postage: batches `7dad2b8c…` (~2026-08-24) and `56198fde…` (~2026-08-26) expire before
  any September pilot. Resolve before promising dates.
