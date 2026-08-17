# Coaster Credits — Rider-Signed Credentials Plan

STATUS (2026-08-14): P0 FROZEN. The statement discipline and the v1 payload schemas are
frozen — see "FROZEN AT P0" below; the normative code is
`packages/shared/src/{statement,credit,social}/`. Build not started. Identity and
visibility are DECIDED (see Open questions). Origin: the Rita 100 charity challenge
(Digital Dan, September 2026) as the pilot for a general ride-credit system.

Companion to `docs/SWARM_SOCIAL_PLAN.md` — this shares its indexer, its trust model and
its portability commitments. Read that first; this doc states only the deltas.

## THE ARCHITECTURE, IN ONE PLACE

Read this first. Everything below is detail and history.

### What a rider does

1. Rides Rita. Opens the app, **taps or scans**. That is the product — the collecting moment.
2. First time on Rita, they get the **Rita POD** — a signed credential in their passport. In the
   community's own vocabulary that *is* the credit: ridden once, ever.
3. Every later ride increments a **count** carried on that POD.
4. Rare milestones may issue a further POD. Events may issue a **commemorative** POD, which is
   participation-based, not threshold-based.

### What exists, and who signs it

| object | signed by | where | on-chain? |
|---|---|---|---|
| Ride statement | rider's ed25519 holder key (`holderSig`) | rider's own Swarm feed, encrypted by default | **no** |
| Coaster POD / milestone / commemorative | the issuer's ed25519 key | Swarm | **no** |
| Exit token (tier 2) | the exit device's key | embedded in the rider's statement | **no** |
| Witness batch (tier 3) | the issuer's ed25519 key | issuer's own feed | **no** |
| Device allowlist, subject definition | each issuer, on their own feed | Swarm | **no** |
| The index | nobody — computed, rebuildable by anyone | — | **no** |

**Nothing in this design touches a chain.** Not per ride, not per coaster, not per POD, not for
the subject namespace. The only chain-shaped question left is issuer authority, and it is
deferred until a second issuer exists — see "The walkaway test".

### Who vouches

- **The rider always acts** — the tap is what creates the record and binds their identity.
- **Two different vouches, do not conflate them.** The issuer's signature on a POD type says *this
  credential is genuine*. That is always present. Whether someone *actually rode* is a separate
  question, and at v1 nobody answers it.
- **v1 is option (c): no vouching at all.** Riders manage their own collections, exactly as the
  ecosystem works today. No device keys, no allowlist, no tier computation. The `exitTokens` hook
  exists in the schema but stays empty.
- **The intended direction is option (b): open vouching, reputation-weighted.** Anyone may vouch;
  the view layer weighs vouches by reputation computed from public statements — the shape
  `SWARM_SOCIAL_PLAN` already describes for the forum ("reputation = recomputable formula over
  public statements"). A park's vouch carries weight because the community trusts it, not because
  we blessed it.
- **Option (a), a platform allowlist, is REJECTED.** It puts us permanently in the middle deciding
  whose word counts, which is the opposite of everything else here. It was in an earlier revision;
  it should not come back.
- **WoCo never attests to a ride**, under any option.

### The walkaway test — and why it does NOT justify a chain

If WoCo stops existing tomorrow, what survives?

Rider statements are signed and public, but they live on Swarm and Swarm needs postage. An
earlier revision of this section concluded that therefore the subject namespace must go on-chain,
"because the chain is the only component that survives us paying for nothing".

**That was wrong, and it is recorded here so it is not re-derived a fourth time.** Postage
duration is a Swarm problem with a Swarm answer: batches can be bought long, and
`SWARM_SOCIAL_PLAN` P2 already has users owning their own. Topping up a batch is far easier than
running a server, which is the actual alternative. Moving a namespace on-chain to avoid buying
storage imposes a permanent, usage-scaling cost to solve something the architecture already
solves — and there are thousands of coasters.

So: **the namespace stays on Swarm.** Durability comes from long-lived batches now and
user-owned batches at P2.

The one thing that remains genuinely chain-shaped is **issuer authority**, and only because of
revocation: a signed delegation can never prove it *was not* revoked without a live source of
truth. That is deferred until a second issuer exists, at which point it is one transaction per
handover — not per coaster and not per rider.

If no park ever comes on board, what remains is a self-reported credit tracker with a verifiable
public log — Coaster Count with cryptographic receipts, running on storage anyone can keep paying
for. That is a product on its own, and it is what the walkaway test is really asking.

### Why nothing ELSE goes on chain

A chain is genuinely good at three things: unforgeable ordering, ownership of a scarce
transferable asset, and trustless enforcement inside a contract. A soulbound credential derived
from signed attestations uses none of them.

If a park signs "this holder rode Rita 100 times", that is verifiable by anyone, forever, with no
chain. Minting a badge would not make it more true — it would copy a pointer into a more expensive
database, and it would add two costs: a **sponsored-mint drain**, since tier-1 credits are free to
manufacture and the gas is ours, and a **supply cap**, since `issuePodType` registers a fixed
supply a farmer could exhaust to deny real riders.

Tickets keep the chain because they need money, escrow and resale. Credits need none of that.

### What a POD is without a chain

A POD is a signed credential — a body plus an ed25519-signed manifest. The chain was never what
made it a POD; it is the ownership *ledger* used for tickets, because tickets must be transferable
and checkable offline at a door by an adversarial verifier.

So a rider's coaster POD is issued, signed, names their holder key, lives in their passport, and
can gate things. What dropping the chain costs is the ability to *sell* it and for a contract to
read it — neither of which an achievement wants.

### Gating, when it arrives

A gate reads verified attestations directly. It needs no chain, because the trust root is the
issuer's signature, and the index is rebuildable by anyone who distrusts ours. Offline gating
works the way the door scanner already does: pre-download the verified holder list.

The trust boundary to protect is **eligibility**: whatever decides a rider qualifies must read the
**verified** count, never the blended self-reported total.

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

## Identity layering — parent, POD key, feed key

The parent **is** the account identity. Both other keys derive beneath it, and the three do
different jobs:

| layer | key | job |
|---|---|---|
| Account identity | **parent** | who the user is. Signs only session authorisation and derivation ceremonies — never content |
| Credential holder | **ed25519 POD key** | named as `holder`; signs possession challenges |
| Storage | **derived feed key** (secp256k1) | signs the SOC carrying the statement |

Why the holder is not the parent, despite the parent being "the identity": a credential needs an
identifier that can **sign a challenge on demand**. The parent cannot — it never signs content by
rule, and for three of four login kinds it is a smart account whose address can never be recovered
from a signature. So the credential-level identifier sits one derivation down.

The ed25519 POD key is chosen over the feed key for **key-exposure containment**, not passport
aesthetics. The feed signer is a deliberately independent, LOW-stakes identity — "rotating or
leaking it never exposes POD, encryption, or funds" (`soc.ts:166-178`) — and it is escrowed in
the recovery/portability bundles and effectively unrotatable, since its address owns every feed
the user has. Naming it as the credential identity would raise its stakes and collapse the
separation that derivation domain deliberately built. The ed25519 key sits on the identity side
of that wall. That `ClaimedTicket.owner` already uses it — so tickets and credits share one
owner and the passport view coheres — is a benefit, not the reason.
The cost is one extra signature (`holderSig`), since the holder is not the feed owner — for likes
and follows, where author IS feed owner, no identity signature is needed at all (see "FROZEN AT
P0": stakes-driven tiering).

### The key-binding statement — one object, two problems

The POD key and the feed key are derived under separate domains and are cryptographically
independent, with **no public link between them**. That causes two separate problems already noted
elsewhere in this document: `holderSig` is required because nothing binds the named holder to the
feed that carries the statement, and a from-scratch rebuilder cannot map a holder to their feed
owner in order to find their statements at all.

Both dissolve with a **key-binding statement**: one signed object declaring that a given parent,
POD key and feed key belong to the same person.

**NOT frozen at P0 — deliberately.** The concept is settled; the contents are not: the parent
leg (named-only vs platform-attested vs ERC-1271, given three of four login kinds are smart
accounts whose address is unrecoverable from a signature), the mutual-signature shape between
the two derived keys, the placement/enumeration carrier, and its equivocation rule are all
unspecified. Freezing a guess would be worse than freezing late — the binding is the one object
every other key links through. Design it before P1: the indexer needs it to discover public
riders' feeds.

Two rules ARE fixed now:

- **Publish lazily, at the first public act — never per account.** "Published once per account"
  was a privacy regression: `ClaimedTicket.owner` is the same ed25519 key, so an
  account-creation binding would link every user's event-attendance identity to their account
  identity even if they never publish a credit — in a children's service. Private riders need
  no public mapping; public riders are exactly the set the indexer must discover. Lazy
  publication serves both.
- **The binding must be extensible to additional keys.** It is the designated carrier for any
  future key the identity grows — in particular a post-quantum holder key (see "Post-quantum
  posture"). Do not design it as exactly-three-keys-forever.

It makes the parent usable as the public identity — which is what a user expects — while keeping
signing where it belongs.

### Post-quantum posture — DECIDED 2026-08-14

Prompted by the EF dropping Poseidon for L1 (2026-08-13, SHA/BLAKE for leanVM). **No impact
here, and `holder` stays ed25519.** Recorded so it is not re-litigated per headline:

- Poseidon is a SNARK-circuit hash, not a signature scheme. Zupass PODs use EdDSA-Poseidon so
  they are ZK-provable; WoCo's POD borrowed the name only — the stack is DAG-CBOR + keccak256 +
  OZ SimpleMerkleTree + ed25519 (`pod/canonical.ts`, `pod/merkle.ts`; zero Poseidon anywhere in
  the repo, verified by grep 2026-08-14). An EF hash decision touches nothing here.
- "SHA-2/BLAKE signs instead" is a category error — a hash has no secret. The real hash-BASED
  signature scheme, SLH-DSA (FIPS 205), signs at 7,856 B (128s) to 29,792 B (256s); lattice
  ML-DSA-44 (FIPS 204) is a 2,420 B signature + 1,312 B pubkey. A SOC payload caps at 4,096 B
  (`SOC_MAX_PAYLOAD_SIZE`), so every standardised PQ signature breaks the single-chunk
  statement (only the unfinalised, floating-point-hazardous FN-DSA/Falcon-512 at ~666 B would
  fit) — and none is needed for forgery resistance on any relevant horizon.
- Swapping ed25519 alone moves one of FOUR quantum-exposed keys: the secp256k1 parent (the
  Ethereum account itself), the secp256k1 feed signer (mandated by Swarm's SOC format —
  `SOC_SIGNATURE_SIZE = 65` is protocol, not ours), and X25519 all remain. The stack's PQ floor
  is Ethereum's and Swarm's own migrations.
- **The real PQ exposure is the encryption path, not signing** — the inversion the question
  missed. AES-256-GCM is fine (Grover leaves ~128-bit strength); the exposed half is the X25519
  ECDH, and sealed boxes on a public network are harvest-now-decrypt-later: a signature only
  needs to resist forgery while it matters and can be rotated before capable quantum machines
  exist, but a chunk sealed today cannot be un-harvested. For encrypted ride history of minors,
  that is the exposure that cannot be fixed later.

Recorded now so migration is never blocked, none of it v1 work:

- The closed-schema/format-version rule IS signature agility — `woco.credit.v2` can carry a
  different holder-key type without touching v1 history.
- The key-binding statement must be key-extensible (above); it is where a PQ holder key would
  bind to the same identity.
- The designated encryption outlet is a **hybrid KEM** (X25519 + ML-KEM-768, the TLS/Signal
  shape; ~1.1 KB ciphertext overhead per box — fits). `SealedBox` has no version discriminator
  today, so the hybrid box must introduce one. Until then, data minimisation inside sealed
  payloads is the real PQ defence — this plan already bans timestamps.
- The optional anchor doubles as pre-quantum provenance: a root anchored before ed25519 falls
  proves the statement set predates forgery becoming possible.

## PODs versus statements — the dividing line

**A POD is for what someone ELSE vouches for. A statement is for what you assert yourself.**

- "I follow this account" is entirely self-assertable, so the signed statement already *is* the
  credential. A POD would add an object without adding a guarantee. **Follows get no POD.**
- A coaster POD's *type* is issuer-signed — this is genuinely Rita, with this artwork, in this
  catalogue — even though under v1 the holding itself is self-asserted.

Apply this test before inventing any new POD: if the holder could simply assert it, it is a
statement.

## Engagement and market data — pull, not push

Published credits are public by construction, so a park can compute how many people have ridden
Rita over 1,000 times, seasonality, repeat-visit patterns — **real commercial insight with no
personal data involved at all**. Private credits stay invisible, so riders control what is
countable. That aggregate story needs no consent machinery and no PII.

**Contact is where the design should stay pull-shaped.** A statement carries a holder key, not an
email, so a park sees `0xabc… has 1,200 credits` and no way to reach them. Building that bridge
means a marketing list, and with a minor-heavy audience that is precisely where the children's-code
problems live.

The better pattern, which this architecture already supports: a park publishes an offer — "1,000+
credit holders get early access" — and riders **prove their count** to claim it. No PII changes
hands, no list to hold, no consent to manage. It is capability-based access doing commercial work,
and it is only possible because possession proof is built in.

Where a direct channel IS wanted, **a follow is the consent signal**: it is explicit, revocable,
and carries an addressable identity without an email. Transport for that is Waku — see
`docs/WAKU_DISCOVERY.md` and `SWARM_SOCIAL_PLAN` P3 — so messaging can exist without any server
holding contact details.

## Going on-chain later — a MAYBE, not a plan

Recorded only so the option is known to be open. **Nothing here is proposed, scheduled, or
assumed.** Credits are off-chain and the reasoning for that is above; this note exists so nobody
concludes the door was shut.

If it ever became worthwhile, three properties already make migration cheap — none of them chosen
for that reason:

- **`subject` is a bytes32.** Chain-native already; no identifier remapping.
- **Statements are canonically encoded with a deterministic digest.** Anchorable as-is.
- **`seq` gives an unambiguous latest.** So a well-defined state exists to snapshot, with no
  competing-version reconciliation.

The shape would be a **snapshot, not a replay**: take the index state at a block, anchor a Merkle
root, riders claim inclusion. Off-chain statements keep working as the write path; the chain
becomes a settlement layer underneath. Nothing is rewritten and no history is lost.

The one real obstacle is **ed25519** — EVM contracts cannot verify it natively and Arbitrum has no
precompile. Two existing routes through: a **Stylus** contract, where ed25519 verification in Rust
is cheap and where there is already precedent (`docs/STYLUS_AGGREGATOR.md`); or the **key-binding
statement** (see "Identity layering"), which links the ed25519 holder to a secp256k1 address so
plain Solidity can verify the secp256k1 side.

That is a third reason to build the key-binding statement at P0: it makes `holderSig` verifiable
by a third party, it fixes indexer discovery, and it is the bridge if this option is ever taken.
One small object, three problems.

Staying off-chain therefore costs no optionality, which is the opposite of the usual trade.

## The evidence ladder — ⚠️ NOT v1, DIRECTION ONLY

> **Scope warning.** v1 is option (c): **no vouching at all.** Nothing in this section is built
> for v1 — no exit tokens, no device keys, no allowlists, no cadence caps, no tier computation.
> The `exitTokens` field exists in the frozen schema but stays **empty**, purely so verification
> can arrive later without a format bump.
>
> This section is retained because the schema must accommodate it, and because the reasoning
> (especially the relay-window limits and the count-bounding rules) is expensive to re-derive.
> Read it as design intent, not as a build list.

### The ladder (when it eventually exists)

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
device keys**, signed by that issuer's own key and published on their own feed (see "What
handover does not yet cover" — not a shared platform feed). Rebuildable and public. The entire
meaning of the tier depends on it; it is not optional.

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

## FREEZE BLOCKERS — five items, from the second Fable review (2026-08-13)

Second independent review, 30/30 messages Fable-attested. It verified every Swarm claim in the
revision against source and found them all correct — the two earlier primitive errors are
genuinely fixed and no third exists. The field list survived adversarial reading.

**But the schema is NOT safe to freeze**, because a freeze today would freeze a payload without
its addressing. These five must close first. All are days, not weeks, and none disturbs any
decided item.

**1. The head-topic derivation is never specified.** The plan lists "the head topic" among
things to freeze and then never gives a topic string — not for the statement head, not for the
subject index. Everything addresses through it: `identifier = keccak256(topic)`
(`soc.ts:190-192`), `chunk address = keccak256(identifier || owner)` (`:85-89`). Freezing
`CreditStatementV1` without the topic scheme freezes the passenger, not the vehicle.

**2. Private topics must be SALTED — this is a real privacy hole, not a nicety.**

Plain version: sealing a letter but filing it in a public cabinet under a drawer labelled with
your name and the coaster's name. Anyone can see you have a Nemesis drawer and count how often
you refile it, without ever reading a letter.

Encryption protects the payload; it does nothing about **presence at a deterministically
computable address**. Worse, `apps/server/src/lib/swarm/soc-upload.ts:222-231` whitelists every
relayed SOC on the public gateway — verbatim, "so ANY device can read it directly from the
gateway" — and versions are contiguous, so **version count ≈ activity count** is readable too.

The only protection is that a rider's feed-owner address is not publicly linked to them. That
evaporates at the first opt-in: the published evidence manifest must point at the rider's actual
signed chunks (`SWARM_SOCIAL_PLAN.md:34-36`), revealing their feed owner — after which **every
private head topic they own becomes probeable**. Publish your Rita count, leak the cadence of
everything else. For a children's service that is precisely the routine-inference this plan bans
timestamps to prevent.

Fix, and it must be inside the freeze because it cannot be retrofitted once statements exist at
unsalted addresses: derive private topics from `HMAC(encryptionKey, subject)` rather than the
plain subject, migrating to the public derivation on opt-in. The per-holder subject index needs
the same treatment — it otherwise leaks everything the sealed statements hide, and the plan
never states its visibility at all.

Note **ACT does not solve this.** Confirmed against the Swarm API docs: `POST /soc/{owner}/{id}`
and `POST /feeds/{owner}/{topic}` do accept `swarm-act`, so ACT *is* available for SOCs — but it
encrypts the payload, not the address. Presence remains observable. ECIES-to-self also stays the
better choice for credits regardless: a grantee list of one buys nothing, and ACT adds a history
reference whose loss is permanent and irrecoverable, where an ECIES key re-derives from the POD
seed on any device.

**3. The `holderSig` digest is named but not written.** "Canonical CBOR, domain-separated" is a
description, not a spec. It must be written before the first signature exists.

**4. No closed-schema rule.** Because `holderSig` covers canonical DAG-CBOR of the whole object,
`woco.credit.v1` must be declared **closed** — any added field is `woco.credit.v2`. Deterministic
DAG-CBOR is unambiguous about absent optionals provided v1 specifies omitted-not-null. Say so.

**5. `seq` equivocation has no rule.** Two validly-signed statements at the same `seq` with
different totals — a device-sync bug, or deliberate — have no resolution, so two honest indexers
can disagree, breaking "rebuildable identically". Any deterministic tie-break works; pick one.
Same class as the holderSig-bytes-ascending rule for the 40-per-window cap (note that rule is
grindable by choosing keys — acceptable, but say so).

### Verdict on scope, with one carve-out

The verification stack is **not v1**. Devices, allowlists, witness batches and the issuer
registry are correctly deferrable, because the materials-in/tier-computed design makes them
addable without migrating a single statement.

**The carve-out:** the `session` block and the `exitTokens` hook **are v1 schema**. Since
`holderSig` covers a closed canonical object, they cannot be added later without a format bump —
and that is the one migration this plan cannot afford to need mid-park-conversation. The hook
exists in v1 as **opaque format-tagged strings** (`exitTokens?: string[]`, each
`"{formatId}:{base64url}"`), so the closed v1 schema pins the FIELD while the token format
inside the string stays independently versioned and genuinely can be pinned at P3 — with no
contradiction against "v1 is CLOSED". See closure 7.

Ship: tier 1, the hook, and a counter. Nothing more.

### Corrections to this document, also from that review

- **"Nothing is ever summed" overclaims.** True of the self-declared `total` only. The *verified*
  count — the number that eventually matters for gating — is necessarily a sum of deduped
  observations across the walked version history. Two aggregation rules exist; both must be named.
- **Badge eligibility is the actual trust boundary, and it is unpinned.** The gate never sees a
  count, but the badge *issuer* does when deciding who crossed 100. If that policy reads the
  blended `total`, a self-reported number becomes chain-anchored the moment the badge mints. The
  issuer must read the **verified** count, never `total`, and the per-badge evidence requirement
  belongs in the badge's own definition.
- **The identity bridge is real work.** Credits accrue to the ed25519 holder; on-chain slots are
  owned by wallet addresses. Badge claim must bind them — reuse the existing claim rail
  (`ClaimedTicket.owner` + server-verified parent) rather than inventing a second binding.
- **Rebuildability needs a named enumeration.** A from-scratch rebuilder cannot compute a single
  address without a public holder→feed-owner mapping. The evidence manifest or a public carrier
  is an acceptable answer — the same shape `SWARM_SOCIAL_PLAN` accepts — but it must be stated,
  and it is in direct tension with blocker 2 for private riders. The topic decision has to serve
  both.
- **Commitment 2 exception must be recorded.** `SWARM_SOCIAL_PLAN.md:29-31` says subjects are
  never keyed by WoCo-internal ids; a WoCo-minted ULID is exactly that. Defensible — a coaster is
  not a sovereign identity and aliases restore interop — but the exception and its reasoning must
  be written down rather than silently taken.
- **`prevSession` is derivable** from `(owner, base, version)` and is schema surface frozen
  forever for something a reader can compute. Consider dropping it. (Dropped in the freeze.)
- **Opt-in copy has a disclosure consequence.** `ClaimedTicket.owner` is the same ed25519 key, so
  publishing credits links a rider's coaster identity to their event-attendance identity. The
  consent wording must say so.
- **Pilot-day write load is unexamined.** In the P1 relay shape every statement transits
  `uploadSignedSoc` — one batch, 6-wide semaphore (`upload-queue.ts:19`), 423-per-bucket
  contention. 1,000 fans × 5 rides is ~5,000 relayed SOCs on the same VM serving stream-day
  reads. The plan flags the read spike, not the write one.
- **"History is free" is storage-only.** Reads are O(versions) sequential probes, and computing a
  verified count means walking every version, since tokens live in per-day session blocks. A
  109-lap tier-2 day is 109 versions. Amortisable with hints, but the index cache becomes
  semi-load-bearing.

### Contradictions to clean up — RESOLVED 2026-08-14

Both fixed in the current text: the security table reads the per-subject `cadenceMinutes`, and
witness leaves carry an `observationNonce` discriminator.

## The freeze blockers, closed (2026-08-13; closures 6–7 added at the freeze, 2026-08-14)

### 1. Topic derivation — one scheme, a salt that differs

```
PUBLIC_SALT = utf8("woco-credit-public-v1")            // a fixed, public constant
privateSalt = HMAC-SHA256(encryptionPrivKey, "woco-credit-topic-salt-v1")

salt        = published ? PUBLIC_SALT : privateSalt

statement topic = "woco/credit/v1/"       + hex(HMAC-SHA256(salt, subjectHex))
subject index   = "woco/credit/v1/index/" + hex(HMAC-SHA256(salt, "subject-index"))
```

`encryptionPrivKey` is the rider's X25519 key from `deriveEncryptionKeypairFromPodSeed`
(`packages/shared/src/crypto/keys.ts:71`) — deterministic, regenerable on any device, never
transmitted.

Pinned encodings — the freeze exists to kill exactly this class of ambiguity: the HMAC message
for a statement topic is the **raw 32 subject bytes**, never hex text; for the index it is
`utf8("subject-index")`; the topic suffix is lowercase hex, no 0x.
`statement/discipline.ts` is normative.

**This closes the presence leak to PUBLIC observers — and only to them.** The review's attack
was: opting in reveals your feed-owner address, after which every private head topic becomes
probeable. With a salted private topic, knowing the feed owner is *not enough* — an observer
also needs the salt, which derives from a key only the rider holds. So publishing one coaster
never exposes the ADDRESSES of the others. Two honest limits: the relay still sees
(authenticated parent, SOC owner, upload time) and whitelists every relayed SOC address on the
public gateway (`soc-upload.ts:222-231`) — the platform is not inside this protection. And
"exposes nothing retroactively" is address-true but content-false: the first public statement
carries the lifetime `total` and the current `seq`, disclosing prior private magnitude and
prior write count. The opt-in consent copy must say both.

Opt-in is a republish at the public topic — a one-way migration, not a fork (closure 6). `seq`
continues across it; versions at the new topic restart at 0. Prior private versions stay where
they were: encrypted, at addresses nobody else can compute.

The subject index gets the same treatment, which the earlier revision never specified at all —
unsalted it would have leaked exactly what the sealed statements hide. **Partition rule:** a
subject lives in exactly ONE of the two indexes — the private index (private salt) before
opt-in, the public index (public salt) after — and opt-in moves it. The index is therefore not
just discovery hygiene: it is how a fresh device learns which head is live for each subject.

### 2. `holderSig` digest — written down

```
signedBytes = utf8("woco-credit-v1\n") || dagCbor(statement without holderSig)
digest      = keccak256(signedBytes)
holderSig   = ed25519.sign(digest, holderPrivKey)
```

Encoder is the LOCKED `packages/shared/src/pod/canonical.ts`. The explicit domain prefix, rather
than relying on the `format` field alone, mirrors the cross-protocol argument in
`apps/server/src/lib/ticket/owner-binding.ts:8-10`: a signature over these bytes cannot collide
with the same key's POD-manifest signatures — the same account's ed25519 key signs manifests
when they create events — because a manifest digest is `keccak256(dagCbor(body))` with no
prefix, and the digest PREIMAGES can never be equal: a canonical manifest encodes as a CBOR map
(first byte 0xa0–0xbb), while these bytes start `0x77` ("w").

Absent optional fields are **omitted, never null**.

Two rules join the freeze with this:

- **The holder key never signs an externally supplied digest.** Every protocol wanting a holder
  signature — statements, possession challenges, anything later — hands structured bytes to a
  signer that hashes them under its own registry prefix. A signer accepting a raw 32-byte
  "challenge" would sign anything, including another protocol's digest.
- **A prefix registry.** Signing prefixes are `"woco-{type}-v{n}\n"`, type names `[a-z0-9-]+`
  (no newline can occur; the trailing `-v{n}\n` parse is unambiguous). The registry lives in
  `statement/discipline.ts`; a new identity-signed type claims its prefix there or does not
  sign. Note the deliberate distinction: `format` ids are dotted (`woco.credit.v1`), signing
  prefixes hyphenated with a trailing newline — they can never be confused for one another.

### 3. `sessionDate` is UTC in the signed object

The signed object carries UTC. Park-local display is a view-layer concern resolved through the
subject registry.

Rejected: park-local in the payload. The registry is mutable, so a later timezone correction would
retroactively reinterpret already-signed statements — a signed field must not depend on mutable
external state. Rejected too: carrying a UTC offset per statement, which adds permanent schema
surface to solve a display problem.

Consequence to accept, stated accurately: the split is at UTC midnight, not local midnight — at
a UTC-8 park EVERY day splits mid-afternoon, not just sessions running past local midnight.
Display recombines through the registry timezone; the signed record stays unambiguous forever.

### 4. `woco.credit.v1` is CLOSED

Because `holderSig` covers canonical DAG-CBOR of the whole object, **any added field is
`woco.credit.v2`.** No exceptions, including "harmless" optional additions.

Indexers must reject unknown fields rather than ignore them, so a v2 object can never be silently
misread as a v1 one. This is why the `session` block and the `exitTokens` hook must exist in v1
even while empty — see the scope carve-out.

Strict validation means the **exact field set at every nesting level** — the `session` block is
as closed as the top level. And **format dispatch happens before strict validation**: a reader
reads `format` first, then applies that format's validator, so a v2 object fails v1 validation
whole instead of half-parsing.

### 5. `seq` equivocation — lower digest wins

Two validly-signed statements at the same `(holder, subject, seq)`:

- **Lower canonical digest wins.** Deterministic, so two honest indexers always agree, and no data
  is lost — which rejecting both would risk on an ordinary device-sync bug.
- The indexer **flags** the equivocation rather than hiding it. Repeated equivocation by one holder
  is a signal worth surfacing.

Grindability is acceptable here: a rider could craft two statements and pick which wins, but at
tier 1 they already control their own count, so it buys nothing. The same reasoning applies to the
holderSig-bytes-ascending rule for the per-window cap.

Three clarifications frozen with it:

- Comparison is lexicographic over the **32 raw digest bytes** (equivalently the lowercase hex).
- Agreement is a deterministic function of the INGESTED set. No tie-break can canonicalise the
  input set — two indexers that saw different statements still differ — which is what the
  evidence manifest is for: it makes two indexers' inputs comparable, so a dispute reduces to
  "show me your set".
- A same-version race on ONE feed cannot equivocate at all: a SOC is immutable, so the first
  write at a version wins and the second is silently discarded (201 returned, old payload
  kept). The consequence is a client rule, not an indexer rule — **read back after write**,
  because a "successful" write may not be what landed.

### 6. One live head per (holder, subject) — opt-in retires the private head (2026-08-14)

A salt change is a topic change: the public head is a NEW feed whose versions restart at 0
while `seq` continues. If a client kept writing the private head after opting in, one
(holder, subject) would have two live heads, the same `seq` could appear twice with different
totals, and closure 5's tie-break would resolve the rider's own history arbitrarily. So:
**opt-in is a one-way migration, not a fork.** The client stops writing the private head; the
subject moves between index partitions (closure 1); no tombstone machinery is needed.

Two honest limits, found implementing this (2026-08-14) and recorded so the paragraph above is
not read as stronger than it is. Publishing re-signs at `P+1`, so a device that missed the
opt-in and writes its next private statement **ties** at `P+1` rather than losing outright — it
resolves by closure 5's digest tie-break and is flagged as an equivocation, not by "the ordinary
seq rule", which an earlier version of this paragraph claimed. There is no seq the public head
could start at that strictly beats a stale device's next write, so this is the best achievable
rather than a gap to close. And rides recorded on such a stale private fork are **never migrated
into the public total** — the public head carries the total as of the moment of publication.
Both are acceptable pre-launch and neither is a schema question; a client that reads its own
index before writing (which is the rule) does not reach either state.

### 7. Statements are JSON on the wire — the schema is JSON-safe (2026-08-14)

`assembleContentFeed` JSON-parses the base payload to detect the multi-chunk manifest
(`soc.ts:457-463`); a non-JSON payload silently falls through as single-chunk with NO paging
path. So the wire format is JSON, and every frozen schema must survive a JSON round-trip into
the same canonical object: strings, booleans, safe integers, arrays, objects — no CBOR byte
strings, no floats, no null (absent = omitted, closure 2). `holderSig` still covers DAG-CBOR of
the parsed object — dag-cbor sorts map keys, so JSON key order cannot change the digest. The
closed schema also guarantees a statement can never collide with the paging manifest's
`_woco_mc` marker key.

This is what settles `exitTokens` as format-tagged STRINGS rather than a pinned `ExitTokenV1`
struct (which would freeze a format not built for a year inside an object that can never
change) or opaque bytes (which break paging). It also falsified the earlier "~30KB of tokens
works because the multi-chunk path exists" note as written — true again for base64url strings
at ~400 B per token (~40 KB for a 100-lap tier-2 day, well inside the 256-page cap).

## FROZEN AT P0 (2026-08-14) — the shared discipline and the v1 payloads

Code is normative: `packages/shared/src/statement/discipline.ts` (shared discipline),
`packages/shared/src/credit/` (credit payloads), `packages/shared/src/social/` (like/follow
payloads — chain-free; deliberately NOT an extension of the superseded EAS `likes/` module).
Changing any frozen item is a format bump, never an edit.

What is frozen is a **DISCIPLINE plus per-type payloads, not a shared envelope**.
`CreditStatementV1` is not the envelope other types ride: likes and follows need none of
`holder`/`holderSig`/`seq`, because there the author IS the feed owner — the SOC signature
already binds authorship and the SOC version sequence already orders. The principle is
**stakes-driven tiering**: low-stakes statements ride the storage key alone; gate-feeding
credentials carry an identity signature.

**The shared discipline** (every statement type rides all of it):

1. Signing-prefix registry — `"woco-{type}-v{n}\n"`; the holder key never signs an externally
   supplied digest (closure 2).
2. Digest recipe — `keccak256(prefix || dagCbor(object minus its sig field))`, encoder locked
   to `pod/canonical.ts`.
3. Closed schemas, JSON-safe wire form, omitted-not-null, dispatch-before-validation
   (closures 4 and 7).
4. Topic scheme — `"woco/{type}/v{n}/" + hex(HMAC-SHA256(salt, subject bytes))`, `salt` a
   parameter: public types pin `utf8("woco-{type}-public-v{n}")`; the private salt is
   `HMAC(encryptionPrivKey, "woco-{type}-topic-salt-v{n}")` (closure 1).
5. Per-holder subject index per type, same salt treatment, partition rule (closure 1); one
   live head per (holder, subject) (closure 6).
6. Ordering — SOC versions where author = feed owner; signed `seq` where they differ;
   lower-digest tie-break; read-back-after-write (closure 5).
7. Evidence-manifest REQUIREMENT (its form is deliberately NOT frozen — view plane, freely
   versionable): the published index lists the ingested statement digests AND the
   per-statement values used, because "count = list length" does not hold for carried totals.

**Per-type payloads:**

- `woco.credit.v1` — `{ format, subject, holder, seq, total, session { date, count,
  exitTokens?: string[] }, holderSig }`. CLOSED. `prevSession` is DROPPED from the earlier
  draft: it is derivable from `(owner, base, version)` — SOC versions ARE the history — and
  schema surface frozen forever for a computable value is pure liability.
- `woco.credit-index.v1` — `{ format, subjects[] }`, storage-key-signed only. Deliberately
  low-stakes: a forged index can only hide subjects or point at statements whose `holderSig`
  will not verify.
- `woco.like.v1` / `woco.follow.v1` — `{ format, subject, value }`. Latest SOC version wins;
  `value: false` is the overwrite that "unlike/unfollow = overwrite" (SWARM_SOCIAL_PLAN
  commitment 3) requires, since absence cannot be distinguished from never-liked.

**Deliberately NOT frozen, with reasons:** the key-binding statement (see Identity layering —
two rules fixed, contents open, design before P1); the exit-token format inside the strings
(P3, independently versioned); the evidence-manifest type (view plane); witness batches (P4);
subject-bytes32 derivation for social subjects (#172's build — the profile namehash in
`likes/subject.ts` is identity-level, survives the EAS retirement, and remains the intended
derivation).

## Data structures

Code lives in `packages/shared/src/{statement,credit,social}/`. Reuses the LOCKED primitives in
`packages/shared/src/pod/{canonical,merkle}.ts` — same encoder, same tree scheme. Do not
fork them.

### Rider statement — one CURRENT object per (holder, subject)

One head topic per `(holder, subject)`, carrying the **lifetime total** plus the current
day's block. Proof of a lifetime total is one chunk, which is what the counter, the widget
and the passport view all actually want.

```ts
interface CreditStatementV1 {
  format: "woco.credit.v1";
  /** keccak256("woco:coaster:v1:" + stableId), 0x-prefixed lowercase. See "Subject identity". */
  subject: Hex0x;
  /** The rider's ed25519 POD public key (hex, no 0x) — the owner-of-record, as
   *  `ClaimedTicket.owner`. */
  holder: string;
  /** Monotonic per (holder, subject). THE ordering authority — latest = highest seq.
   *  Not derivable from anything else; see "Ordering". Continues across the
   *  private→public migration (closures 1 and 6). */
  seq: number;
  /** Lifetime rides for this subject. Cumulative — carried, never a delta, never summed. */
  total: number;
  /** The current day's block. Older days are recovered by walking SOC versions. */
  session: {
    date: string;        // UTC calendar date, YYYY-MM-DD (closure 3)
    count: number;
    /** Evidence MATERIALS only — opaque "{formatId}:{base64url}" strings (closure 7).
     *  The tier is computed, never declared. Empty or absent at v1. */
    exitTokens?: string[];
  };
  /** ed25519 signature by `holder` (hex, no 0x) over the closure-2 digest. See "holderSig". */
  holderSig: string;
}
```

**No `prevSession`.** The earlier draft carried the previous version's Swarm ref as an optional
skip-list. Dropped in the freeze: it is derivable from `(owner, base, version)` — SOC versions
ARE the history — and it would have been frozen surface a reader can compute, plus a
consistency question (what if it disagrees with the actual previous version?) for free.

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

### Aggregation — the self-declared total is carried, never summed

A rider's self-declared total for a subject is `total` from the highest-`seq` statement. Full
stop. No summation across writes, so the "8 taps read as 36 rides" trap cannot occur by
construction. Their total across coasters is the sum over subjects, one head each.

The VERIFIED count — the number gating eventually reads — is the OTHER aggregation rule, and it
IS a sum: deduped observations (token nonces / witness leaves) across the walked version
history. Two rules, both named; conflating them is how a self-reported number would leak into a
gate.

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

### Exit token — issued by a device, embedded by the rider as an opaque string

At v1 the hook is frozen as `exitTokens?: string[]`, each `"{formatId}:{base64url}"` (base64url
unpadded). The statement schema pins the FIELD; the token format pins itself at P3 under its
own version (closure 7). The intended P3 content, recorded as direction and NOT frozen:
`subject`, `deviceKey` (the exit device's signing address), `windowStart` (ISO, ~30s
granularity), `nonce`, and the device's signature over those.

The device signs locally and needs no network — it can run all day offline at a ride exit. The
rider's `holderSig` covers the embedded strings verbatim, so the rider commits to exactly the
tokens they presented; the device's own signature lives inside the blob.

### Issuer witness batch — tier 3 only

The issuer collects PER-OBSERVATION leaves it witnessed — `(holder, subject, sessionDate, observationNonce)`, never one tuple per session, or a single observation would validate a session claiming any count, builds a Merkle
tree, and ed25519-signs ONE manifest over the batch — same envelope shape as
`ManifestV1Body`, with `prevBatch` chaining so an indexer can walk issuer history and
omission is detectable. One signature and one upload per batch, regardless of size.

A witness **references** rider statements; it never replaces or authors them.

## Subject identity

```
subject = keccak256("woco:coaster:v1:" + <WoCo-minted ULID>)
```

The id is **ours and opaque**. External ids — RCDB, Captain Coaster, a park's own — are
recorded as **aliases in the subject registry**, never as the hash input.

### Why not hash an RCDB id directly

An earlier revision did exactly that. Two problems, and the second is the one that bites:

**Shutdown is the smaller risk.** The id is only an input to a hash; once hashed, a subject is
a bytes32 that needs nothing external. Every existing statement, count and index would keep
working if RCDB vanished. What would break is minting NEW subjects and cross-app interop —
real, but survivable.

**Instability is the real risk, and it is live now.** RCDB id semantics under relocation and
re-tracking are unverified. If a coaster moves parks or is re-tracked and its id changes, a
subject hash derived from it is orphaned — and subject hashes are permanent. That exposure
exists whether or not RCDB ever goes away.

An opaque WoCo id removes both. Aliases stay mutable metadata; identity stays immutable and
ours. Interop is preserved through the alias — import and export by RCDB id still work, and a
park taking over issuing attests about the same subject hash and adds their canonical id as
another alias. The hash itself needs no migration — but see "What handover does not yet
cover", because naming and authorisation are a different matter.

The honest tradeoff: an opaque id means the registry is required for a hash to mean anything
to a human. That is not a new dependency — the registry is needed regardless.

### A subject registry, NOT `PodDirectoryEntry`

An earlier revision said to add `subject` to `PodDirectoryEntry`. That is shape-forcing and is
now rejected. That entry's identity is a `manifestRef`, "the on-chain/manifest commitment",
with **required** `manifestRef`, `kind`, `name` and `supply`
(`packages/shared/src/pod/types.ts`). A coaster subject has no manifest, no supply and no
editions — this design's own premise is that nothing is minted. Adding `subject` there would
mean minting a meaningless manifest per coaster or leaving required fields as fiction.

Instead: a **subject definition**, published as a signed statement (see "What handover does
not yet cover" — this is deliberately not a single platform-owned feed):

```ts
subject → {
  name: string;          // "Rita"
  park: string;          // "Alton Towers"
  timezone: string;      // DISPLAY-ONLY: how views localise the UTC sessionDate (closure 3)
  cadenceMinutes: number;// per-subject, NOT a global constant — see Caps
  aliases?: { rcdb?: string; captainCoaster?: string; park?: string };
}
```

It makes the hash invertible for UI and indexer alike, which nothing else in the design
provides, and it is where a subject's timezone and ride cadence are declared.

PODs re-enter where the type system already invites them: `PodKind: "badge"` is literally
"loyalty/achievement, issued at a milestone. Soulbound". Three shapes, all off-chain signed
credentials:

- **Coaster POD** — issued on FIRST ride. This is the credit in the community's sense, and it is
  what carries the lap count.
- **Milestone POD** — at rare thresholds only. Forty coasters times four tiers is 160 objects
  cluttering a passport and cheapening each; scarcity is the point.
- **Commemorative POD** — event-scoped participation, no threshold. This is Dan's, because a lap
  target that moves with fundraising cannot be a threshold.

### What handover does not yet cover

The claim that a park can "take over issuing" is only partly true as designed, and the gap is
worth stating plainly rather than discovering during a park conversation.

**Genuinely portable today:**

| | why |
|---|---|
| The subject hash | keccak over a string — no key involved, anyone can compute it |
| Rider statements | rider's own feed, rider's own key |
| Issuer witness batches | signed by whoever the issuer is; a park signs its own |
| The index | rebuildable from public data by anyone |

**Not portable, as an earlier revision wrote it:** the subject definition and the device-key
allowlist were both put on "a platform feed". `SWARM_SOCIAL_PLAN:12` is explicit that "Swarm
feeds have exactly one owner-signer, so shared state is impossible" — so those two would be
WoCo's permanently. A park could sign witness batches, and nobody would be obliged to believe
them, because *authorised* would be defined by our file. That is not handover.

**The fix is the pattern this architecture already uses.** Do not create shared state; publish
per-issuer signed statements and resolve at the view layer:

- Each issuer publishes its own **subject definition** on its own feed, signed by its issuer key.
- Each issuer publishes its own **device-key allowlist**, likewise.
- The indexer resolves conflicts by a stated policy: prefer the issuer that the **on-chain
  issuer registry** names as authorised for that subject.

The on-chain issuer registry is therefore what turns "authorised" from our opinion into an
objective fact. It can remain deferred — v1 works with WoCo as the sole issuer — but until it
ships, the honest statement is "WoCo is the naming and authorisation authority", not "parks can
take over". Prefer-WoCo is a documented v1 limitation with a defined end, not a design.

Note this touches only the registry and authorisation layer, which is disposable machinery.
`CreditStatementV1` is unaffected, so it does not block the schema freeze.

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

⚠️ **OWNER DECISION, not taken here:** this paragraph still promises Dan's exit device and
rotating tokens in September, while the scope section ships "tier 1, the hook, and a counter.
Nothing more." That changes what is promised to a partner — settle it before the approach, not
in this doc.

Do not claim the system proves Dan physically rode 109 times. It proves he and his team
attested to it — **signed and publicly recountable**, not "tamper-evident": the issuer can
always supersede their own history at a higher `seq`, and nothing timestamps a write, so a
version history could be fabricated after the fact. Nobody expects a self-attested counter to
be tamper-evident against the attester, and tier 1 explicitly does not prove anyone rode.
Running the on-chain anchor for the pilot was considered and REJECTED: it would service one
adverb of copy while putting a chain dependency into the one design whose headline is that
nothing touches a chain — and on a stream day the audience watching the counter live is better
liveness evidence than a notary. The anchor stays documented as an upgrade (it is also the
pre-quantum provenance mechanism — see "Post-quantum posture"). Overclaiming to an audience
that will test it on camera is the one unforced error available here.

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

### The verification page — BUILT 2026-08-16

`apps/web/verify.html` → `src/VerifyApp.svelte`, its own entry in the main build (no app
shell, no auth, no router), reachable at `/verify.html?subject=…`. Fable-consulted before
building; the findings below are its.

Two claims, made in this order and kept apart:

1. **Recounted here.** It fetches `/api/social/manifest` ONLY and adds the leaves up in the
   browser. `/count` is not fetched: both are served from the same 30s cache entry, so
   comparing them cannot detect dishonesty and *can* manufacture a false mismatch across a
   cache boundary. `/manifest` therefore now carries `unreadable` and `equivocations` too —
   a reader who needs a second request to learn whether a count is complete will publish a
   floor as a total. Note `/manifest` already recounts server-side and 500s rather than
   serve an inconsistent manifest, so a browser recount cannot catch THIS server lying; it
   catches a corrupted intermediary or a third-party manifest. Copy says "recounted", never
   "verified".
2. **One entry read for itself.** `lib/credits/spot-check.ts` derives the chunk address from
   the leaf by the public scheme, fetches it from the storage gateway, and checks the
   rider's `holderSig` and the digest. One entry only — fanning out over every leaf would
   read as auditing fans' counts. Silence NEVER accuses: 404/403/timeout are "not checked".
   Verified live 2026-08-16: gateway `/chunks/*` sends `access-control-allow-origin: *`, and
   an unlisted address answers 403 "not whitelisted" (a routine answer, not a fault).

`CarriedEvidenceLeaf` gained `version` to make (2) possible: it carried `seq`, which is the
HOLDER's ordering and continues across the private→public migration, while the version is
the FEED's and restarts at 0 — so the ADDRESSING NOTE in `indexer.ts` was true of boolean
leaves and false of credit ones. Legal because the manifest form is deliberately unfrozen
(P0 item 7, view plane).

**Reports are now PUBLISHED, and the page falls back to them — 2026-08-17 (#312).** The
counter writes each subject's evidence to a feed it owns at an address derived from the
subject (`SWARM_SOCIAL_PLAN` P1.5). When `/api/social/manifest` cannot be reached, the page
reads that instead — same evidence, same recount, same spot-check — and SAYS SO: the footer
names the counter as unreachable and the "check it yourself" step gives the feed owner and
topic rather than a link to a counter that just failed. A published copy is signed evidence,
not a cache, but it is only as current as the last change to the count, so the page must
never present it as the counter answering now. If both the counter and its published copy
are silent, the COUNTER's error is what surfaces — the fallback going quiet is not the thing
a reader can act on.

Two refusals: a subject that resolves to no coaster in `WOCO_SUBJECTS` gets a neutral state,
because anyone can mint a subject id and publish genuinely signed entries against it and a
crafted link would otherwise borrow this page's authority for an invented coaster; and there
is no `?indexer=`/`?api=` override — the honest form of "run your own" is a fork on your own
domain, not a query string on a page that exists to be screenshotted.

⚠️ **OPEN, OWNER DECISION — the headline is community-scoped, not Dan's.** `manifest.count`
SUMS every rider's total for the subject, so the moment a second rider publishes a Rita
count, a page headlining it stops meaning "one rider's laps" while looking identical.
"Verify all 109 laps" is holder-scoped. The featured-rider mechanism ships and its registry
(`FEATURED_HOLDERS` in `verify-report.ts`) is EMPTY, because nothing publishes Dan's holder
key. Filling it needs his team to publish that key — and the key→person link is an
announcement, not mathematics, so the copy must say "the identity Dan's team published",
never "signed by Dan".

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
| Sharing a live exit QR within its window | **Not solved.** Structural to a displayed code. Bounded by `MAX_STATEMENTS_PER_TOKEN_WINDOW = 40` + the per-subject `cadenceMinutes` from the subject registry. Tier 2 claims the token was present, not the rider. |
| Inflating a self-reported count | Nothing, by design. That is what the COMPUTED `self` tier means (there is no `evidence` field to declare). |
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

**Freeze in `packages/shared` before any code** (DONE 2026-08-14 — "FROZEN AT P0"):
`CreditStatementV1` with `seq`, the head topic, computed evidence, the domain-separated
`holderSig` digest, and the identity decision below. Do not defer any schema question — that
is the one category that cannot be revisited.

**Ship the pilot minimally:** hardcoded subject, published allowlist of the issuer's device
keys, a single-subject counter endpoint, the embed widget and the stream overlay. None of the
pilot's deliverables needs a general indexer.

**Defer:** the general indexer (merge with #172), witness batches if the device app slips
(the rider's own statements plus the device's tokens still carry the story), the issuer
registry, self-report import, NFC.

## Phasing

- **P0** — subject identity + subject registry + **frozen statement schema**. The only
  irreversible step. **DONE 2026-08-14** — see "FROZEN AT P0". The registry SHAPE is recorded
  above; publishing registries is P1 machinery (disposable, not signed-forever).
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

So: **ask once — but never in the tap flow.** The first credit writes private with NO decision
attached; the ask happens at the first calm view of the collection afterwards, private
pre-selected, neutral wording, no nudge patterns. An active choice is a stronger
children's-code posture than a silent default, needs no age question, and puts the public count
one tap away — while a keepsake never requires a publication decision from a child standing in
a queue. (The earlier "ask at the first credit" wording contradicted exactly that sentence.)

Pilot: Dan publishes — a public counter is the point. Fans default to a private keepsake and
opt in to appear on the leaderboard.

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

Where a rider genuinely wants their own times, the designated future outlet is a **sealed
private sidecar** — ECIES-to-self, never inside the public statement, explicitly NOT v1.
Recorded so "add timestamps back" has a landing place that is not the signed public object.

Consequence for record claims — "most laps in a day" and similar: those must require tier 2 or
3. A record is never creditable from self-reported data, whatever times it carries.

### Still open

- RCDB id semantics under relocation/re-tracking — still worth verifying before relying on
  the alias for import matching, though subject identity no longer depends on it.
- Statement size at tier 2 grows with the day — ~400 bytes per base64url token string, so a
  100-lap tier-2 day is ~40KB re-uploaded on every tap. The multi-chunk path handles it (JSON
  wire form, closure 7; up to 256 pages), but the cost is quadratic in rides; consider
  chunking token lists by reference once large.
- The attendee gate: profile creation is gated on ticket possession, and pilot fans have no
  WoCo tickets, so the credits write path must be deliberately ungated — which reopens
  free-account statement spam stamped on our postage batch. Needs a rate limit on the relay.
- Postage: both current batches expire before any September pilot. Mandatory infra work before
  a date is promised.
