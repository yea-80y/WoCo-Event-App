# Swarm-Native Social: Likes, Follows, Forums — Plan

STATUS (2026-08-04): AUTHORITATIVE for all social features. Supersedes the on-chain EAS
likes design (`docs/EAS_LIKES_HANDOVER.md`) for launch — EAS likes are built but will NOT
launch; no chain dependency for social. The EAS doc remains useful for its abuse model
and UI notes only.

2026-08-19: the CHAIN BOUNDARY RULE is settled — social carries no chain dependency, and the
three-test rule below governs what ever may. The subject index is banded (topic derivation only,
no format bump). "Ticket purchase unlocks liking" is Gate A — relay admission policy, not data
plane. Gate B (POD-granted access to exclusive content) is OPEN and needs its own design pass.

2026-08-14: the statement discipline + `woco.like.v1`/`woco.follow.v1` payloads are FROZEN —
`packages/shared/src/{statement,social}/`, design record in `docs/COASTER_CREDITS_PLAN.md`
("FROZEN AT P0"). Commitment 5 is now satisfied in code.

## The model in one paragraph

Every social action (like, follow, later: post, comment, vote, mod action) is a statement
**signed by the user's own key, written to the user's own Swarm feed**. Nobody writes to a
shared object — Swarm feeds have exactly one owner-signer, so shared state is impossible
and, it turns out, undesirable. All combined views (follower counts, like tallies, threads,
karma) are **computed** by an indexer that reads the public feeds, verifies signatures, and
publishes a rebuildable index. Data plane = user-owned truth. View plane = disposable,
recomputable-by-anyone cache. Same trust model as the EAS design (server is a cache, not
truth), with Swarm feeds replacing the chain.

This is the AT Protocol / Bluesky shape (personal data repos + appview indexers +
moderation-as-labels), arrived at independently from Swarm primitives.

## Non-negotiable commitments (the corner-avoiders)

Violating any of these forfeits portability/self-sovereignty later. All are cheap now.

1. **The user's derived feed key signs every statement** (sign-to-derive, the settled
   client-feed mechanism). NEVER the platform `FEED_PRIVATE_KEY`, NEVER the 30-day
   session key. The server may relay/stamp/upload — it must never author.
2. **Subjects and users are keyed by their own addresses/identities** — never by
   WoCo-internal IDs. The graph must exist between sovereign identities so an organiser
   can take their audience (a bundle of verifiable signed statements) to any platform.
3. **One statement per (user, subject), latest-wins.** A like/follow is current state,
   not history. Unlike/unfollow = overwrite. (No append-only log — deliberate.)
4. **The published index carries its evidence**: manifest whose leaves point at the
   users' actual signed chunks, so count = list length and any reader can spot-check.
   An indexer that lies is provably lying.
5. **Payload schema lives in `packages/shared`** and is documented — any future indexer
   (ours or third-party) consumes the same format.
6. **Nothing may depend on data that exists only inside our server.** `.data` projections
   must always be rebuildable from public feeds.

## The chain boundary — the rule (settled 2026-08-19, Fable design pass)

> **The chain holds RIGHTS. Feeds hold RECORDS.**

A thing may touch a chain only if it passes ALL THREE tests. Fail any one and it is
chain-free permanently.

1. **It is a right, not a record.** Exclusive ownership or revocable authority — something
   two honest parties could otherwise both believe they hold. A record is any signed claim an
   identity makes about itself or its actions; a signature IS its proof.
2. **It needs live negation.** The verifier must prove a PRESENT-TENSE negative: not revoked,
   not already owned, not double-spent. A signature can never prove a negative without a live
   source of truth. This is the only thing a chain provides that Swarm-plus-signatures cannot.
3. **Its cost is per-transfer-of-right, never per-user-action.** O(registrations), O(handovers)
   — never O(laps), O(likes), O(users×day). If the chain bill scales with USAGE, the
   classification is wrong.

Applied to everything currently on the table:

| | verdict |
|---|---|
| credits, likes, follows | records, self-attested, per-action cardinality — fail 1 and 3. **Chain-free permanently** |
| milestone / commemorative PODs | issuer-signed records — chain-free. If a badge is ever financially gated it is the CLAIM SLOT (a right) that crosses, via the existing claim rail, never the count |
| sub-ENS names | exclusive, transferable, needs live `ownerOf`, per-registration cost — passes all three. Correctly on-chain |
| escrow / payments | funds are the canonical scarce right, with double-spend negation — passes. Correctly on-chain |
| issuer registry (deferred) | revocable authority, per-handover — passes. Build when a second issuer exists |
| the deferred anchor | passes NONE. Admissible only as a narrow fourth category — see below |

**Notarisation, the fourth category, and its tripwire.** An on-chain digest is permitted only
while (a) amortised per epoch, never per statement, (b) read on nobody's hot path, and (c) the
system is fully functional without it. **The moment any feature REQUIRES the anchor, it has
silently become a rights registry and must re-justify itself under the three tests.**

**Where the boundary is under pressure — the drift vectors, named so they are recognised:**

- **"Make the verified count trustless."** Contracts never read, embed, or enforce counts.
  A threshold inside a contract is a count crossing the boundary disguised as a right.
- **Badge claims dragging counts chainward.** The rule splits it cleanly: the slot crosses,
  the count never does.
- **Sponsorship blur.** The platform sponsors gas for EVERY account kind — passkey and
  web3auth alike, everyone on Kernel + paymaster (owner decision, 2026-08-19; note
  `SUBENS_IDENTITY.md` still describes the passkey path only and is narrower than intent).
  Sponsored actions stop FEELING like chain writes. Sponsorship changes who pays, not the
  classification: a sponsored per-like attestation still fails test 3.
- **Sybil despair** — "just make statements cost gas". Fails test 3 by construction and
  re-imports the slot-model scaling this design escaped. The committed answers are cost
  friction at identity/batch level, and tiered counts.
- **Identity leaking into the data plane.** Chain state may re-ATTRIBUTE records (who owns the
  brand these follows accrue to); it may never AUTHENTICATE them. Statement validity must
  never depend on a chain read.

Why this does not drift: each test turns on an object's cardinality and its need for
negation — properties readable off the design, not matters of taste — and the freeze
discipline gives it teeth, since anything crossing in either direction is a format bump that
must cite which test flipped.

## Three gates, not one (settled 2026-08-19; one thread still open)

"Gating" has been used for three unrelated things. They have different enforcement points and
must not be conflated — conflating them is what makes a straddled design messy.

**Gate A — admission to platform-funded actions.** Purpose: protect the PLATFORM's budget
(sponsored gas, platform postage) from automated signups. Enforced server-side at the relay,
with rate limiting. This is admission policy, NOT part of the portable data plane, and it is
the correct home for "you must hold a ticket to like this event".

The consequence, stated plainly because it is the design working rather than breaking: **a
third-party indexer will tally statements our relay would have refused.** Commitment 6
protects rebuildability of PROJECTIONS, and the raw tally stays rebuildable by anyone. A
write-time gate was never enforceable against the actors it targets in any case — at P3 the
server drops out of the write path entirely and a bot writes validly-signed statements to its
own feed regardless. Gate A therefore expires naturally as users fund their own writes; that
is the plan working, not a hole.

**Do NOT put ticket evidence inside the like statement.** It would make the EVIDENCE portable,
not the gate, at the cost of: a `woco.like.v2` bump the freeze already priced for exactly this
case ("if likes ever feed a gate, that is a NEW format"); a permanent per-like link between
someone's social activity and their attendance identity, on a platform serving children; and a
forced public bridge between the ed25519 ticket key and the secp256k1 feed key, which the
credits design deliberately confines to publish and badge-claim moments. Where a VERIFIABLE
ticket signal is genuinely needed, the portable answer already exists in this plan: tiered
counts (raw vs ticket-verified attendee), computed at the view layer from disclosures a user
chooses to make. Deferred until a consumer for that tier exists.

**Gate B — entitlement to exclusive content** (club emblems, member forums, "gold" tiers).
Purpose: product access. This one MUST be client-verifiable and work with no server long-run.
Its trust root is an ISSUER's signature over a POD, not our relay. Constraint already settled
in `COASTER_CREDITS_PLAN.md`: **credits must never satisfy a `PodGateRule`** — a self-signed
statement passing a gate that today requires trustless truth is the failure mode. The shape
that works is an issuer-signed emblem minted after the issuer reads the VERIFIED count. Swarm
`ACT` is available for SOCs and is a candidate for many-grantee club content, but it encrypts
the payload and not the address, so presence stays observable.

⚠️ **OPEN:** Gate B is not designed. The owner's direction — a user imports a POD, signs to
bind it to themselves, and that grants access, with no server in the long run — needs a design
pass of its own covering possession challenges, revocation (a club withdrawing an emblem needs
live negation, which is test 2 territory), and how a browser verifies entitlement offline.
Do not build Gate B by extending Gate A.

**Gate C — eligibility to make a statement at all.** Not a separate mechanism: on a
permissionless substrate anyone may write to their own feed, so this reduces to Gate A at the
relay plus what indexers choose to count. Recorded so it is not designed twice.

## The subject index is BANDED too (settled 2026-08-19)

Likes and follows do NOT have the credits problem on the statement axis — commitment 3 makes a
like latest-wins, so a like topic accumulates a version per TOGGLE, one or two, not per action.

The INDEX is the growth axis. `addToSubjectIndex` rewrites the whole list at the next version
for each new subject, and subjects are never removed (removal would hide the `false` an
indexer needs in order to stop counting). So index versions = distinct subjects ever touched,
permanently. A 2,000-like user has a ~2,000-version index feed and finding its head is the
same forward walk credits had.

Scoped honestly before prescribing: `readMySubjects` currently has ZERO call sites, and
displayed counts come from the indexer's tally, not from walking this. The only live path is
`addToSubjectIndex` itself, on each NEW-subject like — so a cold device pays one full walk on
its first new-subject like. Imperceptible at tens of likes, ~10s at a few hundred,
structurally unbounded. Misses stay O(1) throughout: a hit-RTT problem, milder than credits,
same shape.

**The fix, and why it is free.** `subjectIndexTopic` gains a band exactly as `statementTopic`
did — HMAC message `utf8("subject-index") || uint64BE(band)`, same
`STATEMENT_BAND_SIZE = 64`, same full-band invariant. Social has no partition rule and so no
second object read first to carry the band; it does not need one. The full-band invariant makes
the band DISCOVERABLE with no carrier: probe band openers `(0,0), (1,0), …` in the existing
window-2 pipeline — every opened band is a hit — then scan the current band. At 2,000 subjects
that is ~16 opener probes + ≤32 in-band RTTs ≈ 40, against ~1,000 today, with O(1) misses.

**No format bump for social.** Each index version is already a full snapshot, so only the topic
derivation moves and a band-0-only world is behaviourally identical to today. Readers and
writers need no new logic until a user crosses 64 distinct subjects. Do this in the SAME
pre-launch derivation edit as the credit banding — one uniform discipline, one re-test, zero
additional formats, and the credit index feed gets the same bound for free.

**Deferred with a threshold:** delta payloads (only-new-subjects-per-band) to dodge the
snapshot-size ceiling — each version being a full snapshot means ~15,000 subjects hits the
256-page multi-chunk cap. Revisit when a real index exceeds ~5,000 subjects or its snapshot
exceeds ~64 pages. Until then snapshots win on simplicity.

## Phases

- **P1 (build now, pre-launch target): likes + follows on current infra.**
  Client signs the statement with the derived feed key → sends via existing authed API →
  server verifies sig, writes the user's social feed (relay + platform stamp), updates the
  index projection → UI reads counts from the index. Zero new transport, zero new node
  requirements. Runs entirely on bee + Hono as deployed today.
- **P1.5: verifiability.** Publish the index to Swarm as evidence manifest (commitment 4);
  clients auto-check their own inclusion ("am I in the count?") — turns "omission is
  detectable" into "omission is detected". Organiser audience export.
  The READER side of commitment 4 landed 2026-08-16 (see COASTER_CREDITS_PLAN, "The
  verification page"): a browser recounts the published leaves and reads one of the named
  chunks straight from storage.
  The WRITER side landed 2026-08-17 (#312). A report — `woco.evidence-report.v1`: the
  manifest byte-for-byte, plus `unreadable`, `equivocations` and a self-declared
  `publishedAt` — is written to `woco/evidence-report/v1/{HMAC(salt, subject)}`, salt
  folding in the statement format, owned and signed by a DEDICATED indexer key
  (`SOCIAL_INDEXER_ADDRESS` in shared). The wrapper exists to keep the manifest a
  deterministic function of its inputs: circumstances of a run go OUTSIDE it, or two
  indexers stop being comparable. Same topic string for every indexer — differentiation
  is by owner address space, which is the permissionless-indexer model written as an
  address. Reads never trigger a write (the relay marks a subject dirty; a timer with a
  per-pass ceiling drains it), identical reports are not republished, and a write that
  cannot be read back keeps the subject dirty rather than reporting a durability we
  do not have.
  STILL OPEN at P1.5: the in-app "am I in the count?" self-check, which is the right home
  for like/follow verification and needs the signed-in identity side.
- **P2: user-owned batches.** Platform pays `createBatch` with the USER'S address as
  `_owner` (verified: payer ≠ owner in the contract; bee validates stamps against owner).
  Users stamp client-side; old chunks re-stampable without re-signing (hash-preserving).
  CARVE-OUT: only STATEMENTS move to user batches. An indexer's own reports stay on the
  indexer's batch at every phase — whoever runs one pays for what they publish. A report
  on a user's batch would make one rider's postage the availability of everyone's count.
- **P3: server drops out of the write path.** Browser/light clients upload to the same
  feeds themselves and announce over transport (app-level libp2p, Waku — LightPush/
  Filter/Store fit browser clients — or PSS, see below; decide when real). Feeds/keys/
  addresses unchanged → nothing migrates. Personal views (own timeline) compile
  client-side with no indexer.
  PSS is a recorded candidate for the ANNOUNCE step (#312 comment), not yet decided. It
  answers two of the three objections that killed GSOC: durable (an announcement sent
  while the indexer restarts still arrives) and addressed to one recipient, optionally
  encrypted. The third — subscribe needs a full node — does not bite, because we are the
  subscriber and run one. LOAD-BEARING RULE if built: an announcement is a HINT, never
  evidence. The indexer still reads the feed and verifies, so a forged announcement costs
  a read, not a wrong count — and the bound to design is reads provoked per announcement
  (same family as #301), settled before building.
  THE INDEXER ITSELF SHOULD END UP CLIENT-SIDE (owner direction, 2026-08-17). Reading is
  already: with reports published, a browser derives the address and reads a count with no
  API call. Tallying needs no server either — read participants, read their feeds, verify,
  add up — it is held server-side only by discovery and fan-out cost. Publishing needs a
  key but not OURS: a browser could publish its own report under its own feed key, and the
  topic is identical for every indexer. This is why #312 is a prerequisite rather than a
  detour: a browser cannot bootstrap a tally without the participant list, and until it is
  published that list exists only in our `.data`.
- **P4: forum.** Same pattern, more statement types: post (CAC content referenced from
  author's feed), comment (references parent post address), vote (= like), moderation as
  signed curation statements applied at the view layer (no deletion of others' data;
  platform serving-layer suppression for illegal content mirrors the event listing-state
  overlay), reputation = recomputable formula over public statements.

## Decisions already made (do not reopen without new facts)

- **GSOC rejected** for ingestion: latest-value-only (no durability/replay), shared-key
  (no transport authorship), subscribe requires a full bee node, and Vertex (candidate
  Rust node) explicitly won't support GSOC/pubsub ("transport wedged into storage — use
  libp2p normally"). Notification = plain transport; storage = truth. Same conclusion as
  SWIP PR #94's own stance: "feeds for the source of truth, messaging for live propagation."
- **Multi-owner chunks abandoned as a requirement**: no sound primitive exists; the need
  (shared threads/counts) is met by composing single-owner chunks at the view layer.
- **window.swarm (SWIP PR #94)** is plumbing (page↔node), not architecture. If it ships,
  it can become the P3 write pipe. We do NOT adopt its origin-scoped identity model —
  identity must be cross-domain (commitment 2).
- **Indexer role is permissionless by design, not absent.** Global views need a compiler
  everywhere (cf. The Graph, Bluesky appviews). Power is removed instead: can't forge
  (sigs), can't lie undetected (evidence + self-checks), can't hold data (view plane
  only), can't monopolise (open code + public inputs; indexing scales down to
  per-community nodes).

## Anti-abuse (P1 scope)

Forgery impossible (signatures). Dedupe at index (commitment 3). Ingest behind existing
rate-limit patterns (cf. claims 3/15min). Sybils: unsolved everywhere — cost friction
(identity now, batch later) + tiered counts: raw vs **ticket-verified attendee** (POD
ticket holders — a WoCo-unique, near-Sybil-proof signal) vs (future) personhood proofs
(zkPassport-class) as an additive attestation. Counts are reputational, not financial —
launch-level protection is sufficient.

## Verified facts this plan rests on (all read in source, 2026-07-30..08-01)

- `createBatch(address _owner, …)`: payer ≠ owner (storage-incentives PostageStamp.sol).
- Stamp validity = sig recovered against batch owner (bee `pkg/postage/stamp.go` Valid()).
- Light nodes can upload/send with a batch; GSOC subscribe needs full node (bee docs).
- Re-stamping preserves chunk hashes (our batch-migration work).
- bee exposes `POST /envelope/{address}` (pre-signed stamps) — optional courtesy tier.
