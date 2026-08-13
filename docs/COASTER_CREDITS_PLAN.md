# Coaster Credits — Rider-Signed Credentials Plan

STATUS (2026-08-13): DESIGN, revised after an independent Fable review (54/54 messages
Fable-attested). Not started. Identity and visibility are DECIDED (see Open questions);
remaining schema questions are listed there and must close before first write. Origin: the Rita 100 charity challenge
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
- The rider's history lives in the rider's own feed rather than an issuer's, so a park
  pulling out cannot erase it. Note the limit honestly: statements are stamped with WoCo's
  postage batch by default (`soc-upload.ts:191` → `requirePostageBatch()`), so rider history
  currently dies when WoCo stops paying for stamps. Full independence arrives at
  `SWARM_SOCIAL_PLAN` P2 (user-owned batches) — do not claim it before then, and especially
  not in the pilot's public story.
- It is the `SWARM_SOCIAL_PLAN` shape exactly — same primitive, same indexer, no new
  architecture.
- It matches the community norm. Existing credit apps are all honour-system; verified
  credits are an **additional tier**, never a replacement.

An issuer never authors a rider's history. It only ever adds a witness that references a
statement the rider already made.

### Who signs what

`project_signing_role_architecture` is a hard rule, stated precisely: **the parent never
signs content, requests, tickets or listings. It signs session authorisation and
deterministic key-derivation ceremonies only.**

The looser "signs only `AuthorizeSession`" phrasing is wrong and worth not repeating: for
the **web3 (EOA)** kind the parent wallet also signs the POD-identity derivation
(`apps/web/src/lib/auth/pod-identity.ts:32-60`) and the feed-signer derivation — the latter
*twice*, for the determinism self-check (`auth-store.svelte.ts:230-237`). Up to four parent
signatures. For passkey and web3auth the derivations are signed by the raw POD signer and
never the Kernel parent (`auth-store.svelte.ts:190-193,209-212`).

Derivations are key-stretches, not authorship, so the architecture holds either way — but a
doc that derives design conclusions from the rule should state the rule accurately.

Two rider keys, at two different layers. This is not a choice between them — it mirrors
what `ClaimedTicket` already does for tickets.

| layer | key | role |
|---|---|---|
| **Identity** (in the content) | rider **ed25519 POD key** | named as `holder` — the owner-of-record |
| **Storage** (the SOC) | rider **derived feed key** (secp256k1) | signs the feed write, because Swarm requires the feed owner to |
| Presence | issuer device key | rotating exit tokens (below) |
| Witness | issuer ed25519 | witness batches referencing rider statements |
| **Parent** | — | **nothing in this rail** |

The precedent is `packages/shared/src/event/types.ts:473` — `ClaimedTicket.owner` is
"Attendee ed25519 POD public key — the owner-of-record", with `ownerSig` (`:476`) a
platform EIP-191 signature forming an "issued-to-identity attestation" over
`(eventId, seriesId, edition, owner, claimedAt)`, built in
`apps/server/src/lib/ticket/owner-binding.ts`.

A collected credit binds the same way, to the same identity. A rider's tickets and their
coaster credits are then owned by ONE identity rather than two, which is what makes a
passport view coherent — and an issuer witness is the direct analogue of `ownerSig`.

Note `PodV2Body` has no owner field, deliberately: it is pre-signed at event creation,
before anyone holds it. Ownership belongs to the *claimed* object, not the minted one.

`SWARM_SOCIAL_PLAN` commitment 1 governs the storage layer: "The user's derived feed key
signs every statement… NEVER the platform `FEED_PRIVATE_KEY`, NEVER the 30-day session
key." The parent's only involvement anywhere is the one-time EIP-712 derivation signature
that produces the feed key — a key-stretch, not a feed write.

## The evidence ladder

Every credit has an evidence tier. **The tier is COMPUTED by the indexer from materials in
the statement — it is never a field the rider declares.** A rider-signed `evidence:
"witnessed"` is a claim about someone else's data, unverifiable at write time, and a
schema-valid lie would exist on day one. The statement carries materials; the indexer
derives the tier:

| materials present | computed tier |
|---|---|
| valid exit tokens, count-bounded | `scanned` |
| a join to an issuer witness batch | `witnessed` |
| neither | `self` |

**1. `self` — rider signs alone.** They tap "I rode this". Worth what a self-reported count
is worth today, which is not nothing — it is the existing ecosystem's norm and works with
zero infrastructure.

**2. `scanned` — the statement embeds rotating exit tokens.** The issuer's device at the ride
exit holds a key and signs `(subject, windowStart, nonce)` every ~30 seconds, rendering it as
a QR. The rider scans, receives the token, includes it. Offline-native: the device signs
locally and needs no network.

This is the answer to "can the signature come from the QR the rider scans" — yes, provided it
**rotates**. A static pre-signed QR is worth nothing: photograph it once, replay it forever.

**Tier 2 needs an authorisation root, or it is tier 1 with extra steps.** Nothing inherently
binds a `deviceKey` to a legitimate issuer — anyone can generate a key, sign themselves exit
tokens for Rita's subject hash, and self-mint `scanned` evidence that verifies perfectly. The
issuer registry is deferred, so the pilot minimum is a **published allowlist of the issuer's
device keys** (indexer config or a platform feed), rebuildable and public. The entire meaning
of the tier depends on it; it is not optional.

**Its honest limit — rotation does not close the relay window.** Rotation stops a captured
code being reused *later*. It does nothing about the same code being shared *now*: one person
photographs the screen and sends it to fifty people who all scan inside the same ~30 seconds.
A displayed QR cannot bind to who is scanning, so this is structural. Shortening the window
narrows it and starts failing legitimate riders on poor signal, which at Alton Towers is the
common case.

State tier 2 as what it is: **a token was live at that exit at that minute and this rider
presented it** — not "this rider was there". The tier is named `scanned` deliberately; the
enum name becomes the badge label whatever this document says.

**3. `witnessed` — the issuer observed the rider and attests.** The device reads the rider's
code and the issuer counter-signs. This binds identity and is the only tier that proves a
specific person rode. Needs staff or a fixed installation.

**Witness leaves must be per-observation, not per-session.** If a witness batch joins on
`(holder, subject, date)`, one observation validates a session claiming `count: 20` — the
same unbounded-count bug fixed at tier 2, reappearing at the tier where it costs the most
credibility. Verified count = observation count.

Do not call tier 3 `verified`. That overclaims by this document's own tier-2 reasoning.

### Caps — both live in the indexer, both need a deterministic rule

The exit device is offline by design and cannot rate-limit anything.

- `MAX_STATEMENTS_PER_TOKEN_WINDOW = 40` — statements citing the same
  `(deviceKey, windowStart)`. Checkable from public data since tokens carry `windowStart`.
  Under oversubscription the spec must say **which** 40 win: order by `holderSig` bytes
  ascending, not by ingestion, or the cap is not rebuildable.
- **Ride cadence** — per-subject configuration in the published indexer config, NOT a global
  constant. A global 5 minutes would rate-limit this pilot's own headline: 109 laps × 5 min
  is over nine hours of pure cycle time, before queues, against a park day of about that
  length. Set Rita's from the actual planned cadence. Enforceable only at tiers 2/3, where
  token windows and witness timestamps supply real times; at tier 1 it polices self-declared
  data and is cosmetic.

Token dedup scope: the same token nonce counts once, whether repeated within one statement or
across two statements by the same holder.

Offline device clock drift over a full day needs a stated tolerance on the window match.

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

### Rider statement — one CURRENT object per (holder, subject)

One head topic per `(holder, subject)`, carrying the **lifetime total** plus the current
day's block. Proof of a lifetime total is one chunk, which is what the counter, the widget
and the passport view all actually want.

```ts
interface CreditStatementV1 {
  format: "woco.credit.v1";
  /** keccak256("woco:coaster:v1:" + stableId). See "Subject identity". */
  subject: Bytes32Hex;
  /** The rider's ed25519 POD public key — the owner-of-record, as `ClaimedTicket.owner`. */
  holder: Hex32;
  /** Monotonic per (holder, subject). THE ordering authority — latest = highest seq.
   *  Not derivable from anything else; see "Ordering". */
  seq: number;
  /** Lifetime rides for this subject. Cumulative — never a delta, never summed. */
  total: number;
  /** The current day's block. Older days are recovered by walking SOC versions. */
  session: {
    date: string;        // YYYY-MM-DD, timezone declared in the subject registry
    count: number;
    /** Evidence MATERIALS only — the tier is computed, never declared. */
    exitTokens?: ExitTokenV1[];
  };
  /** Swarm ref of the previous version. Optional skip-list over intra-day rewrites,
   *  NOT the history mechanism — SOC versions are that. */
  prevSession?: Hex64;
  /** ed25519 signature by `holder` over the domain-separated canonical digest.
   *  See "holderSig". */
  holderSig: string;
}
```

**No `firstAt`/`lastAt` by default.** Per-ride timestamps turn a credit log into a routine —
"this key rode Rita at 14:32 every Saturday" — which is the pattern the ICO code's
geolocation standard exists to prevent, and this audience is children. Tier-2 timing already
lives inside the exit tokens where it is actually needed. Do not add them back for display.

**No `evidence` field.** See "Evidence is computed".

**No `nonce`.** `seq` subsumes replay dedup and adds ordering, which `nonce` never had.

### Ordering — `seq` is the authority

Two validly-signed statements for the same `(holder, subject)` with different totals need an
authenticated order, and nothing else in the object can supply one:

- `total` cannot order them — downward correction breaks monotonicity, which is the whole
  point of allowing corrections.
- A timestamp cannot — it is self-declared and unverifiable.
- The SOC version cannot — resolving it requires knowing which feed is authoritative for a
  holder, and **no public mapping links the ed25519 holder to the secp256k1 feed owner**
  (see "Identity"). The two keys are derived under separate domains and are cryptographically
  independent.
- Ingestion order cannot — that lives only in our server, violating `SWARM_SOCIAL_PLAN`
  commitment 6.

So `seq` is signed, monotonic per key, and **latest = highest seq**. A third party
re-hosting an old statement loses; a correction still works; nobody can fabricate a higher
`seq` without the holder key.

### `holderSig` — why the identity layer must sign, and over what

The SOC signature proves only that *the feed owner* wrote the object. It says nothing about
`holder`, which is a different key entirely, and the upload relay cannot help —
`apps/server/src/lib/swarm/soc-upload.ts:13-18`: "ANY authenticated user may stamp their OWN
validly-signed SOC… we cannot bind owner == authenticated parent".

Without `holderSig`, anyone can write a statement into **their own** feed naming **someone
else's** `holder`, and an indexer keying counts by `holder` has no basis to reject it.

The digest must be **specified and domain-separated**, not "a digest of the fields above":
canonical CBOR via `packages/shared/src/pod/canonical.ts` under an explicit
`woco-credit-v1` prefix, and the doc must record why this signature cannot collide with the
same key's other uses — mirroring the cross-protocol argument in
`apps/server/src/lib/ticket/owner-binding.ts:8-10`.

### Aggregation — nothing is ever summed across writes

A rider's total for a subject is `total` from the highest-`seq` statement. Full stop. No
summation across writes, so the "8 taps read as 36 rides" trap cannot occur by construction.
Their total across coasters is the sum over subjects, one head each.

Corrections are free: write a lower `total` at a higher `seq`.

### Reachability — SOC versions ARE the history

**Correcting an earlier error in this document:** the client-feed primitive is NOT
overwrite-in-place. A SOC is immutable — re-uploading at the same identifier is silently
discarded (`packages/shared/src/swarm/soc.ts:229-232`) — and mutability comes from writing
update N at a **new versioned identifier**, `keccak256(base || uint64BE(version))`
(`:242-245`). Versions are "contiguous from 0 and immutable (a version once written can
never disappear)" (`:390-392`), resolved by probing forward (`resolveLatestSocVersion`,
`:399-425`).

So every historical statement stays permanently readable at a computed address. History is
free, and needs no chaining mechanism.

An earlier revision of this plan put the date in the topic and chained with `prevSession`,
to solve a problem that does not exist. That scheme actively causes a worse one: with a
topic per date there is **no stable head**, so an indexer cannot enumerate which dates a
rider rode without probing candidate dates — and an absent-chunk probe is the most expensive
read on Swarm; a window of 8 melted the bee on 2026-07-06 (`soc.ts:359-367`). Rebuild would
then depend on our ingestion log, breaking commitment 6.

One head topic per `(holder, subject)`. History is the version sequence beneath it.

### Subject enumeration — the level the head topic does not solve

A head topic per `(holder, subject)` makes one coaster's history walkable, but nothing
enumerates **which subjects a rider has ridden**. A rider with 40 coasters has 40 head
topics and no index over them, which reintroduces the same discovery problem one level up.

So a rider also writes a per-holder subject index — one head topic listing the subjects they
hold, updated when a new subject is first ridden. Cheap now, awkward to retrofit once
statements exist.

### Exit token — issued by a device, embedded by the rider

```ts
interface ExitTokenV1 {
  format: "woco.exit-token.v1";
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

Verify RCDB's id semantics before P0 — whether ids survive relocation and re-tracking — since
subject hashes are permanent. This is unconfirmed.

### A subject registry, NOT `PodDirectoryEntry`

An earlier revision said to add `subject` to `PodDirectoryEntry`. That is shape-forcing and is
now rejected. That entry's identity is a `manifestRef`, "the on-chain/manifest commitment",
with **required** `manifestRef`, `kind`, `name` and `supply`
(`packages/shared/src/pod/types.ts`). A coaster subject has no manifest, no supply and no
editions — this design's own premise is that nothing is minted. Adding `subject` there would
mean minting a meaningless manifest per coaster or leaving required fields as fiction.

Instead: a small **subject registry** on a platform feed, `subject → { name, park, rcdbId,
timezone }`. It makes the hash invertible for UI and indexer alike, which nothing in the
design otherwise provides, and it is where `sessionDate`'s timezone is declared.

PODs re-enter where the type system already invites them: `PodKind: "badge"` is literally
"loyalty/achievement, issued at a milestone. Soulbound". Issue a real POD at a milestone —
100 rides — computed off the credit total. That keeps the collectible story without
contorting the directory model.

### Credits must never satisfy a POD gate

`PodHolding` is documented as read from "the TRUSTLESS on-chain source … NOT the
platform-written collection feed, which is spoofable and would undercut the gate", and
`PodGateRule` evaluation feeds claim and order authorisation. If statement-derived holdings
flow into that reader, **a self-signed tier-1 statement could pass a gate that today requires
chain truth.** Statement-derived holdings must never satisfy a `PodGateRule` unless a gate
explicitly opts in. Stated here because it would otherwise ship by default.

## Identity — the minimum a rider needs

Two keys, both already derived for every account today — nothing new to build:

- **ed25519 POD key** — the owner-of-record named as `holder`, and what signs possession
  challenges. Same identity that owns their tickets.
- **Derived feed key** (secp256k1) — signs the SOC the statement is written into.
- **Parent** — signs the derivation ceremonies only. Never authors anything.

Why the parent address is never the holder: two independent reasons, either sufficient.
The signing rule above; and a smart-account address can never be recovered from an ECDSA
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

### Approaching Dan — the partnership risks

Recorded because they shaped the technical design and would otherwise live only in a chat log.

**Park permission is the biggest risk, and it is not ours to spend.** Nothing goes on ride
furniture or in an exit path without Merlin sign-off — brand, ride ops and their own app
ecosystem all point the same way. Dan needs the park's cooperation for a 100-lap challenge,
so that goodwill is his most valuable asset, and a proposal that quietly risks it is worse
than no proposal. Put the QR on his lanyard, his phone, a card he holds, or the stream
overlay — never on park property. Ask whether he already has a park contact rather than
assuming a cold approach; if he does, that contact is the real door.

**Stay off the charity money rail.** JustGiving keeps the funds, we keep the counter. A
crypto-adjacent startup handling charity donations is a headline with no upside, and it
drags in fundraising regulation for nothing. The "+1 lap per £1000" mechanic is still a
good demo — mirror the total into a signed public counter, with Dan attesting milestones if
their API is not open to us.

**Get the vocabulary right or the community writes us off.** A *credit* means a coaster
ridden once, ever. Repeat rides are *laps* or *rides*. Calling 109 laps "109 credits" marks
us as outsiders on day one. Keep crypto words out of the fan-facing UX entirely — "collect",
"keepsake", never "wallet" or "mint".

**Verification must be additive, never corrective.** The enthusiast community runs on an
honour system and is proud of it; existing credit apps are all self-reported. Verified
credits are an extra tier for people who want one, not an audit of anyone's count. Pitching
it as the latter loses the exact audience we need.

**The verification page is the marketing asset, not the app.** "Verify all 109 laps" is what
gets shared and screenshotted. Build that first and build it well. The OBS overlay is the
highest value-per-hour thing after it — a live verified counter on the stream is immediate,
obvious value to Dan and near-free from `packages/embed`.

**Merlin is the wrong first customer; the trail is the right first product.** Merlin
procurement is a multi-year sale against an incumbent stack. Their Minecraft trail activation
— walk the park, collect stamps on card — is the identical primitive to this design, is a
marketing budget decision rather than an IT one, is bounded with an end date, and has a
knowable participant ceiling. That is the wedge. Separately, a UK independent (Drayton Manor,
Paultons, Flamingo Land, Blackpool) is a far more winnable reference than Merlin corporate.

**Single point of failure.** If Dan is injured, ill, or the challenge is pulled, the demo
evaporates. The artifact has to stand alone.

**Success is also a risk.** A YouTube-scale spike lands on one Hetzner VM behind one bee.
See Scale above — the design keeps writes off the critical path, but the read path still
wants edge caching before a stream day.

**Opportunity cost is real.** This competes with launch work. Doing it thinly, in public, in
front of the exact community we want to win, is worse than not doing it — so scope hard and
say no to tier 3 if the day cannot support it.

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
| Writing a statement naming someone else as `holder` | `holderSig` — the ed25519 identity key signs the object. WITHOUT it this is trivial: the SOC signature proves only who wrote the feed, not who the holder is. |
| Replaying an old statement | `seq` — latest = highest seq. Without it there is NO rebuildable ordering, since `total` breaks monotonicity under correction and no public mapping links `holder` to its feed owner. |
| Replaying an exit token | Token binds `windowStart`; indexer rejects stale windows. |
| Reusing a photographed exit QR later | Rotation — a captured token expires in ~30s. |
| Sharing a live exit QR within its window | **Not solved.** Structural to a displayed code. Bounded by `MAX_STATEMENTS_PER_TOKEN_WINDOW = 40` + `MIN_MINUTES_BETWEEN_CREDITS = 5`. Tier 2 claims the token was present, not the rider. |
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

## Scope: general schema, pilot-only machinery

The deciding asymmetry: **the schema is permanent and the machinery is disposable by design.**
Rider feeds are write-once and public, so a schema mistake is inherited by every future credit
and cannot be revisited. The indexer is explicitly a rebuildable cache. So spend the scarce
design effort where mistakes are unfixable, and ship the pilot on deliberately minimal
machinery.

**Freeze in `packages/shared` before any code:** `CreditStatementV1` with `seq`, the head
topic, computed evidence, the domain-separated `holderSig` digest, and the identity decision
below. Do not defer any schema question — that is the one category that cannot be revisited.

**Ship the pilot minimally:** hardcoded subject, published allowlist of the issuer's device
keys, a single-subject counter endpoint, the embed widget and the stream overlay. None of the
pilot's deliverables needs a general indexer.

**Defer:** the general indexer (merge with #172), witness batches if the device app slips
(the rider's own statements plus the device's tokens still carry the story), the issuer
registry, self-report import, NFC.

## Phasing

- **P0** — subject identity + subject registry + **frozen statement schema**. The only
  irreversible step.
- **P1** — rider signs and publishes to their own feed. Tier 1 only. No issuer, no park.
- **P2** — single-subject projection for the pilot; general indexer merged with #172 after.
- **P3** — exit device app: rotating tokens, offline-capable, published key allowlist. Tier 2.
- **P4** — issuer witness batches (tier 3), NFC tags, optional anchoring, self-report import.
- **Later** — issuer registry, once a second issuer exists.

## Open questions

### Identity and visibility — DECIDED 2026-08-13

**One identity, encrypted by default, publication opt-in.** Locked; do not reopen without
new facts.

- `holder` stays the rider's raw ed25519 POD key — the same identity that owns their tickets,
  so the passport view is coherent and tickets and credits share an owner.
- A credit statement is **ECIES-sealed to the rider's own X25519 key by default**, derived via
  `deriveEncryptionKeypairFromPodSeed` (`packages/shared/src/crypto/keys.ts:71`) — deterministic,
  same on any device, no extra wallet prompt. Seal/open are `sealJson`/`openJson`
  (`packages/shared/src/crypto/ecies.ts`). No new crypto and no new key ceremony.
- Publishing writes the statement in the clear. An indexer cannot count what it cannot read,
  so encrypted credits are the rider's private record and published ones feed public counts.

Why not a pairwise key: it protects the location record but breaks the passport view **and
still publishes everything by default**. Encryption protects the record and keeps the passport.

Why not "just don't write it": that was the earlier suggestion and it is worse — nothing
durable exists, so losing the device loses the history. Encrypted-on-Swarm is private *and*
durable *and* portable.

**Publishing is a one-way door.** SOC versions are immutable, so private → public is fine and
public → private is impossible. The UI must say so at the moment of choosing, not in a policy
page.

#### The publication choice is asked, not defaulted

Public counts are core to this culture — Captain Coaster has public profiles and rankings,
enthusiasts carry counts in forum signatures, comparing is half the hobby. A silently private
default would bury the feature the most engaged users actually want.

So: **ask once, at the first credit**, private pre-selected, neutral wording, no nudge
patterns. An active choice is a stronger children's-code posture than a silent default, needs
no age question, and puts the public count one tap away.

Pilot: Dan publishes — a public counter is the point. Fans default to a private keepsake and
opt in to appear on the leaderboard. A keepsake must never require a publication decision from
a child standing in a queue.

#### Erasure, stated honestly

Superseding a statement does not unpublish it — old SOC versions stay readable at computed
addresses while stamped. Erasure means "stop re-stamping, plus gateway suppression". Say that
plainly rather than implying deletion.

### Times: attested only, never declared

`firstAt`/`lastAt` are deliberately absent, for two independent reasons.

**Privacy:** per-ride times turn a credit log into a routine — "this key rode Rita at 14:32
every Saturday" — which is what the ICO code's geolocation standard exists to prevent for this
audience.

**And they would not work anyway.** A self-declared timestamp proves nothing: a rider claiming
50 rides in an hour will declare plausible times alongside them. Declared times add *false*
confidence to a self-reported count, which is worse than none.

Attested times already exist where they are needed: exit tokens carry `windowStart` signed by
the device, which the rider cannot forge. That is what the per-window cap and the cadence rule
read, and it is why both are enforceable only at tiers 2/3.

Consequence for record claims — "most laps in a day" and similar: those must require tier 2 or
3. A record is never creditable from self-reported data, whatever times it carries.

### Still open

- RCDB id stability under relocation/re-tracking — unverified, and subject hashes are forever.
- `sessionDate` timezone: park-local or UTC. Declared in the subject registry; pick one.
- Statement size at tier 2 grows with the day — ~300 bytes per token, so a 100-lap tier-2 day
  is ~30KB of tokens re-uploaded on every tap. The multi-chunk path exists (up to 256 pages),
  so it works, but the cost is quadratic in rides; consider chunking token lists by reference
  once large.
- The evidence manifest needs restating for weighted counts: commitment 4's "count = list
  length" spot-check does not hold when a total is carried rather than summed, so the manifest
  must carry the per-statement values it used.
- The attendee gate: profile creation is gated on ticket possession, and pilot fans have no
  WoCo tickets, so the credits write path must be deliberately ungated — which reopens
  free-account statement spam stamped on our postage batch. Needs a rate limit on the relay.
- Postage: both current batches expire before any September pilot. Mandatory infra work before
  a date is promised.
