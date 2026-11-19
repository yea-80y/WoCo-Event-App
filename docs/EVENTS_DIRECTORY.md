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
  (`storage-busy.ts`): nothing is concluded or uploaded, and the caller retries;
  requests for the directory stay off the feed for 70 s, because their reads
  are what keeps the refusal going.
  Unreadable otherwise: a full rebuild from the server's records (as far as
  `onchain-events.json` loaded) while the listing overlay is whole; with the
  overlay incomplete too (see below) the rebuild is refused, because the last
  snapshot is then the only record of what was listed.
- **Content that cannot be read.** An event whose own feed misses keeps the
  card already published; the create-time seed is used only when it has no card
  yet. A self-hosted event (`apiUrl`) is always published from its `/list` seed.
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
- **A process's first rebuild is full, and always publishes.** Until it has
  rebuilt once, the snapshot it holds was only read, and bee's lookup can return
  the update before the newest. Building on that incrementally would drop what
  the newest added, and "same as what was read" says nothing about what is live
  (the newest may still list an event unlisted since). One write per process
  makes the live directory this server's records; after it the fingerprint skip
  applies.
- **Health.** `/api/health` `directory` is red when `publishing` is false (an
  alarm anywhere but a dev server), when boot is over and no snapshot is held
  (nothing is being served), or when three rebuilds have failed in a row.
- **A listing overlay that did not load is incomplete.** With
  `event-listing-state.json` missing, or present but not readable as rows,
  memory may lack rows for listed events, and no row means not listed. Before
  it builds, the builder gives each card of the last snapshot a row where there
  is none, and never writes over a row that is there (an unlist, cancel or
  delete). A lost file is rebuilt that way. An empty file (`{}`) is whole:
  nothing is listed.
- **The listing file on disk is never a partial one.** A file holding a few
  rows loads as the whole listing at the next start. So until the builder has
  restored, what people change is kept in `event-listing-state.pending.json`,
  and the restore then writes the file whole and removes the pending file.
  Until then an operator unlist is recorded even for an event with no row
  (`recorded` in its answer), and `GET /api/ops/directory` says `complete: false`.
- **An unreadable listing file is never overwritten.** It is left for repair
  and `/api/health` `listingState` is red. A pending file is written beside it
  at once, empty until something changes; what people change meanwhile (a
  cancel, takedown, unlist, delete, a new event) is kept there and survives
  restarts. Restored rows are not kept there.
- **Repair.** Remove the broken file, KEEP the pending file, restart: the
  listing is restored from the last snapshot, exactly what was public, with the
  pending changes on top. Lost that way: deleted events' tombstones, and the
  rows of events created but not yet registered (list those by hand once they
  register). Putting a backup copy back instead keeps those, but a file that
  loads beside the pending file is an older copy: the pending changes go on
  top, the builder restores the events the last snapshot lists and the copy
  lacks, and only then is the file written. An event unlisted or deleted after
  the copy was taken and before the file broke is LISTED AGAIN by the copy:
  check for those before choosing it. Removing the pending file takes the file
  exactly as it is. With the last snapshot unreadable as well, rebuilds are
  refused until one of the two is settled.
- **Rollback.** A build from before this ignores the pending file and writes
  over an unreadable listing file. Repair first; a pending file left behind is
  applied over the listing at the next start of this build.

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
