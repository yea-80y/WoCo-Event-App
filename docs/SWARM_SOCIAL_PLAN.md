# Swarm-Native Social: Likes, Follows, Forums — Plan

STATUS (2026-08-04): AUTHORITATIVE for all social features. Supersedes the on-chain EAS
likes design (`docs/EAS_LIKES_HANDOVER.md`) for launch — EAS likes are built but will NOT
launch; no chain dependency for social. The EAS doc remains useful for its abuse model
and UI notes only.

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
