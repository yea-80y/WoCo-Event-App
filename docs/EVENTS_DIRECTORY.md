# Events Directory — how it works (#37)

**Verified against `main` (94364b56) on 2026-10-05.**

The public events directory is a **three-layer split**. Each layer has one job and
one owner. (Schema + invariants: `packages/shared/src/event/snapshot.ts`; builder:
`apps/server/src/lib/event/directory-snapshot.ts`.)

## The three layers

| Layer | Where | What | Who signs |
|---|---|---|---|
| 1. TRUTH | Onchain (`WoCoTicketLedger` on Arbitrum Sepolia today; `WoCoEventV2` before it) | `Registered` log, one entry per ticket series: `onChainEventId`, organiser, supply, manifest **digest** | Platform sponsor wallet (gas-sponsored on behalf of the organiser) |
| 2. CONTENT | Swarm (new events stamped on Etherna, #617) | Event feed (SOC) + series manifests + images | **Creator** (client-owned feed signer) — the organiser's content, portable, listable anywhere |
| 3. SPEED | Swarm | ONE immutable snapshot blob + a pointer feed at `woco/event/directory/snapshot/{generation}` (`eventsSnapshotTopicName` in `@woco/shared`; generation 2 since 2026-11) | **Platform signer** (the only centralised piece) |

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

Onchain (costs gas, paid by the platform sponsor — never the organiser):
- Series registration only. On `WoCoTicketLedger`: event id, organiser, registrant (the
  sponsor), supply, manifest digest, end timestamp. The ledger holds no money, so no payout
  recipient is recorded (`WoCoEventV2` recorded one). Registered once per series at publish.
  Each registration records which contract it is on (`.data/onchain-events.json`, #563).

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
   listing row auto-seeded (listed, not `explicitlyListed`) unless `skipAutoList` (an event
   meant only for the organiser's own pages). The creator's signer is pinned server-side at
   create (`.data/event-feed-signers.json`, #670) - the money path's only carrier for an
   unlisted event.
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

- **What a rebuild builds on.** The snapshot this process last built or read;
  with none in memory, a strict read. Never written (a new generation): a full
  rebuild from the server's registrations and the overlay, written at index 0
  with no probe first. Bee refusing the feed's first chunk for a minute
  (`storage-busy.ts`): nothing is concluded or uploaded, and the caller retries.
  Unreadable otherwise: a full rebuild while the overlay has rows; with the
  overlay empty too the rebuild is refused, because the last snapshot is then the
  only record of what was listed.
- **What the table holds.** Only registrations that name their contract on the
  active chain (`isPublishedRegistration`), each with the feed signer pinned at
  create (an event from before that record existed has none in a table built
  from nothing). An event outside the table counts as unregistered: it shows only
  when listed deliberately. Its record stays in `.data/onchain-events.json`.
- **At boot.** One strict read of the pointer feed. Found: the display serves
  it and nothing is rebuilt (a restart is the worst moment to resolve every
  event again). Never written: the first snapshot is published. Storage busy:
  retried twice, 65 s apart. Unreadable otherwise: left to the next reconcile.
- **A new generation.** Raising `EVENTS_SNAPSHOT_GENERATION` starts the pointer
  feed again at index 0. Nothing is carried over and the old feed is never read.
  Boot writes it; `POST /api/ops/directory/rebuild` is the manual fallback.
- **Dev never publishes.** A rebuild publishes what this server's overlay lists,
  under the platform key. Both dev start commands set `DIRECTORY_PUBLISH=off`:
  the process reads the directory and never rebuilds it.
- **A process's first rebuild is full.** Until it has rebuilt once, the snapshot
  it holds was only read, and bee's lookup can return the update before the
  newest. Building on that incrementally would drop what the newest added.
- **Health.** `/api/health` `directory` is red when `publishing` is false (an
  alarm anywhere but a dev server), when boot is over and no snapshot is held
  (nothing is being served), or when three rebuilds have failed in a row.
- **An unreadable listing file is never overwritten.** `event-listing-state.json`
  present but not readable as rows is left for repair; the server carries on
  from memory (listed events return through the reseed) and `/api/health`
  `listingState` is red. What people change meanwhile (a cancel, takedown,
  unlist, delete, a new event) is kept in `event-listing-state.pending.json`,
  survives restarts, and is applied over the file once it loads again; rows the
  reseed restored are not. Repair = put a good file back, keep the pending file,
  restart. A file that is not there is still an empty overlay.

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
- Cutover behaviour on first deploy (#37, history): the directory started EMPTY; each
  event returned via one organiser `/list`. That is what filtered legacy test events out
  of the new directory.
