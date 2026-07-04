# Content-feed versioning — SOC overwrite is a silent no-op (2026-07-04)

Diagnosed by Fable. Implementation intended for Opus. Read `CLAUDE.md` first.

## Root cause (PROVEN, not a hypothesis)

Bee does NOT overwrite a Single-Owner Chunk. Re-uploading a SOC at the same
owner+identifier (= same chunk address) with a DIFFERENT payload returns **201**
but the stored chunk keeps the ORIGINAL payload. Verified live against the
production bee + platform batch (immutable, `9ef3373b…`):

```
upload "version-1"           → 201 ref bf113abe…
read  /chunks/{socAddr}      → "version-1"
upload "version-2-DIFFERENT" → 201 ref bf113abe…   (same ref — dedupe by address)
read  /chunks/{socAddr}      → "version-1"         (new payload DISCARDED, no error)
```

The Phase B client-owned content-feed design (`content-feed.ts` /
`soc-upload.ts`) writes every feed at ONE fixed identifier
(`contentFeedSocIdentifier(topic)` = keccak(topic string)) and relies on
"overwrite-in-place". That only ever works ONCE. First write (publish) lands;
**every subsequent update is silently discarded** — client and server both see
201/ok. This is why Swarm has feeds at all: chunks are immutable; mutability
comes from writing update N at a NEW identifier and resolving "latest".

## Symptoms this explains (all observed 2026-07-04)

- Event edit (EditEventPanel): directory cards update (platform-signed feeds,
  real bee feeds — fine) but the event DETAIL page never updates (client SOC
  stale), the edit form re-seeds from the original feed, and a second edit
  merges onto the ORIGINAL basis so earlier edits appear "wiped".
  Verified on event `0843624d-fe29-44a0-8aac-7201a3d59f6b`: directory says
  "Passkey recovery test 2 EDIT", SOC on Swarm still holds the original.
- Profile save: same rail, same silent no-op after the first write.
- Site config re-publish: same (config SOC, shipped 56ad75e).

Separate, smaller issue: "Saving…" takes very long. `update-meta` awaits a
full strict-read + rewrite of EVERY page of BOTH directories (~124 events)
inside the request. Not a hang — slow. Fix independently (see Tasks).

## Blast radius (all fixed-identifier SOC writers)

| Feed | Writer | Update path broken? |
|---|---|---|
| Event detail feed | `api/events.ts signEventFeedSoc` | YES — edits, on-chain merge re-sign, tombstone delete |
| Profile data + avatar | `api/profiles.ts` | YES — any profile edit after first save |
| Site config | `api/sites.ts` | YES — re-publish of an existing site |
| Manifest feed-log (active-feed inventory + trash) | `manifest/inventory.ts` | YES — every inventory update after first |
| Recovery envelopes | `swarm/recovery-feed.ts`, `recovery-portability.ts` | YES when re-written (new recipients / rotation). Design FROZEN — do not redesign, but updates must use the new rail |

Multisite POINTER feed and platform feeds (directories, legacy events) use real
index-based bee feeds — unaffected.

## Fix design: versioned identifiers = standard single-owner-feed scheme

Make client content feeds REAL sequence-indexed feeds, resolved by chunk-address
probing (Etherna-safe, no `/feeds` dependency):

- `topic32 = keccak(topicString)` (bee Topic bytes).
- `socId(n) = keccak256(topic32 ‖ uint64_BE(n))` — EXACTLY bee's feed-update
  identifier. In-repo reference implementation: `writeEthernaFeedUpdate` step 2
  (`apps/server/src/lib/etherna/upload.ts:186-189`). Byte order matters; reuse
  `FeedIndex.fromBigInt(n).toUint8Array()`.
- Legacy compatibility: existing chunks live at `keccak(topicString)` (the old
  fixed identifier). Treat that as "version legacy", BELOW version 0.

WRITE (`writeContentFeed`): resolve current latest version n (probe, with local
hint — see below), write ALL pages for version n+1 FIRST, then the base SOC at
`socId(n+1)`. Multi-chunk paging: page identifiers must be version-scoped —
`socId_page(n, k) = keccak256(keccak(topicString + "@" + n + "/p" + k))` or
equivalent — so a reader of version n never sees version n+1's pages (no torn
reads). Legacy pages stay readable for the legacy version only.

READ (`readContentFeed` client + `readContentFeedJson` server): find highest
existing version by probing `socId(0), socId(1), …` via the existing SOC read
path (gateway `/chunks` first, server fallback). Probe a small parallel window
(e.g. 8) starting from a HINT; walk until miss; fall back to the legacy
identifier if version 0 absent. Every new version is a NEW chunk address —
whitelisting per address already happens in `uploadSignedSoc`, and stale CDN
caching of `/chunks/{addr}` can never serve an old version (address changes).

HINTS (optimisation, not correctness): cache last-known version per (owner,
topic) in localStorage client-side; server may carry a `feedVersion` hint in
directory entries / API responses. Readers MUST still probe FORWARD from the
hint (hint can be stale-low, never trusted as exact).

Trust model unchanged: SOCs are self-authenticating (address = keccak(id‖owner),
sig must recover to owner); "latest version" is availability-trust like any
Swarm feed. Do NOT change POD / escrow derivations (FROZEN per memory).

### Files

- `packages/shared/src/swarm/soc.ts` — add versioned identifier helpers
  (keep `contentFeedSocIdentifier` for legacy fallback).
- `apps/web/src/lib/swarm/content-feed.ts` — versioned write + probing read.
- `apps/server/src/lib/swarm/soc-upload.ts` — `readContentFeedJson` probing read.
- Recovery envelope writers (`recovery-feed.ts`, `recovery-portability.ts`) and
  their readers — same versioned rail (write-path only change; readers probe).
- Call sites need NO change if the `writeContentFeed`/`readContentFeed`
  signatures are preserved.
- Tests: overwrite round-trip (write v-legacy fixture → write v0 → read latest),
  torn-page safety, legacy fallback.

### Verification (must do live, not just typecheck)

1. Edit an existing event → detail page + edit form show the new values after
   reload (SOC on Swarm actually changed — check via `/chunks` probe).
2. Edit it AGAIN changing a different field → BOTH edits present (basis is v1).
3. Profile edit round-trip; site re-publish round-trip.
4. Legacy: an event never edited still reads (legacy identifier fallback).

## Related tasks (separate commits)

1. **Slow save**: move `updateDirectoryEntriesMeta` off the request path
   (fire-and-forget like the create-path directory upsert — it is already
   non-fatal) OR stream progress. Keep the merged-feed response synchronous.
2. **Edit rail gateway routing**: `EditEventPanel` / `updateEventMeta` never
   pass `gatewayUrl`, so image re-upload + SOC restamp for an ETHERNA event
   route to the WoCo batch (`batchForDeploy` gets `gatewayUrl:""`). Carry the
   event's gateway (from the feed / directory entry) through the edit + delete
   calls.
3. **Etherna 402 on feed hashes**: `registerEthernaOffer` is called for content
   hashes and bytes but NEVER for `feedManifestHash` — so
   `GET gateway.etherna.io/bzz/{feedManifestHash}/` returns 402. Add
   offer-registration for the feed manifest hash at deploy time, then PROBE
   whether Beehive's /bzz feed-dereference works anonymously after offering
   (see `apps/server/scripts/etherna-soc-legacy-probe.ts` + memory
   `project_etherna_legacy_soc` — feed lookups may still 401 anonymously; if so
   the offer must cover the feed UPDATE chunk(s) too, or the link format must
   use the content hash with the feed hash only for ENS).

## Ops note

Platform batch TTL was ~4.2 days at diagnosis time (2026-07-04). Top up before
implementing/testing any of this (`docs/HETZNER_DEPLOY.md` postage section).
