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
  readFeedPageStrict, writeFeedPage, encodeJsonFeed, decodeJsonFeed, type FeedReadStrictResult,
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
let now = () => Date.now();
let _cache: { at: number; snapshot: EventsSnapshot } | null = null;
let _readInFlight: Promise<EventsSnapshot | null> | null = null;
/** When a display read last learned that the feed has never been written. */
let _neverWrittenAt: number | null = null;

/** A blob's JSON as a snapshot, or null when it is JSON of another shape. Throws on text that is not JSON. */
function parseSnapshot(json: string): EventsSnapshot | null {
  const snap = JSON.parse(json) as EventsSnapshot | null;
  return Array.isArray(snap?.cards) && Array.isArray(snap?.resolution) ? snap : null;
}

/**
 * Take a snapshot that was read as the current one, unless a newer one is
 * already held. A lookup of the pointer feed is a lower bound (`feed-index.ts`):
 * for minutes after a write bee can still answer with the update before it, and
 * a rebuild that built on that older snapshot would drop what the newer one added.
 */
function remember(snapshot: EventsSnapshot): void {
  if (_cache && snapshot.builtAt < _cache.snapshot.builtAt) {
    _cache.at = now();
    return;
  }
  _cache = { at: now(), snapshot };
}

async function readSnapshotFromSwarm(): Promise<EventsSnapshot | "never-written" | "unreadable"> {
  const read = await io.readPointerForDisplay();
  if (read.status === "absent") return "never-written";
  if (read.status === "error") return "unreadable";
  const pointer = decodeJsonFeed<EventsSnapshotPointer>(read.data);
  if (!pointer?.snapshotRef) return "unreadable";
  try {
    return parseSnapshot(await io.readBlob(pointer.snapshotRef)) ?? "unreadable";
  } catch (err) {
    console.error("[snapshot] blob fetch failed:", err);
    return "unreadable";
  }
}

/**
 * Current directory snapshot. SWR: serve the cached copy and refresh behind the
 * response once stale; only a cold process pays the (cheap: 1 pointer + 1 blob)
 * read. Returns null before the first snapshot exists (→ empty directory).
 *
 * "Never written" is held for the same interval, as `display-read-memo.ts` holds
 * it for other feeds: every read of such a feed is a miss on its first chunk, and
 * a few misses inside a minute make bee refuse that chunk for the next one
 * (`storage-busy.ts`). A read that could not answer is never held: it is not
 * "nothing there".
 */
export async function getEventsSnapshot(): Promise<EventsSnapshot | null> {
  if (_cache) {
    if (now() - _cache.at >= READ_CACHE_TTL_MS) void refreshRead();
    return _cache.snapshot;
  }
  if (_neverWrittenAt !== null && now() - _neverWrittenAt < READ_CACHE_TTL_MS) return null;
  return refreshRead();
}

function refreshRead(): Promise<EventsSnapshot | null> {
  if (_readInFlight) return _readInFlight;
  _readInFlight = (async () => {
    try {
      const snap = await readSnapshotFromSwarm();
      if (snap === "never-written") _neverWrittenAt = now();
      else if (snap !== "unreadable") remember(snap);
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
  /** The rebuild's read: found, never written and unreadable are three answers. */
  readPointer(): Promise<FeedReadStrictResult>;
  /** The display's read: the same three answers, without the write path's check at the destination. */
  readPointerForDisplay(): Promise<FeedReadStrictResult>;
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
 * An event created before the pinned record existed has none, so a table built
 * from nothing publishes it without a signer. Its card still resolves, through
 * the listing overlay's seed (`resolveCard`).
 */
export function registrationsWithSigners(): SnapshotResolutionEntry[] {
  return getAllResolutionEntries().map((e) => {
    const signer = getRecordedFeedSigner(e.wocoEventId)?.signer;
    return signer ? { ...e, creatorFeedSigner: signer } : e;
  });
}

const liveIo: SnapshotIo = {
  readPointer: () => readFeedPageStrict(topicEventsSnapshot()),
  readPointerForDisplay: () => readFeedPageStrict(topicEventsSnapshot(), { forWrite: false }),
  readBlob: (ref) => downloadFromBytes(ref),
  writeBlob: (json) => uploadToBytes(json),
  writePointer: (page, fresh) => writeFeedPage(topicEventsSnapshot(), page, fresh ? { fresh: true } : {}),
  resolveCard,
  registrations: registrationsWithSigners,
  activeChainId: getActiveChainId,
};
let io = liveIo;

/** Tests only: swap the directory's I/O (null restores it) and forget what was read, built or counted. */
export function _setSnapshotIoForTest(fake: Partial<SnapshotIo> | null): void {
  io = fake ? { ...liveIo, ...fake } : liveIo;
  _cache = null;
  _neverWrittenAt = null;
  _failedRebuilds = 0;
  _rebuiltHere = false;
  _bootSettled = false;
}

/** Tests only: pin the clock (null restores it). */
export function _setSnapshotClockForTest(fn: (() => number) | null): void {
  now = fn ?? (() => Date.now());
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

type BaseRead =
  | { kind: "found"; snapshot: EventsSnapshot }
  | { kind: "never-written" }
  | { kind: "unreadable"; why: string };

/**
 * The last snapshot, for a rebuild or for boot.
 *
 * The one held in memory when there is one: it was read or built, never assumed.
 * Otherwise a strict read, because the alternative - "no snapshot" for a feed bee
 * failed to read as well as for one never written - lets a rebuild skip the
 * reseed in `doRebuild` and publish an empty directory over a live one.
 *
 * Bee refusing the feed's first chunk for a minute (`storage-busy.ts`) is none
 * of the three answers: it says the same for a feed never written and for one
 * it cannot reach. Thrown as is, before anything is built or uploaded, for the
 * caller to retry past the window.
 */
async function readBase(): Promise<BaseRead> {
  if (_cache) return { kind: "found", snapshot: _cache.snapshot };
  const read = await io.readPointer();
  if (read.status === "absent") return { kind: "never-written" };
  if (read.status === "error") {
    if (isStorageBusy(read.error)) throw read.error;
    return { kind: "unreadable", why: read.error.message };
  }
  const pointer = decodeJsonFeed<EventsSnapshotPointer>(read.data);
  if (!pointer?.snapshotRef) return { kind: "unreadable", why: "the pointer did not decode" };
  const blob = `blob ${pointer.snapshotRef.slice(0, 12)}…`;
  try {
    const snapshot = parseSnapshot(await io.readBlob(pointer.snapshotRef));
    if (!snapshot) return { kind: "unreadable", why: `${blob} is not a snapshot` };
    remember(snapshot);
    return { kind: "found", snapshot };
  } catch (err) {
    return { kind: "unreadable", why: `${blob}: ${(err as Error)?.message ?? err}` };
  }
}

interface RebuildOpts {
  /** Re-resolve every event from the full resolution table (periodic / ops). */
  full?: boolean;
  /** Events whose content changed — re-resolve just these (incremental). */
  touchedEventIds?: string[];
  /** New register-success resolution entries to fold in. */
  addResolution?: SnapshotResolutionEntry[];
  /** The caller has just read the feed strictly and it has never been written:
   *  reading it again would be a second miss on a chunk bee starts refusing
   *  after a few. Ignored once this process holds a snapshot. */
  knownNeverWritten?: boolean;
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
/** Rebuilds that failed in a row. */
let _failedRebuilds = 0;
/** This process has completed a rebuild, so the snapshot it holds is one it built or checked in full. */
let _rebuiltHere = false;
/** Boot has finished trying to read or create the directory. */
let _bootSettled = false;

/** Serialise rebuilds (the pointer feed is single-writer). One that fails rejects
 *  its own caller and never the rebuild queued behind it. */
export function rebuildSnapshot(opts: RebuildOpts = {}): Promise<void> {
  if (!directoryPublishingEnabled()) return Promise.resolve();
  const run = _rebuildQueue.catch(() => undefined).then(() => doRebuild(opts));
  _rebuildQueue = run;
  run.then(() => { _failedRebuilds = 0; }, () => { _failedRebuilds++; });
  return run;
}

async function doRebuild(opts: RebuildOpts): Promise<void> {
  const read: BaseRead = opts.knownNeverWritten && !_cache ? { kind: "never-written" } : await readBase();
  if (read.kind === "unreadable") {
    // Survivable while the listing overlay has rows: overlay and registrations
    // rebuild every card. With the overlay empty too, the last snapshot is the
    // only record of what was listed.
    if (!hasAnyRows()) {
      throw new Error(`the directory snapshot is unreadable and the listing overlay is empty (${read.why})`);
    }
    console.warn(`[snapshot] no readable snapshot (${read.why}): rebuilding in full from server records`);
  }
  const base = read.kind === "found" ? read.snapshot : null;
  const neverWritten = read.kind === "never-written";
  // Full until this process has completed a rebuild of its own, because until
  // then it has nothing sound to build on incrementally:
  //  - no snapshot (a new feed generation, or an unreadable one): the table
  //    would hold only this trigger's registrations;
  //  - a snapshot it only read. Bee's lookup is a lower bound, so after a restart
  //    the one read can be the update before the newest, and building on it
  //    would drop what the newest added. A full rebuild resolves every listed
  //    event and takes every registration from the server's own records, so
  //    nothing the newest update added can be missing from it.
  const full = opts.full || !_rebuiltHere;

  // Data-loss self-heal: a lost/empty .data overlay would make every event read as
  // unlisted, and the next full reconcile would publish an EMPTY snapshot — wiping
  // the live directory. If the overlay is empty but a prior snapshot exists, reseed
  // the overlay from that snapshot (each card WAS a listed event) before building.
  if (!hasAnyRows() && base && base.cards.length > 0) {
    console.warn(`[listing-state] overlay empty but snapshot has ${base.cards.length} cards — reseeded from snapshot`);
    for (const card of base.cards) setListed(card.eventId, true, card, { explicitlyListed: true, fromSnapshot: true });
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
    _cache = { at: now(), snapshot: base };
    _rebuiltHere = true;
    return;
  }

  // Never older than the snapshot it replaces, whatever the clock says: `remember`
  // orders snapshots by this.
  const after = base ? Date.parse(base.builtAt) : NaN;
  const builtAt = new Date(Number.isFinite(after) ? Math.max(now(), after + 1) : now()).toISOString();
  const snapshot: EventsSnapshot = {
    v: 1,
    builtAt,
    registrationCount: resolution.length, // coverage counter (see snapshot.ts)
    cards,
    resolution,
  };

  // Upload the immutable blob, then repoint. Order matters: a pointer must never
  // name a blob that isn't uploaded yet.
  const ref = await io.writeBlob(JSON.stringify(snapshot));
  const pointer: EventsSnapshotPointer = { v: 1, snapshotRef: ref, builtAt: snapshot.builtAt, count: cards.length };
  // A feed read as never written is written as one: no probe of index 0 for bee
  // to refuse. If that read was wrong, index 0 keeps its bytes and the write's
  // read-back throws; a walk past the real updates would have made this snapshot
  // the head. Should the read-back fail too, the write counts as done and this
  // process serves a snapshot nobody else can read until its next write, which
  // walks forward from index 1.
  await io.writePointer(encodeJsonFeed(pointer), neverWritten);
  _cache = { at: now(), snapshot };
  _rebuiltHere = true;
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
 * At boot: one strict read of the pointer feed.
 *  - Found: held for the display, and nothing is rebuilt. A restart is the worst
 *    moment to resolve every listed event again: a card whose content read
 *    missed would be published from its create-time seed and stay for 30 minutes.
 *  - Never written (a new feed generation): the first snapshot is published
 *    now, so requests are not left reading a feed that is not there.
 *  - Bee refusing the feed's first chunk: tried again past its one-minute
 *    window, twice.
 *  - Unreadable otherwise: left to the next trigger or reconcile.
 */
export async function startDirectoryAtBoot(
  retryIn: (ms: number, run: () => Promise<void>) => void = (ms, run) => void setTimeout(() => void run(), ms).unref?.(),
  retriesLeft = 2,
): Promise<void> {
  if (!directoryPublishingEnabled()) return;
  try {
    const read = await readBase();
    if (read.kind === "unreadable") {
      console.warn(`[startup] event directory: no readable snapshot (${read.why})`);
    } else {
      if (read.kind === "never-written") await rebuildSnapshot({ full: true, knownNeverWritten: true });
      console.log(`[startup] event directory ready (${_cache?.snapshot.cards.length ?? 0} entries)`);
    }
  } catch (err) {
    if (isStorageBusy(err) && retriesLeft > 0) {
      console.warn(`[startup] event directory: storage busy, trying again in ${Math.round(STORAGE_BUSY_RETRY_MS / 1000)}s`);
      retryIn(STORAGE_BUSY_RETRY_MS, () => startDirectoryAtBoot(retryIn, retriesLeft - 1));
      return;
    }
    console.warn("[startup] event directory could not be started:", err);
  }
  _bootSettled = true;
}

/** Rebuilds failing in a row before the directory counts as stuck: one or two are a bee hiccup. */
const STUCK_AFTER_FAILED_REBUILDS = 3;

/**
 * `/api/health` section. Red when:
 *  - this process does not publish. Right for a dev server, an alarm in
 *    production: `.env` there is the master copy, so one line would switch the
 *    directory off with only a log line to show for it;
 *  - boot is over and no snapshot is held (`cards` null): the directory is
 *    serving nothing, because it could be neither read nor created. Green again
 *    as soon as a read or a rebuild succeeds;
 *  - rebuilds keep failing: new and edited events are not reaching it.
 * Counts and booleans only: the endpoint is public.
 */
export function directoryHealth(): {
  ok: boolean;
  publishing: boolean;
  failedRebuilds: number;
  builtAt: string | null;
  cards: number | null;
} {
  const publishing = directoryPublishingEnabled();
  const servingNothing = _bootSettled && _cache === null;
  return {
    ok: publishing && !servingNothing && _failedRebuilds < STUCK_AFTER_FAILED_REBUILDS,
    publishing,
    failedRebuilds: _failedRebuilds,
    builtAt: _cache?.snapshot.builtAt ?? null,
    cards: _cache?.snapshot.cards.length ?? null,
  };
}

/** Read the directory now, then reconcile every 30 minutes. Idempotent; called once from server startup. */
export function startSnapshotMaintenance(): void {
  if (_maintenanceStarted) return;
  _maintenanceStarted = true;
  if (!directoryPublishingEnabled()) {
    console.log("[snapshot] DIRECTORY_PUBLISH=off: this process reads the public directory and never rebuilds it");
    return;
  }
  void startDirectoryAtBoot();
  setInterval(() => void rebuildSnapshotFull().catch(() => undefined), RECONCILE_INTERVAL_MS).unref?.();
}
