/**
 * Directory snapshot builder + read model (#37).
 *
 * See packages/shared event/snapshot.ts for the three-layer design. This module:
 *   - READS  the snapshot: pointer feed → immutable blob, SWR-cached (backs listEvents).
 *   - BUILDS the snapshot: group registrations by event → resolve creator-signed
 *              content → copy+normalise into cards → apply the listing overlay →
 *              upload an immutable blob → O(1) pointer-feed write.
 *   - TRIGGERS: a debounced incremental rebuild on register-success / edit / (un)list,
 *              plus a full reconcile at boot, every 30 minutes, and on request.
 *
 * The snapshot is a CACHE, NOT TRUTH. This server rebuilds it from its own
 * registrations and listing overlay; anyone else can rebuild from a surviving
 * snapshot forward (each blob embeds the onChainEventId→content resolution table
 * the chain log lacks). A missed rebuild degrades freshness, never integrity.
 */

import { ETHERNA_URL, isEthernaGateway } from "../etherna/batch-router.js";
import type {
  EventFeed, EventsSnapshot, EventsSnapshotPointer, Hex64, SnapshotCard, SnapshotResolutionEntry,
} from "@woco/shared";
import { normaliseTags, normaliseGeo } from "@woco/shared";
import { getActiveChainId } from "../chain/event-contract.js";
import { uploadToBytes, downloadFromBytes } from "../swarm/bytes.js";
import {
  readFeedPage, readFeedPageStrict, writeFeedPage, encodeJsonFeed, decodeJsonFeed, type FeedReadStrictResult,
} from "../swarm/feeds.js";
import { isStorageBusy, STORAGE_BUSY_RETRY_MS } from "../swarm/storage-busy.js";
import { topicEventsSnapshot } from "../swarm/topics.js";
import { getRecordedFeedSigner } from "./feed-signer-record.js";
import { getAllResolutionEntries } from "./onchain-registry.js";
import { isListedForSnapshot, isExplicitlyListed, getListingSeed, listedEventIds, hasAnyRows, setListed } from "./listing-state.js";

// ---------------------------------------------------------------------------
// Card shaping — the ONE place event content becomes a listing card. Reused by
// the builder (fresh resolve) AND by create/list seed capture, so the copy +
// tag-normalisation logic lives in a single spot.
// ---------------------------------------------------------------------------

/** Build a listing card from a (creator-signed) event feed. `extra.apiUrl` is the
 *  federated self-hosted base, known only to the /list route. */
export function cardFromFeed(feed: EventFeed, extra?: { apiUrl?: string }): SnapshotCard {
  return {
    eventId: feed.eventId,
    title: feed.title,
    ...(feed.tagline ? { tagline: feed.tagline } : {}),
    imageHash: feed.imageHash,
    startDate: feed.startDate,
    ...(feed.endDate ? { endDate: feed.endDate } : {}),
    location: feed.location ?? "",
    creatorAddress: feed.creatorAddress,
    ...(feed.creatorFeedSigner ? { creatorFeedSigner: feed.creatorFeedSigner } : {}),
    // The canonical URL, never the feed's own string: a Phase B feed is
    // organiser-signed, and a card's gatewayUrl steers every viewer's image fetch.
    ...(feed.gatewayUrl && isEthernaGateway(feed.gatewayUrl) ? { gatewayUrl: ETHERNA_URL } : {}),
    seriesCount: feed.series.length,
    totalTickets: feed.series.reduce((n, s) => n + s.totalSupply, 0),
    createdAt: feed.createdAt,
    tags: normaliseTags(feed.tags),
    ...((g) => (g ? { geo: g } : {}))(normaliseGeo(feed.geo)),
    ...(extra?.apiUrl ? { apiUrl: extra.apiUrl } : {}),
  };
}

// ---------------------------------------------------------------------------
// Read path — pointer feed → immutable blob, SWR cache. Backs listEvents().
// ---------------------------------------------------------------------------

const READ_CACHE_TTL_MS = 60_000;
let _cache: { at: number; snapshot: EventsSnapshot } | null = null;
let _readInFlight: Promise<EventsSnapshot | null> | null = null;
/** When a display read last found no snapshot. */
let _emptyReadAt = 0;

/** A blob's JSON as a snapshot, or null when it is JSON of another shape. Throws on text that is not JSON. */
function parseSnapshot(json: string): EventsSnapshot | null {
  const snap = JSON.parse(json) as EventsSnapshot | null;
  return Array.isArray(snap?.cards) && Array.isArray(snap?.resolution) ? snap : null;
}

/**
 * Take a snapshot that was read or built as the current one, unless a newer one
 * is already held. A lookup of the pointer feed is a lower bound (`feed-index.ts`):
 * for minutes after a write bee can still answer with the update before it, and
 * a rebuild that built on that older snapshot would drop what the newer one added.
 */
function remember(snapshot: EventsSnapshot): void {
  if (_cache && snapshot.builtAt < _cache.snapshot.builtAt) {
    _cache.at = Date.now();
    return;
  }
  _cache = { at: Date.now(), snapshot };
}

async function readSnapshotFromSwarm(): Promise<EventsSnapshot | null> {
  const page = await io.readPointerForDisplay();
  const pointer = page ? decodeJsonFeed<EventsSnapshotPointer>(page) : null;
  if (!pointer?.snapshotRef) return null;
  try {
    return parseSnapshot(await io.readBlob(pointer.snapshotRef));
  } catch (err) {
    console.error("[snapshot] blob fetch failed:", err);
    return null;
  }
}

/**
 * Current directory snapshot. SWR: serve the cached copy and refresh behind the
 * response once stale; only a cold process pays the (cheap: 1 pointer + 1 blob)
 * read. Returns null before the first snapshot exists (→ empty directory).
 *
 * A read that found nothing is not repeated for the same interval. Every read of
 * a feed nobody has written is a miss on its first chunk, and a few misses inside
 * a minute make bee refuse that chunk for the next one (`storage-busy.ts`), which
 * is what would then refuse the write that creates the feed.
 */
export async function getEventsSnapshot(): Promise<EventsSnapshot | null> {
  if (_cache) {
    if (Date.now() - _cache.at >= READ_CACHE_TTL_MS) void refreshRead();
    return _cache.snapshot;
  }
  if (Date.now() - _emptyReadAt < READ_CACHE_TTL_MS) return null;
  return refreshRead();
}

function refreshRead(): Promise<EventsSnapshot | null> {
  if (_readInFlight) return _readInFlight;
  _readInFlight = (async () => {
    try {
      const snap = await readSnapshotFromSwarm();
      if (snap) remember(snap);
      else _emptyReadAt = Date.now();
      return _cache?.snapshot ?? null;
    } finally {
      _readInFlight = null;
    }
  })();
  return _readInFlight;
}

// ---------------------------------------------------------------------------
// Build path
// ---------------------------------------------------------------------------

// Resolving an event feed is a circular import at module scope (service → this →
// service), safe because it is only ever called at runtime. Kept as a late import
// so the cycle never touches module-evaluation order.
async function resolveCard(entry: { wocoEventId: string; creatorFeedSigner?: string }): Promise<SnapshotCard | null> {
  const { getEvent } = await import("./service.js");
  // Pass the known signer so getEvent skips the directory-carrier lookup (which
  // would re-enter listEvents → getEventsSnapshot). getEvent returns null for a
  // tombstoned feed; the listing overlay already excludes those, so a null here
  // just means "resolve from the seed fallback instead".
  const feed = await getEvent(entry.wocoEventId, entry.creatorFeedSigner).catch(() => null);
  if (feed) return cardFromFeed(feed);
  return getListingSeed(entry.wocoEventId); // federated / transient-miss fallback
}

/** Merge resolution entries by onChainEventId, newest write wins for the signer. */
function mergeResolution(...lists: SnapshotResolutionEntry[][]): SnapshotResolutionEntry[] {
  const byId = new Map<string, SnapshotResolutionEntry>();
  for (const list of lists) for (const e of list) {
    const prev = byId.get(e.onChainEventId);
    byId.set(e.onChainEventId, { ...prev, ...e, ...(e.creatorFeedSigner || prev?.creatorFeedSigner ? { creatorFeedSigner: e.creatorFeedSigner ?? prev?.creatorFeedSigner } : {}) });
  }
  return [...byId.values()];
}

/**
 * The directory's Swarm reads and writes, its registrations and its card
 * resolver, as one object a test can replace. The rebuild had no test before
 * this: its uploads land on whatever bee the process is pointed at, and in
 * development that is production's. The listing overlay is not here: tests run
 * the real one on a temp `.data`.
 */
export interface SnapshotIo {
  /** The rebuild's read: absent, unreadable and found are three answers. */
  readPointer(): Promise<FeedReadStrictResult>;
  /** The display read: null for absent and for unreadable alike. */
  readPointerForDisplay(): Promise<Uint8Array | null>;
  readBlob(ref: string): Promise<string>;
  writeBlob(json: string): Promise<Hex64>;
  /** `fresh`: the feed has never been written, so the update goes to index 0 with no read first. */
  writePointer(page: Uint8Array, fresh: boolean): Promise<void>;
  resolveCard(entry: { wocoEventId: string; creatorFeedSigner?: string }): Promise<SnapshotCard | null>;
  registrations(): SnapshotResolutionEntry[];
  activeChainId(): number;
}

/**
 * The server's registrations as table entries, each with its event's feed signer
 * where one was pinned at create (#670). The registry does not hold the signer,
 * and a full rebuild used to get it only from the last snapshot's table: with
 * nothing to build on, every entry would be published without the one field that
 * lets a reader find the event's content.
 *
 * An event created before the pinned record existed gets no signer here. The
 * listing overlay's card seed holds one for some of them, and is deliberately not
 * used: `/list` rewrites it, and this value becomes the signer the money path
 * reads the event under.
 */
export function registrationsWithSigners(): SnapshotResolutionEntry[] {
  return getAllResolutionEntries().map((e) => {
    const signer = getRecordedFeedSigner(e.wocoEventId)?.signer;
    return signer ? { ...e, creatorFeedSigner: signer } : e;
  });
}

const liveIo: SnapshotIo = {
  readPointer: () => readFeedPageStrict(topicEventsSnapshot()),
  readPointerForDisplay: () => readFeedPage(topicEventsSnapshot()),
  readBlob: (ref) => downloadFromBytes(ref),
  writeBlob: (json) => uploadToBytes(json),
  writePointer: (page, fresh) => writeFeedPage(topicEventsSnapshot(), page, fresh ? { fresh: true } : {}),
  resolveCard,
  registrations: registrationsWithSigners,
  activeChainId: getActiveChainId,
};
let io = liveIo;

/** Tests only: swap the directory's I/O (null restores it) and forget what was read. */
export function _setSnapshotIoForTest(fake: Partial<SnapshotIo> | null): void {
  io = fake ? { ...liveIo, ...fake } : liveIo;
  _cache = null;
  _emptyReadAt = 0;
}

/** Tests only: run the display refresh now, as an expired cache would. */
export function _refreshSnapshotForTest(): Promise<EventsSnapshot | null> {
  return refreshRead();
}

/**
 * Whether this process rebuilds the public directory. A rebuild publishes what
 * THIS server's listing overlay says is listed, signed with the platform key. A
 * development server runs on the production key and bee with a `.data` of its
 * own, so its rebuild would replace the live directory with a laptop's view of
 * it, every 30 minutes. The dev scripts set `DIRECTORY_PUBLISH=off`; such a
 * process still reads the directory.
 */
export function directoryPublishingEnabled(): boolean {
  return process.env.DIRECTORY_PUBLISH !== "off";
}

/**
 * Whether a registration goes in the published table. The table exists so the
 * directory can be checked against a contract's `Registered` log, and so the
 * builder knows which events count as registered: an entry that names no
 * contract can be checked against none, and one on another chain can no longer
 * sell (`saleContractFor`). Either would also be rewritten into every blob for
 * good. Such an event stays in the server's own records, its tickets still
 * verify, and it can still be listed deliberately.
 */
export function isPublishedRegistration(entry: SnapshotResolutionEntry, activeChainId: number): boolean {
  return entry.contract !== undefined && entry.chainId === activeChainId;
}

/**
 * The snapshot a rebuild builds on (`base`, null when there is none), and
 * whether the feed has never been written.
 *
 * The cached snapshot when there is one: it was read or built, never assumed.
 * Otherwise a strict read, because the display read answers null for a feed bee
 * failed to read as well as for one never written, and a rebuild taking the
 * first for the second skips the reseed in `doRebuild` and can publish an empty
 * directory over a live one. Four answers:
 *  - found: build on it;
 *  - never written: build in full, and write index 0 without probing it again;
 *  - bee is refusing the feed's first chunk for a minute (`storage-busy.ts`):
 *    the same answer for a feed never written and for one it cannot reach, so
 *    nothing is concluded and nothing uploaded. Thrown as is, for the caller to
 *    retry past the window;
 *  - unreadable otherwise: survivable while the listing overlay has rows,
 *    because overlay and registrations rebuild every card, so the rebuild goes
 *    ahead in full. With the overlay empty too, the last snapshot is the only
 *    record of what was listed, and the rebuild is refused.
 */
async function baseForRebuild(): Promise<{ base: EventsSnapshot | null; neverWritten: boolean }> {
  if (_cache) return { base: _cache.snapshot, neverWritten: false };
  const read = await io.readPointer();
  if (read.status === "absent") return { base: null, neverWritten: true };
  let unreadable: string;
  if (read.status === "error") {
    if (isStorageBusy(read.error)) throw read.error;
    unreadable = read.error.message;
  } else {
    const pointer = decodeJsonFeed<EventsSnapshotPointer>(read.data);
    if (!pointer?.snapshotRef) {
      unreadable = "the pointer did not decode";
    } else {
      try {
        const snap = parseSnapshot(await io.readBlob(pointer.snapshotRef));
        if (snap) {
          remember(snap);
          return { base: snap, neverWritten: false };
        }
        unreadable = `blob ${pointer.snapshotRef.slice(0, 12)}… is not a snapshot`;
      } catch (err) {
        unreadable = `blob ${pointer.snapshotRef.slice(0, 12)}…: ${(err as Error)?.message ?? err}`;
      }
    }
  }
  if (!hasAnyRows()) {
    throw new Error(`the directory snapshot is unreadable and the listing overlay is empty (${unreadable})`);
  }
  console.warn(`[snapshot] no readable snapshot (${unreadable}): rebuilding in full from server records`);
  return { base: null, neverWritten: false };
}

interface RebuildOpts {
  /** Re-resolve every event from the full resolution table (periodic / ops). */
  full?: boolean;
  /** Events whose content changed — re-resolve just these (incremental). */
  touchedEventIds?: string[];
  /** New register-success resolution entries to fold in. */
  addResolution?: SnapshotResolutionEntry[];
}

/** Order-independent content fingerprint (sorts both arrays by id + object keys)
 *  so an unchanged rebuild is detected regardless of map/sort iteration order. */
function fingerprint(cards: SnapshotCard[], resolution: SnapshotResolutionEntry[]): string {
  const sortKeys = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sortKeys)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, val]) => [k, sortKeys(val)]))
        : v;
  const c = [...cards].sort((a, b) => (a.eventId < b.eventId ? -1 : 1));
  const r = [...resolution].sort((a, b) => (a.onChainEventId < b.onChainEventId ? -1 : 1));
  return JSON.stringify(sortKeys({ c, r }));
}

let _rebuildQueue: Promise<void> = Promise.resolve();

/** Serialise rebuilds (the pointer feed is single-writer) and swallow errors so a
 *  failed rebuild never rejects a caller — the snapshot is a cache. */
export function rebuildSnapshot(opts: RebuildOpts = {}): Promise<void> {
  if (!directoryPublishingEnabled()) return Promise.resolve();
  _rebuildQueue = _rebuildQueue.catch(() => undefined).then(() => doRebuild(opts));
  return _rebuildQueue;
}

async function doRebuild(opts: RebuildOpts): Promise<void> {
  const { base, neverWritten } = await baseForRebuild();
  // With no snapshot to build on (a new feed generation, or an unreadable one)
  // an incremental rebuild would publish a table holding only this trigger's
  // registrations and leave the rest out until the next reconcile.
  const full = opts.full || !base;

  // Data-loss self-heal: a lost/empty .data overlay would make every event read as
  // unlisted, and the next full reconcile would publish an EMPTY snapshot — wiping
  // the live directory. If the overlay is empty but a prior snapshot exists, reseed
  // the overlay from that snapshot (each card WAS a listed event) before building.
  if (!hasAnyRows() && base && base.cards.length > 0) {
    console.warn(`[listing-state] overlay empty but snapshot has ${base.cards.length} cards — reseeded from snapshot`);
    for (const card of base.cards) setListed(card.eventId, true, card, { explicitlyListed: true });
  }

  // Resolution table: previous snapshot + new register-success entries, plus the
  // server's full registration map on a full reconcile. Filtered after the merge,
  // so an entry already published drops out once the active chain moves on.
  const activeChainId = io.activeChainId();
  const resolution = mergeResolution(
    base?.resolution ?? [],
    opts.addResolution ?? [],
    full ? io.registrations() : [],
  ).filter((e) => isPublishedRegistration(e, activeChainId));

  // Distinct events, and which to (re)resolve. Incremental keeps prior cards and
  // only re-resolves touched events + any candidate with no card yet.
  const existing = new Map<string, SnapshotCard>((base?.cards ?? []).map((c) => [c.eventId, c]));
  const byEvent = new Map<string, SnapshotResolutionEntry>();
  for (const e of resolution) if (!byEvent.has(e.wocoEventId)) byEvent.set(e.wocoEventId, e);

  // Enumerate registered events (resolution table) ∪ overlay-listed events. The
  // UNION is what surfaces an UNREGISTERED event — a federated event never registers
  // on our chain, and a re-listed legacy event may predate the resolution table.
  // INVARIANT: an unregistered event is included ONLY if it was DELIBERATELY listed
  // (isExplicitlyListed). A created-but-never-registered WoCo event (auto-listed at
  // create then registration failed/abandoned, or a future freeEventsAllowed flip)
  // carries no explicitlyListed flag and stays hidden until it registers or is
  // deliberately /list-ed — no unpaid/unregistered event can leak into discovery.
  const candidates = new Set<string>([...byEvent.keys(), ...listedEventIds()]);

  const touched = new Set(opts.touchedEventIds ?? []);
  const toResolve = new Set<string>();
  for (const eventId of candidates) {
    if (full || touched.has(eventId) || !existing.has(eventId)) toResolve.add(eventId);
  }

  for (const eventId of toResolve) {
    // Registered → default-exclude by listing flag; unregistered → require a
    // deliberate /list. Never spend a content read on an event that won't ship —
    // keeps the full reconcile cheap (the ~131 registered-but-unlisted test events
    // are skipped, not re-resolved).
    const include = byEvent.has(eventId) ? isListedForSnapshot(eventId) : isExplicitlyListed(eventId);
    if (!include) { existing.delete(eventId); continue; }
    // Registered → resolve with its known signer. Unregistered → resolve by id
    // (getEvent's carrier/legacy path, then the /list seed fallback — where a
    // federated event's apiUrl lives, since getEvent can't reach a remote server).
    const card = await io.resolveCard(byEvent.get(eventId) ?? { wocoEventId: eventId });
    if (card) existing.set(eventId, card);
    else existing.delete(eventId);
  }

  // Inclusion overlay (default-exclude), then newest-first. Past events are NOT
  // dropped: global discovery keeps them so the attendee "Past" tab stays populated
  // while volume is small. The scale path (when the snapshot blob grows unwieldy) is
  // to serve past events per-organiser off the creator index (GET /by-creator) rather
  // than the global blob — the profile history surface, not this list.
  const cards = [...existing.values()]
    .filter((c) => isListedForSnapshot(c.eventId))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

  // Skip the write when nothing changed. Every rebuild uploads a NEW immutable
  // blob (fresh Swarm chunks on the platform batch), so an unconditional periodic
  // reconcile would churn postage capacity for no reason. Fingerprint (order-
  // independent) the meaningful payload — cards + resolution; builtAt always differs.
  if (base && fingerprint(base.cards, base.resolution) === fingerprint(cards, resolution)) {
    _cache = { at: Date.now(), snapshot: base };
    return;
  }

  const snapshot: EventsSnapshot = {
    v: 1,
    builtAt: new Date().toISOString(),
    registrationCount: resolution.length, // coverage counter (see snapshot.ts)
    cards,
    resolution,
  };

  // Upload the immutable blob, then repoint. Order matters: a pointer must never
  // name a blob that isn't uploaded yet.
  const ref = await io.writeBlob(JSON.stringify(snapshot));
  const pointer: EventsSnapshotPointer = { v: 1, snapshotRef: ref, builtAt: snapshot.builtAt, count: cards.length };
  // A feed read as never written is written as one: no probe of index 0 for bee
  // to refuse, and if that read was wrong the write finds index 0 taken and
  // throws, where a walk past the real updates would make this snapshot the head.
  await io.writePointer(encodeJsonFeed(pointer), neverWritten);
  _cache = { at: Date.now(), snapshot };
  console.log(`[snapshot] rebuilt: ${cards.length} cards, ${resolution.length} registrations, ref=${ref.slice(0, 12)}…`);
}

// ---------------------------------------------------------------------------
// Debounced incremental trigger — coalesces a multi-series publish's N
// register-success calls (and edit/(un)list bursts) into one rebuild.
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 1500;
let _timer: ReturnType<typeof setTimeout> | null = null;
let _pendingEvents = new Set<string>();
let _pendingResolution: SnapshotResolutionEntry[] = [];

export function scheduleSnapshotRebuild(eventId?: string, addResolution?: SnapshotResolutionEntry[]): void {
  if (eventId) _pendingEvents.add(eventId);
  if (addResolution) _pendingResolution.push(...addResolution);
  if (_timer) return;
  _timer = setTimeout(() => {
    _timer = null;
    const touchedEventIds = [..._pendingEvents];
    const add = _pendingResolution;
    _pendingEvents = new Set();
    _pendingResolution = [];
    void rebuildSnapshot({ touchedEventIds, addResolution: add }).catch((err) =>
      console.error("[snapshot] scheduled rebuild failed (non-critical):", err));
  }, DEBOUNCE_MS);
}

/** Full reconcile — ops endpoint + periodic. Heals drift (edits, expired events,
 *  lost incremental triggers) by re-resolving every registered event. */
export function rebuildSnapshotFull(): Promise<void> {
  return rebuildSnapshot({ full: true });
}

const RECONCILE_INTERVAL_MS = 30 * 60_000;
let _maintenanceStarted = false;

/**
 * The first reconcile, at boot. Its one strict read of the pointer feed warms
 * the cache, so nothing else needs to read the feed at startup, and on a feed
 * generation nobody has written it publishes the first snapshot, before requests
 * start reading a feed that is not there. When bee is already refusing that
 * feed's first chunk, it tries again past the one-minute window, twice.
 */
export async function reconcileAtBoot(
  retryIn: (ms: number, run: () => Promise<void>) => void = (ms, run) => void setTimeout(() => void run(), ms).unref?.(),
  retriesLeft = 2,
): Promise<void> {
  try {
    await rebuildSnapshotFull();
    console.log(`[startup] event directory ready (${_cache?.snapshot.cards.length ?? 0} entries)`);
  } catch (err) {
    if (isStorageBusy(err) && retriesLeft > 0) {
      console.warn(`[startup] event directory: storage busy, trying again in ${Math.round(STORAGE_BUSY_RETRY_MS / 1000)}s`);
      retryIn(STORAGE_BUSY_RETRY_MS, () => reconcileAtBoot(retryIn, retriesLeft - 1));
      return;
    }
    console.warn("[startup] event directory reconcile failed:", err);
  }
}

/** Reconcile now, then every 30 minutes. Idempotent; called once from server startup. */
export function startSnapshotMaintenance(): void {
  if (_maintenanceStarted) return;
  _maintenanceStarted = true;
  if (!directoryPublishingEnabled()) {
    console.log("[snapshot] DIRECTORY_PUBLISH=off: this process reads the public directory and never rebuilds it");
    return;
  }
  void reconcileAtBoot();
  setInterval(() => void rebuildSnapshotFull().catch(() => undefined), RECONCILE_INTERVAL_MS).unref?.();
}
