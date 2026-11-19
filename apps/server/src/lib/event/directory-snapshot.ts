/**
 * Directory snapshot builder + read model (#37).
 *
 * See packages/shared event/snapshot.ts for the three-layer design. This module:
 *   - READS  the snapshot: pointer feed → immutable blob, SWR-cached (backs listEvents).
 *   - BUILDS the snapshot: group registrations by event → resolve creator-signed
 *              content → copy+normalise into cards → apply the listing overlay →
 *              upload an immutable blob → O(1) pointer-feed write.
 *   - TRIGGERS: a debounced incremental rebuild on register-success / edit / (un)list,
 *              plus a periodic + manual full reconcile.
 *
 * The snapshot is a CACHE, NOT TRUTH — rebuildable from any surviving snapshot
 * forward (each blob embeds the onChainEventId→content resolution table the chain
 * log lacks). A missed rebuild degrades freshness, never integrity.
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

async function readSnapshotFromSwarm(): Promise<EventsSnapshot | null> {
  const page = await readFeedPage(topicEventsSnapshot());
  const pointer = page ? decodeJsonFeed<EventsSnapshotPointer>(page) : null;
  if (!pointer?.snapshotRef) return null;
  try {
    const raw = await downloadFromBytes(pointer.snapshotRef);
    return JSON.parse(raw) as EventsSnapshot;
  } catch (err) {
    console.error("[snapshot] blob fetch failed:", err);
    return null;
  }
}

/**
 * Current directory snapshot. SWR: serve the cached copy and refresh behind the
 * response once stale; only a cold process pays the (cheap: 1 pointer + 1 blob)
 * read. Returns null before the first snapshot exists (→ empty directory).
 */
export async function getEventsSnapshot(): Promise<EventsSnapshot | null> {
  if (_cache) {
    if (Date.now() - _cache.at >= READ_CACHE_TTL_MS) void refreshRead();
    return _cache.snapshot;
  }
  return refreshRead();
}

function refreshRead(): Promise<EventsSnapshot | null> {
  if (_readInFlight) return _readInFlight;
  _readInFlight = (async () => {
    try {
      const snap = await readSnapshotFromSwarm();
      if (snap) _cache = { at: Date.now(), snapshot: snap };
      return snap ?? _cache?.snapshot ?? null;
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
 * Everything a rebuild reads or writes outside this module, as one object a test
 * can replace. The rebuild had no test before this: its uploads land on whatever
 * bee the process is pointed at, and in development that is production's.
 */
export interface SnapshotIo {
  readPointer(): Promise<FeedReadStrictResult>;
  readBlob(ref: string): Promise<string>;
  writeBlob(json: string): Promise<Hex64>;
  writePointer(page: Uint8Array): Promise<void>;
  resolveCard(entry: { wocoEventId: string; creatorFeedSigner?: string }): Promise<SnapshotCard | null>;
  registrations(): SnapshotResolutionEntry[];
  activeChainId(): number;
}

/**
 * The server's registrations as table entries, each with its event's feed signer.
 * The registry does not hold the signer, and a full rebuild used to get it only
 * from the last snapshot's table. With nothing to build on, every entry would be
 * published without the one field that lets a reader find the event's content.
 * The record pinned at create (#670) is where the register-success trigger takes
 * it from too (`resolutionSigner`), so the two never disagree.
 */
export function registrationsWithSigners(): SnapshotResolutionEntry[] {
  return getAllResolutionEntries().map((e) => {
    const signer = getRecordedFeedSigner(e.wocoEventId)?.signer;
    return signer ? { ...e, creatorFeedSigner: signer } : e;
  });
}

const liveIo: SnapshotIo = {
  readPointer: () => readFeedPageStrict(topicEventsSnapshot()),
  readBlob: (ref) => downloadFromBytes(ref),
  writeBlob: (json) => uploadToBytes(json),
  writePointer: (page) => writeFeedPage(topicEventsSnapshot(), page),
  resolveCard,
  registrations: registrationsWithSigners,
  activeChainId: getActiveChainId,
};
let io = liveIo;

/** Tests only: swap the rebuild's I/O (null restores it) and forget the cached snapshot. */
export function _setSnapshotIoForTest(fake: Partial<SnapshotIo> | null): void {
  io = fake ? { ...liveIo, ...fake } : liveIo;
  _cache = null;
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
 * The snapshot a rebuild builds on, or null when there is none to build on.
 *
 * Never the lenient display read: that answers null for a feed bee failed to
 * read as well as for one never written, and a rebuild taking the first for the
 * second skips the reseed in `doRebuild` and can publish an empty directory over
 * a live one. A snapshot that cannot be read is survivable while the listing
 * overlay has rows, because overlay and registrations rebuild every card, so
 * that rebuild goes ahead in full. With the overlay empty as well, the last
 * snapshot is the only record of what was listed, and the rebuild is refused.
 */
async function baseForRebuild(): Promise<EventsSnapshot | null> {
  if (_cache) return _cache.snapshot;
  const read = await io.readPointer();
  if (read.status === "absent") return null;
  let unreadable: string;
  if (read.status === "error") {
    unreadable = read.error.message;
  } else {
    const pointer = decodeJsonFeed<EventsSnapshotPointer>(read.data);
    if (!pointer?.snapshotRef) {
      unreadable = "the pointer did not decode";
    } else {
      try {
        const snap = JSON.parse(await io.readBlob(pointer.snapshotRef)) as EventsSnapshot;
        if (Array.isArray(snap?.cards) && Array.isArray(snap?.resolution)) return snap;
        unreadable = `blob ${pointer.snapshotRef.slice(0, 12)}… is not a snapshot`;
      } catch (err) {
        unreadable = `blob ${pointer.snapshotRef.slice(0, 12)}…: ${(err as Error)?.message ?? err}`;
      }
    }
  }
  if (!hasAnyRows()) {
    throw new Error(`the last directory snapshot is unreadable and the listing overlay is empty (${unreadable})`);
  }
  console.warn(`[snapshot] last snapshot unreadable (${unreadable}): rebuilding in full from server records`);
  return null;
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
  _rebuildQueue = _rebuildQueue.catch(() => undefined).then(() => doRebuild(opts));
  return _rebuildQueue;
}

async function doRebuild(opts: RebuildOpts): Promise<void> {
  const base = await baseForRebuild();
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
  await io.writePointer(encodeJsonFeed(pointer));
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

/** Start the periodic full reconcile. Idempotent; called once from server startup. */
export function startSnapshotMaintenance(): void {
  if (_maintenanceStarted) return;
  _maintenanceStarted = true;
  setInterval(() => void rebuildSnapshotFull().catch(() => undefined), RECONCILE_INTERVAL_MS).unref?.();
}
