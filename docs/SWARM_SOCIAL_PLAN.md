# Swarm-Native Social: Likes, Follows, Forums — Plan

STATUS (2026-08-04): AUTHORITATIVE for all social features. Supersedes the on-chain EAS
likes design (`docs/EAS_LIKES_HANDOVER.md`) for launch — EAS likes are built but will NOT
launch; no chain dependency for social. The EAS doc remains useful for its abuse model
and UI notes only.

2026-08-19: the CHAIN BOUNDARY RULE is settled — social carries no chain dependency, and the
three-test rule below governs what ever may. The subject index is banded (topic derivation only,
no format bump). "Ticket purchase unlocks liking" is Gate A — relay admission policy, not data
plane. Gate B (POD-granted access to exclusive content) is DESIGNED — the POD certificate rail, zero chain
footprint, nothing to freeze this week.

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

**Gate B — entitlement to exclusive content** (club POD certificates, member forums, "gold" tiers).
Purpose: product access. This one MUST be client-verifiable and work with no server long-run.
Its trust root is an ISSUER's signature over a POD, not our relay. Constraint already settled
in `COASTER_CREDITS_PLAN.md`: **credits must never satisfy a `PodGateRule`** — a self-signed
statement passing a gate that today requires trustless truth is the failure mode. The shape
that works is an issuer-signed POD certificate minted after the issuer reads the VERIFIED count. Swarm
`ACT` is available for SOCs and is a candidate for many-grantee club content, but it encrypts
the payload and not the address, so presence stays observable.

**NAMING, decided 2026-08-20 and recorded so it is not re-litigated.** This rail was called
the EMBLEM rail until Gate B was about to be built. Renamed to **POD certificate** (type token
`pod-cert`) because "emblem" and "badge" are near-synonyms that were being used for two
DIFFERENT things, in the same expressions — `statementTopic("emblem", 1, PUBLIC_SALT,
badgeManifestRef)` is the whole problem in one line. The badge is the POD; the POD certificate
is the signed record of who holds it.

Rejected alternatives, with reasons: plain **`certificate`** already means X.509 in this
codebase (`X509Certificate`, the SNS signing certs in `sns-verify.ts`); **`award`** is already
loyalty milestones (`awardSpendMilestones`); **`grant`** collides with Swarm ACT grantees.

The urgency was real rather than cosmetic: `statementTopic` bakes the type into a PERMANENT
Swarm address (`woco/pod-cert/v1/…`), and this plan's own rule is that the address layer
outlives the payload schema — a topic cannot be versioned away once written. The rename cost
four files while Gate B was unbuilt; after the first statement is written it would have cost
nothing less than a migration.

✅ **DESIGNED — Gate B is the POD-CERTIFICATE rail (2026-08-19, Fable design pass).** Nothing here
replaces PODs. The badge stays a POD — its manifest, artwork, `PodKind: "badge"`, its place in
the POD directory. What changes is only **how HOLDING is recorded**: today that is a chain
slot, and the POD certificate makes it an issuer-signed statement that names the holder.

**What forced this, discovered in source rather than assumed.** Standalone badge issuance is
ALREADY on-chain and cannot be done otherwise: `issuePodType` sponsor-registers every badge
type via `registerEventOnChain`, and `apps/server/src/lib/pod/issuance.ts:66-70` refuses to
mint where `WoCoEventV2` is absent — because holdings are only readable from chain slots.
`pod/types.ts:24-26` says why in as many words: "No `claimedBy` field: ownership is recorded
on chain (`slotOwner[eventId][slot]`), not in the POD." So Gate B was never "add a gate" — the
gate already exists and `evaluatePodGate` is already pure, no chain, no I/O. The job is to
give that gate a HOLDING SOURCE that is not a chain read.

**The record / entitlement split (owner, 2026-08-19) — the load-bearing idea.** An POD certificate
carries two separable things:

- **The RECORD** — "this issuer signed, on this date, that this holder did X." A signed claim.
  It fails all three boundary tests: not exclusive (1), a valid signature never needs a
  present-tense negative (2), issuance is per-holder (3). **Chain-free permanently**, exactly
  like credits, differing only in WHO signs. It survives the issuer's death, because a
  signature validly made can never be un-signed.
- **The ENTITLEMENT** — "this opens the members' door." Not an object at all: a policy applied
  to records by whoever guards a resource, at their own door, at access time. It ends when the
  issuer ends it or ceases to exist, and that is the definition working, not a failure.

This CORRECTS an earlier read that revocation was chain-shaped. Test 2 asks whether a verifier
needs a live negative WITHOUT a live source of truth — and a door IS a live source of truth. A
dead issuer has no door with anything behind it to guard.

Three sharpenings, without which the split is too neat:

1. **Soulbound-ness is what keeps the POD certificate on the record side.** Transferable-with-value
   means two honest parties can dispute who holds it NOW — test 1 — and it becomes the deferred
   `authenticity` / ERC-721 object, not this design. The wall is structural: **the POD certificate names
   its holder's key in the signed body**, so a copy is worthless to anyone who cannot answer a
   challenge with that key. `PodKind: "badge"` is already declared soulbound, so this fits the
   existing type system rather than bending it.
2. **"Stopped supporting" and "says you never earned it" are distinguishable in CONTENT, not in
   TIMING.** An issuer can never un-sign; a disowning issuer produces a SECOND signed statement
   and third parties see both (the equivocation-flagging ethos already frozen for credits). What
   nobody can verify is WHEN either was signed — nothing timestamps a write. That residue is
   exactly what the optional anchor category is for: per-epoch notarisation of the issuer's log,
   on nobody's hot path, functional without it.
3. **Retroactive revocation of already-decrypted content is impossible for everyone**, not just
   us. Revocation there is exclusion from the next grant epoch, which needs no negation at all.

**The object.** `woco.pod-cert.v1` — an issuer-signed statement riding the STATEMENT DISCIPLINE,
referencing the POD display layer, using none of the Merkle-batch / chain-slot machinery:

```
unsigned = {
  format:   "woco.pod-cert.v1",
  badge:    Bytes32Hex,   // the badge TYPE's manifestRef — joins the POD directory,
                          // artwork, PodKind:"badge", swarmManifestRef for display
  holder:   Hex32,        // recipient's ed25519 POD key — same identity that owns their tickets
  issuedAt: "YYYY-MM-DD", // UTC, self-declared; timing hardened only by the optional anchor
  evidence?: string[]     // optional digest refs to what the issuer read (audit trail)
}
issuerSig = ed25519(keccak256(utf8("woco-pod-cert-v1\n") || dagCbor(unsigned)), issuerKey)
```

The issuer key is the badge type's `ManifestV1Body.issuerPubkey` — the same ed25519 key that
signs manifests — so display identity and signing identity join with nothing new built. It
claims `"woco-pod-cert-v1\n"` in the prefix registry per the frozen rule; closed schema,
JSON-safe, dispatch-before-validation, all inherited. Canonical publication is the ISSUER's own
feed (matching witness batches) at `statementTopic("pod-cert", 1, PUBLIC_SALT, badgeManifestRef)`
— which arrives already count-banded with an enumerable subject index, because the banding pass
is type-generic. The holder imports a copy into their passport for availability; the issuer's
log is the supply-auditable source.

**This COMPLETES the "credits must never satisfy a POD gate" rule rather than bending it.** The
POD certificate is the bridge object that rule anticipated: the issuer reads the VERIFIED count, the
issuer signs, and only the issuer-signed object feeds the gate. A `PodHolding` may therefore
derive from exactly two sources — chain slots (as documented today) or verified POD certificates (issuer
signature + possession proof), per-gate opt-in — and never from the spoofable collection feed
or a self-signed tier-1 statement.

**Binding — inverted.** The POD certificate is BORN BOUND: the issuer signs the holder's key into it, so
binding is not a ceremony a copied object could race. Copying the bytes is possible and
pointless, because every use ends in a challenge only the named key can answer:

```
challenge = { format: "woco.pod-cert-challenge.v1", badge, holder,
              audience,           // verifier identity/origin — no cross-door replay
              nonce, expiresAt }
holderSig = ed25519(keccak256(utf8("woco-pod-cert-challenge-v1\n") || dagCbor(challenge)), holderKey)
```

Structured bytes under its own registry prefix, per the frozen rule that the holder key never
signs an externally supplied digest. The genuinely unbound case — an POD certificate earned before a key
existed — is resolved by **re-issuance, not self-service binding**: only issuer signatures ever
create holdings.

**Offline verification.** A verifier holds the badge type's manifest (or `manifestRef` +
`issuerPubkey`), the POD certificate, and the challenge. The check is pure: issuer signature against the
manifest key; challenge signature against `POD certificate.holder`; local policy. First sight needs at
most two content-addressed fetches — self-verifying, zero trust in the source — and **fails
closed**. Previously verified POD certificates cache with the manifest, so offline RE-ENTRY works
indefinitely. The one thing an offline door cannot see is a recent policy change: inherent,
bounded by the guard's cache TTL, the OCSP-stapling trade-off stated rather than hidden.

**Chain footprint: ZERO.** Two chain-shaped residues stay deferred and are already catalogued:
issuer-key compromise / authority-over-time is the deferred ISSUER REGISTRY (passes all three
tests, per-handover, build at the second issuer); timing fabrication is the ANCHOR category.
Today's slot-model badges sit inside the rights rail, which is legitimate for chain-gated
commerce but is not Gate B — the two rails coexist behind the same pure evaluator via the
holding-source opt-in.

**Encryption is OUT OF SCOPE for v1.** Access is an application-layer check at a live door.
When door-less exclusive content becomes real, the credits ACT verdict does NOT transfer — that
was a grantee-list-of-one with a privacy goal; this is many-grantee club content where address
observability is acceptable. ACT is then a live candidate against per-drop HPKE (seal the
content key to each current holder's X25519 key at publish, which gives forward revocation for
free). One cheap enabler to consider when `woco.pod-cert.v1` is actually written: an optional
`encPubKey`, so publishers can seal to holders enumerated from the issuer's log.

**FREEZE IMPACT THIS WEEK: NONE.** Signing prefixes are late-claimable by design; the POD certificate's
topics and index arrive free because the banding edit is type-generic; the badge-`manifestRef`
subject convention sits in the deliberately-unfrozen per-type derivation slot;
`PodGateRule`/`PodHolding` are mutable config, not frozen surface. Freezing POD-certificate-specific
fields now would be speculative surface. Two actions only: when landing the banding pass,
verify `statementTopic`/`subjectIndexTopic` keep their `type`/`version` parameters GENERIC; and
record the sentence below.

**Rail note, so this is not later built on the wrong rail out of momentum: the STATEMENT
DISCIPLINE — not the Merkle-batch / chain-slot rail — is the intended home for future
issuer-signed grant types.**

**On libp2p** (the framing this work started in): not relevant as a mechanism. Verification
here has no transport of its own — the challenge is answered at whatever door is being knocked
on, and every other input is a signature or a content-addressed fetch. Where a serverless
handshake transport is ever wanted, PSS / Waku are the recorded candidates. The instinct it
encodes — no privileged server anywhere in verification — is satisfied structurally, which is
the correct way to honour it.

**Where this is INVENTION, and what to prove before Gate B ships.** The components are known: a
verifiable-credential shape (issuer-signed claim + holder possession proof) built from this
repo's own primitives instead of a DID stack, and grant-at-publish is standard forward-secrecy
shape. The genuine inventions are the join — statement-discipline crypto under POD-layer
display identity — and POD-certificate-derived holdings as a peer of chain slots in one evaluator.
Before launch, prove two things: a two-browser end-to-end with the server BLOCKED (issue in one,
verify + challenge in the other, network log empty except content-addressed gateway reads); and
the possession-challenge UX on real key custody — what a challenge signature actually costs a
user in passkey prompts.

### BUILD RECORD — slice 1, the crypto core (2026-08-20, `feat/pod-cert-rail`)

`packages/shared/src/pod-cert/` — `woco.pod-cert.v1`, `woco.pod-cert-challenge.v1`, the
issuer's banded log topics, and the door. Pure, no I/O, no chain, nothing written to an
address yet. 35 tests, frozen digest/signature/topic vectors included; shared suite 242 green.

Five things were decided here that the design above did not settle. They are recorded because
four of them are frozen and the fifth is the rule the whole rail exists to keep.

1. **`encPubKey` is IN, optional** (owner decision). The plan parked it as a "cheap enabler to
   consider". It is not redundant and could not have been added later for free: the holder's
   X25519 key is HKDF'd from the POD SEED (`crypto/keys.ts`), not convertible from the ed25519
   `holder`, and no WoCo feed publishes it — `UserProfile` has no key field. Without it, a
   per-drop HPKE publisher enumerating an issuer's log has no key to seal to. Omitted-not-null,
   so a certificate without it hashes exactly as it would have.
2. **No `issuer` field.** Computable: `badge` IS `keccak256(dagCbor(manifestBody))`, so
   `resolvePodCertIssuer` recomputes the digest and returns the manifest's `issuerPubkey` with
   the binding already proved. Same rule that killed the credit statement's `prevSession`.
   Skipping the digest recomputation is the substituted-manifest attack — an attacker's manifest
   naming their own `issuerPubkey`, against which their forgeries verify perfectly. Tested.
3. **PRESENCE, NOT QUANTITY.** A certificate holding is `count: 0 | 1` with `slots: []`. Two
   consequences, both deliberate and both fail-closed: a `maxSlotExclusive` first-N gate is
   UNSATISFIABLE from certificates (there is no allocation order on this rail, and inventing an
   index would let a gate be passed by a number nothing allocated), and `minCount > 1` cannot
   pass (re-issuance after a key rotation must never add up to "holds 2"). Rejecting such a
   gate at its WRITE boundary, where it can be explained to the organiser instead of silently
   never opening, is slice 2 work.
4. **`issuedAt` is validated syntactically only** — `2026-02-30` is accepted, exactly as the
   frozen credit validator accepts it. A stricter rule would make two honest implementations
   disagree about garbage on a self-declared field nothing verifies.
5. **The hard rule is structural, and now executable.** The only route from bytes to a
   `PodHolding` on this rail is `podCertHolding`, which takes issuer-verified certificates and
   nothing else. A `woco.credit.v1` object fails format dispatch — asserted in
   `test/pod-cert/cert.test.ts`, including against its own signer.

Two prefixes, not one: `woco-pod-cert-v1\n` and `woco-pod-cert-challenge-v1\n`. Sharing one
would let a certificate's bytes be replayed as a challenge answer, or the reverse.

FOOTGUN, flagged where it lives: the index format id is `woco.pod-cert-index.v1` but its SHAPE
is `SubjectIndexV2` (band-carrying), because certificate feeds append one SOC version per
issuance and so cross bands. The `V1`/`V2` in the discipline's interface names version the
SHAPE; the `.v1` here versions this type's payload, which has never had another version.
Validate only through `validatePodCertSubjectIndex`.

SIGNED OFF 2026-08-20 (Fable, verdict MERGE). The review recomputed every frozen vector from
raw dag-cbor/keccak/HMAC primitives rather than trusting the tests, and confirmed the
canonicaliser and validator field sets are congruent for both schemas — so signature bytes
always equal checked bytes. Three would-improve findings, none must-fix; two are applied in
this slice (a conformance check on the resolved issuer key, so a nonconforming manifest fails
where it can name its cause; and the holder-client relay rule written down at
`signPodCertChallenge`). The third is carried below.

The carried finding — the bare `issuerPubkey: Hex32` parameter — is CLOSED in slice 2 below.
The `holdingSource?: "chain" | "pod-cert"` shape sketched here was a placeholder and was
OVERRIDDEN by slice 2's design pass; read that section, not this sentence.

### BUILD RECORD — slice 2, the holding-source opt-in (2026-08-20, `feat/pod-cert-gate`)

Makes the rail REACHABLE: a stored gate can now declare which source proves it, and the write
boundary validates per source. Fable design pass before building; its answers below are the
design, and two of them overrode what this plan previously said.

**`PodGate` is a DISCRIMINATED UNION, not an optional-field bag** (override). `ChainPodGate |
CertPodGate`, discriminated on `holdingSource`. The ~113 references are mostly pass-through and
cost nothing; the sites that actually dereference a read-coordinate are few, on money-moving
routes, and the compiler now names every one. A third source later breaks compilation at each
dispatch instead of adding an optional nobody narrows. The gate type follows the same
dispatch-before-validation discipline as the statement formats.

**Absent `holdingSource` means CHAIN**, and `holdingSource` is optional on the chain variant
*and nowhere else* — that asymmetry is what makes the default hold in TypeScript as well as at
runtime. Safe on two independent grounds: historically true (every pre-field gate passed
`validatePodGate`, which required the chain binding, so no other kind exists), and safe by
direction (chain is the strictest proof, so misreading can only make a gate harder to pass,
never let a certificate satisfy chain-configured trust). Present-but-unrecognised REFUSES, so a
gate written by a newer client fails closed on an older server rather than falling into the
chain arm.

**The certificate gate stores `swarmManifestRef`, NEVER `issuerPubkey`** (override of the
obvious symmetry with `onChainEventId`). A stored issuer key cannot go stale — the key is baked
into the manifest, so a different key is a different `manifestRef` and therefore a different
badge — but it can be BORN WRONG: a buggy or future-untrusted client writes a gate pairing badge
X's ref with attacker Y's key, every forged certificate then verifies perfectly, and the UI shows
X's artwork throughout. Storing one would manufacture exactly the object slice 1's carried
finding warns about. The ref is a location hint checked against the digest, so a wrong ref fails
closed instead of shifting trust.

**The two arms are load-bearing at DIFFERENT TIMES, and this is recorded because it reads like
an inconsistency.** The chain arm proves its binding ONCE at the write boundary and is sound only
because the gate is then stored in a platform-signed feed. The certificate arm re-proves its
trust root on EVERY use, which is why it stays sound even if gates move to untrusted client
storage — the property Gate B's serverless endgame needs. The cert arm's write-boundary check is
therefore organiser UX (catch a dead ref where it can be explained), not the trust check.

**A latent defect the design pass found, now closed:** duplicate `manifestRef` within one
`PodGateGroup` was harmless with one source and is a live bug with two. Enforcement reads ONE
holding per `manifestRef` and `evaluatePodGateGroup` matches holdings by `manifestRef` alone, so
a group pairing a chain gate and a certificate gate for the SAME badge would evaluate the second
against the first's holding — under `mode: "all"`, counting a single proof twice. Refused at the
write boundary.

**Slice 1's carried finding is closed** by `podCertHoldingFromManifest`, which resolves the
issuer internally and so cannot be handed a key at all. It is the only entry point the server
uses.

Write boundary now refuses, all before any network read except the last: duplicate badges,
unrecognised sources, `minCount > 1`, `maxSlotExclusive`, and a `swarmManifestRef` that does not
resolve to a manifest whose digest is `manifestRef`.

**SPECIFIED NOW, BUILT WITH THE HOLDER SLICE — the challenge round trip.** Recorded so slice 2's
types do not paint it into a corner: claim bodies grow `gateEvidence?: { presentations }`; the
nonce is minted on pre-steps that already exist (Stripe session create; the agent rail's x402
descriptor `extra`) plus a small `POST /api/claims/gate-challenge` for the direct path; the
record lives in an in-memory TTL map that must NOT survive restarts (losing it voids outstanding
challenges and the claimer redoes the handshake — fail-closed, same reasoning as the broadcast
keys), bounded per IP so minting is not a memory DoS; audience is a deterministic server identity
with claim context folded in (`events-api.woco-net.com/gate/{eventId}/{seriesId}`), so a nonce
minted for one series cannot be spent on another; the expectation is rebuilt from the stored
record, never from the request; and the nonce is consumed inside the per-series claim queue,
atomically with the claim commit. `cert.holder` must equal the claimer's verified POD identity
where the route has one — otherwise a cooperative holder can sign challenges for strangers, which
is the certificate-rail twin of the wallet-must-be-the-claimer rule.

**NOT in this slice, deliberately:** the editor must not offer the certificate source until
certificates can actually be issued, or organisers will configure gates nobody on earth can pass
(`PodGateEditor.svelte`'s `gateable` filter is the seam, and it must become source-aware). And
`issuePodType`'s `WoCoEventV2` requirement should be dropped for certificate-only badges — right,
but it belongs with the issuer write path, because "chain footprint: ZERO" stays false until that
lands and must not slip past it. Note that ticket PODs keep `swarmManifestRef` on `SeriesSummary`
rather than the directory entry, so certificate-gating a ticket POD either resolves it from there
or is refused for now.

STILL TO BUILD: the issuer's write path (sign + publish to the banded log, subject index
upsert) and the issuance decoupling above; then the holder's passport import, the challenge
round trip as specified, and the challenge-signing UX; then the two proofs demanded above
(two-browser end-to-end with the server BLOCKED, and what a challenge signature actually
costs in passkey prompts).

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
