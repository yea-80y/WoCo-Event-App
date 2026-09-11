# The Swarm data model

How WoCo stores data without a database: what a chunk is, how an address is computed, how a
mutable feed is built out of immutable chunks, and how topics are derived.

**Verified against `main` on 2026-09-08.** The normative files are
`packages/shared/src/swarm/soc.ts` and `packages/shared/src/statement/discipline.ts`. Anything
signed and addressed under these rules lives forever at a computed address, so **changing a
constant or a derivation here is a format bump, never an edit.**

---

## 1. Chunks

Swarm's storage unit is a chunk with a payload of at most **4096 bytes**. Two kinds matter here.

A **content-addressed chunk (CAC)** is addressed by its own content:

```
span        = uint64 little-endian payload length, 8 bytes
bmtRoot     = binary Merkle tree over the payload zero-padded to 4096 bytes:
              128 segments of 32 bytes, reduced pairwise with keccak256
cacAddress  = keccak256( span || bmtRoot )
```

A **single-owner chunk (SOC)** is addressed by *who* wrote it and *which slot* they wrote it in:

```
socAddress  = keccak256( identifier(32) || owner(20) )
signedOver  = identifier || cacAddress          ← the owner personal_signs this
stored as   = identifier(32) || signature(65) || span(8) || payload(1..4096)
```

That is the whole basis of "the user owns their data". `owner` is an Ethereum address, so the
chunk's address falls inside an address space only the holder of that private key can write to,
and **the signature travels with the chunk**. Anything that mirrors a chunk must carry the raw
chunk bytes, never re-serialised JSON, or the signature is lost.

Both ends of the system compute these byte-identically. The server must independently re-derive
the CAC address from the submitted span and payload before it will stamp anything — otherwise it
could be tricked into paying for a chunk whose signature recovers to a different owner. The
algorithm therefore lives in `packages/shared`, implemented with keccak only, so the shared
package needs no Bee SDK dependency.

---

## 2. A SOC is immutable — so how is a feed mutable?

It is not, and this cost real time to discover: **re-uploading at the same `(owner, identifier)`
with new bytes is silently discarded.** Bee dedupes by chunk address, returns `201`, and keeps
the *old* payload. A fixed-identifier feed only ever landed its first write; every subsequent
edit vanished with no error.

Mutability on Swarm means writing update *N* at a **new identifier** and resolving "latest":

```
base identifier      = keccak256( utf8(topic) )
version  identifier  = keccak256( base || uint64BE(version) )
page     identifier  = keccak256( base || uint64BE(version) || uint64BE(page) )
```

Two deliberate properties:

- The **version is folded into the identifier**, so a reader of version *n* can never see version
  *n+1*'s pages. There is no torn read across a concurrent update.
- The version identifier is **byte-identical to bee-js's own feed-update identifier**. A
  versioned content feed *is* a bee sequence feed whose topic is the content topic — which is
  what lets Bee's own feed machinery resolve it where that is needed (the per-site pointer feed
  that ENS contenthash points at), while every other read goes by computed chunk address.

The 48-byte page input (versus the base's 40) also guarantees a page identifier can never
collide with a version identifier.

### Reading: forward probe from a hint

Readers probe forward from a cached lower bound (`localStorage`, key
`woco:cfv:{owner}:{topic}`), two versions at a time (`VERSION_PROBE_WINDOW = 2`), and stop at
the first gap. The hint is monotonic and versions are immutable, so a stale-low or absent hint
costs a few extra reads and never affects correctness.

The window is 2 for a specific reason: **a probe past the latest version is a network-wide search
for a chunk that does not exist** — the most expensive read on Swarm. A window of 8 melted the
node. And there is a matching cautionary tale about the hint itself: the write side derived its
owner `0x`-prefixed while the read side stripped the prefix, so the two never saw each other's
hint and every operation restarted the scan from zero. Nothing broke; it was just slow, which is
why `hintKey` is now normalised for both case and prefix, and why a test asserts the derivation
directly.

### Writing past 4096 bytes: multi-chunk paging

A feed that fits one chunk stores its raw JSON in the base SOC. A larger one pages:

```
base SOC   { "_woco_mc": 1, "pages": N, "len": <total bytes> }
data       {topic}/p1 … {topic}/pN
```

**Data pages upload before the manifest**, so a reader never sees a manifest whose pages are not
there yet. The `_woco_mc` marker is a discriminator, and every frozen statement schema is closed
partly to guarantee no real payload can ever carry that key.

Statements travel as JSON because `assembleContentFeed` JSON-parses the base payload to detect
the manifest — a non-JSON payload has no paging path at all. That is why the frozen schemas ban
floats and `null`: a whole-number float loses its floatness across a JSON round trip and would
change the CBOR encoding under a signature. Absent means **omitted**.

---

## 3. Topic derivation

There are two topic schemes, for two different classes of data.

### Path-shaped topics, for platform and content feeds

```
woco/event/directory                 global listing (platform-signed pointer)
woco/event/{eventId}                 event details + ticket series
woco/event/creator/{address}[/pN]    per-organiser index (never deleted from)
woco/profile/data/{address}          profile
woco/profile/avatar/{address}        avatar ref — a separate feed so it updates independently
woco/issuer/{parentAddress}          issuer-registry statement log (parent-signed)
woco/recovery/{kernelAddress}        recovery escrow envelope
woco/site/config/{siteId}            site JSON, or a platform-signed POINTER to a
                                     client-owned Site chunk (see SITE_BUILDER.md)
woco/site/{siteId}/events            site events index
woco-multisite-{siteId}              per-site pointer → latest content hash (for ENS)
woco/object/collection/{address}     a user's collection
```

Topic components are restricted to `[0-9a-z-]{1,64}`, and this is a **collision guard, not input
hygiene**. Topics are path-shaped and a paged one ends in `/p{N}` — so a component containing
`/` reaches across that separator: series `abc/p1` at page 0 builds the same string as series
`abc` at page 1, and one series' page 0 *is* another's page 1. Restricting the charset makes the
collision unrepresentable rather than unlikely. Lowercase-only for the same reason: two byte
forms of one logical id would address two feeds a reader sees as one name.

A series id arriving in a signed manifest is **rejected, never sanitised** — rewriting it would
invalidate the signature that commits to it.

### HMAC topics, for statements

Likes, follows, credits and future forum types share a **frozen statement discipline**
(`packages/shared/src/statement/discipline.ts`):

```
statementTopic = "woco/{type}/v{n}/" + hex( HMAC-SHA256( salt, subject(32) || uint64BE(band) ) )
indexTopic     = "woco/{type}/v{n}/index/" + hex( HMAC-SHA256( salt, utf8("subject-index") || uint64BE(band) ) )

public  salt   = utf8("woco-{type}-public-v{n}")
private salt   = HMAC-SHA256( encryptionPrivKey, utf8("woco-{type}-topic-salt-v{n}") )
```

Every encoding here is pinned because the freeze exists to kill an ambiguity class: the HMAC
message is the **raw 32 subject bytes** followed by the band as **uint64 big-endian** — never hex
text, never a decimal string — and the hex suffix is lowercase with no `0x`.

**Public versus private salt.** Public statements pin a fixed constant *so that anyone can derive
their addresses*: a like nobody can count is not a feature. Private ones use a salt derived from
the user's X25519 key, which never leaves the device — so knowing someone's feed-owner address is
not enough to compute their private topics. That closes the leak encryption alone cannot: mere
*presence* at a deterministic address.

The band lives **inside** the HMAC rather than as a plaintext path segment. It costs nothing
(topics get hashed into identifiers anyway) and it means a disclosed private topic never yields
its siblings. Band 0 is included in the message, so the fixed 40-byte input is disjoint by
construction from the pre-banding 32-byte scheme — no address can collide with one written
before banding existed.

The holder is implicit: topics resolve inside the feed *owner's* address space, so the same topic
string names a different chunk per owner.

### Bands, and the full-band invariant

A statement feed grows, and an unbounded scan is a cost problem. So feeds are cut into bands of
`STATEMENT_BAND_SIZE = 64` versions, under one **frozen invariant**:

> Version 0 of band *b+1* must not be written unless version 63 of band *b* exists.

Three consequences, each relied on somewhere:

1. Every band except the current one is exactly full, so band count is
   `floor(writes / 64)` — and discloses nothing a sequence number did not.
2. A reader whose in-band scan ends below the last slot **knows** it holds the head, with no
   further probing.
3. Bands are contiguous from 0, so a band can be **discovered** by walking openers with no
   carrier at all — which is how the social subject index (no partition rule, nothing read
   first) finds its band.

Together these are what make a stale or missing band hint a cost problem rather than a
correctness one.

**Scope, stated because the obvious reading is wrong.** The invariant governs only feeds that
*band*. Likes and follows are **pinned to band 0**, because latest-wins gives them no growth
axis, and a pinned feed simply keeps appending inside its band — so "band count derives from
write count" does not hold for them, and they must never be band-walked. A pinned family handed
to `resolveOpenBand` would probe the same chunk forever and never terminate.

---

## 4. Platform binary feeds

Some platform-owned feeds are not JSON but **binary pages**: 128 slots × 32 bytes = exactly 4096
bytes, packing hex references, with a zero slot as the terminator (`pack4096` / `decode4096` in
`apps/server/src/lib/swarm/feeds.ts`).

JSON platform feeds are padded to exactly 4096 too, and gzipped into a 3-byte-headed frame when
raw JSON overflows. The exact-4096 requirement is not aesthetic: bee-js's upload→download path
for data over 4096 bytes fails on some Bee node configurations.

---

## 5. Who pays, and who uploads

Storage on Swarm is paid for with a **postage batch**. WoCo runs a platform batch held
server-side, which is why a client-signed write still goes through the API:

```
browser: sign the SOC locally
   ↓  POST /api/swarm/soc   { owner, identifier, signature, span, payload }
server:  re-derive the CAC address from span+payload
         verify the signature recovers to `owner`
         stamp with the platform batch and upload
```

The stamp step is deliberately a **swappable transport** — a per-user batch, or a
browser-resident Bee, would drop in without changing the signing model.

Guards on that endpoint, in order: a JSON body cap sized to the largest honest request and
placed *before* auth, so the auth middleware never reads and hashes megabytes; then auth; then
rate limits per parent, per IP and globally, with a tighter bucket for statement-shaped payloads;
then signature verification; then the upload. `/api/health` reports the refusal counters.

Organiser sites get a free-hosting quota (latest-deployment bytes per site), tracked in
`.data/storage-ledger.json`.

**Batch expiry is the sharp edge.** A stale-synced Bee will happily stamp against a batch that
has already expired and the upload still reports success. Two separate batches are in play (the
WoCo platform batch and the Etherna user batch), and they expire independently.

---

## 6. Reading: the gateway, and the whitelist that is not a cache

Clients read through a Bee gateway fronted by `bee-proxy`. The proxy serves **only addresses in
its whitelist** and tags a refusal:

```
403  X-Chunk-Gate: not-whitelisted        body code: NOT_WHITELISTED
```

The client treats that *tagged* 403 as **"this chunk does not exist"** — which is what took a
cold read from ~15 seconds to ~1.4 seconds. Every write whitelists its own address before
uploading.

The consequences of that trade are the most important operational facts in this document:

- **A lost whitelist entry makes real data read as absent.** The whitelist is data-plane state,
  not a cache. It must be backed up, and an empty one must never be deployed over a populated
  one.
- **Only the tagged 403 is trusted.** An untagged 403 — Cloudflare, a WAF, a corporate proxy, an
  ISP interstitial — means "couldn't ask", which is not an answer. Matching is on the
  machine-readable code only, never on prose, so rewording a message cannot silently change trust
  behaviour. Two live defects came from a "couldn't ask" being cached as an answer
  (`apps/web/src/lib/swarm/gate-denial.ts` explains why that rule lives in its own module).
- **A read that feeds a read-modify-write never trusts the gate.** It reads `thorough`. An
  absent read looks clean, and clean is exactly what the erasure guards check for.

**Never plan a feed write off a lenient read.** `null` means *absent* **or** *transient*, and
those two need opposite responses.

---

## 7. Content feeds are per-kind and settled

Which key owns which feed is a **settled decision** — don't reopen it from older documents. The
short version: content feeds are owned by the user's content-feed signer; the platform signer owns
only platform feeds (the directory pointer); and the feed key is sign-to-derived once, then
stored and escrowed. The reasoning is in
[CLIENT_FEED_SIGNER_HANDOVER.md](./CLIENT_FEED_SIGNER_HANDOVER.md) and
[FEED_SIGNER_REVIEW_2026-07-02.md](./FEED_SIGNER_REVIEW_2026-07-02.md).

**Client** reads of content feeds resolve by **computed chunk address** and never through Bee's
`/feeds` endpoint. That is not a preference — it is what keeps every feed readable through
gateways that do not implement `/feeds`, Etherna included. The **server** does use `/feeds` for
the platform feeds it owns (`apps/server/src/lib/swarm/feeds.ts`), which is fine: it talks to a
Bee node it runs.

Two things this rule does **not** claim. It does not mean the app avoids the server on reads — the
event directory, the per-creator catalogue and event detail pages all go through the API, with the
server resolving the creator's chunk as a relay. And it does not mean the platform key signs only
platform feeds; see
[IDENTITY_AND_KEYS.md § Signing roles](./IDENTITY_AND_KEYS.md#10-signing-roles-in-one-table) for
what it actually owns, and the signer-discovery limit underneath it.

---

## 8. bee-js gotchas that have each cost a day

- `writer.upload()` corrupts feeds in bee-js v11 — use `uploadReference()`.
- `writer.upload()` also requires `new Reference(hexString)`, not a plain string.
- Feed verification reads `feed.feedIndex`. `feed.reference` no longer exists.
- After a Bee restart, wait ~20 s for peer warmup before deploying anything.
- Never run two Bee nodes on the same keystore. Both writing the same feeds is **irreversible
  feed corruption.**
