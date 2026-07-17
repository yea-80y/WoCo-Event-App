# Events Directory — how it works (#37)

The public events directory is a **three-layer split**. Each layer has one job and
one owner. (Schema + invariants: `packages/shared/src/event/snapshot.ts`; builder:
`apps/server/src/lib/event/directory-snapshot.ts`.)

## The three layers

| Layer | Where | What | Who signs |
|---|---|---|---|
| 1. TRUTH | On-chain (`WoCoEventV2`, Arbitrum) | `Registered` log, one entry per ticket series: `onChainEventId`, supply, manifest **digest** | Platform sponsor wallet (gas-sponsored on behalf of the organiser) |
| 2. CONTENT | Swarm | Event feed (SOC) + series manifests + images | **Creator** (client-owned feed signer) — the organiser's content, portable, listable anywhere |
| 3. SPEED | Swarm | ONE immutable snapshot blob + a pointer feed at `woco/event/directory/snapshot` | **Platform signer** (the only centralised piece) |

- A directory paint = 1 pointer-feed read + 1 blob fetch, regardless of event count.
  The blob is immutable ⇒ hard CDN caching.
- The snapshot is a **cache, not truth**. Each blob embeds the
  `onChainEventId → {wocoEventId, seriesId, creatorFeedSigner}` resolution table
  (the chain log only carries a keccak digest, not a Swarm address), so
  snapshot + chain log is self-verifying and each snapshot rebuilds from the last.
- Server-side overlay: `.data/event-listing-state.json` records WoCo's own
  listing decision per event (listed / explicitlyListed / tombstoned + a card
  seed). **Default-exclude**: no row ⇒ not in the directory. This is directory
  *membership* (WoCo's moderation lever), never event *existence* — the event
  itself stays fully the organiser's.

## What is on-chain vs not

On-chain (costs gas, paid by the platform sponsor — never the organiser):
- Series registration only: event id, supply, manifest digest, organiser,
  payout recipient, end timestamp. Registered once per series at publish.

NOT on-chain (Swarm only — free to change, no gas ever):
- Title, tagline, description, dates, location, image
- **Genre tags** (`EventTag[]`, controlled vocab in `shared/src/event/tags.ts`)
- **Structured geo** (`EventGeo` — ISO country + city/venue + lat/lng, populated
  by the client-side Photon geocoder at create/edit time; `shared/src/event/geo.ts`)

**So yes: an organiser can add or change tags/geo after publishing, at zero gas.**
`POST /api/events/:id/update-meta` merges the edit, the organiser re-signs their
feed SOC client-side (a Swarm write, no chain tx), and a debounced snapshot
rebuild copies the tags/geo — normalised (`normaliseTags` / `normaliseGeo`) —
into the event's card. Series/payment data is the opposite: manifest-committed
and chain-anchored, never editable this way.

## Lifecycle

1. **Create** (`POST /api/events`) — content to Swarm, creator signs the feed SOC;
   listing row auto-seeded (listed, not `explicitlyListed`).
2. **Register** (`POST /:id/register-on-chain`) — sponsor wallet sends
   `registerEvent` per series, exactly-once guarded; on success the event enters
   the snapshot's resolution table and a rebuild is scheduled.
3. **Edit** (`POST /:id/update-meta`) — incl. tags/geo; re-sign SOC, rebuild. No gas.
4. **List / Unlist** (`POST /:id/list|unlist`) — flips the overlay flag + rebuild.
   A deliberate `/list` sets `explicitlyListed`, which is the ONLY way an
   *unregistered* event (federated self-hosted, or re-listed legacy) gets in.
5. **Delete** (`POST /:id/delete`) — zero-orders only; tombstone is terminal.

Rebuilds: debounced incremental (1.5s, coalesces multi-series publishes) +
30-min full reconcile + fingerprint skip (no churn when nothing changed).
Order: blob upload first, pointer write second — the pointer never names a
missing blob.

## Reads

- `GET /api/events` — the snapshot's cards (`SnapshotCard[]`: incl. `tags`, `geo`,
  `creatorFeedSigner` carrier, `apiUrl` for federated events). Past events are
  KEPT while volume is small (attendee "Past" tab); scale path = move history to
  the per-creator index.
- `GET /api/events/by-creator/:address` — public, rate-limited, per-creator index
  (never trimmed by unlist) → organiser profile history log.
- Discovery filtering (country / genre / near-me) is **fully client-side** over
  the card fields — zero extra requests, no geocoder on the read path.

## Centralisation status + phase-out

Today the **platform signer** owns the pointer feed and the server owns the
listing overlay + rebuild trigger. That is the entire centralised surface — and
it is deliberately the SPEED layer only:

- Truth (chain log) is already permissionless: anyone can enumerate
  registrations and rebuild a directory.
- Content is already creator-signed and portable.
- The pointer feed is designed to be swapped (multi-writer chunk updates /
  community moderation) without touching layers 1–2. Anyone who disagrees with
  WoCo's overlay can publish a rival snapshot from the same truth + content.

## Ops notes

- `.data/event-listing-state.json` must survive restarts. If lost, the builder
  self-heals by reseeding the overlay from the last snapshot (only recovers
  events already in a snapshot — see CLAUDE.md gotcha).
- Cutover behaviour on first deploy: the directory starts EMPTY; each event
  returns via one organiser `/list`. This is what filters legacy test events out
  of the new directory.
