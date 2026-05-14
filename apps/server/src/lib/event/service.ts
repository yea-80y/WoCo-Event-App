import type {
  Hex64, Hex0x, EventFeed, EventDirectoryEntry, SeriesSummary,
  OrderField, ClaimMode, SeriesManifestBlob,
  SignedManifestV1, PodV2Body,
} from "@woco/shared";
import { verifySignedManifest, buildPodTree, manifestDigest, bytesToHex0x } from "@woco/shared";
import { uploadToBytes } from "../swarm/bytes.js";
import {
  readFeedPage,
  readFeedPageWithRetry,
  writeFeedPage,
  encodeJsonFeed,
  decodeJsonFeed,
} from "../swarm/feeds.js";
import {
  topicEventDirectory,
  topicCreatorDirectory,
  topicEvent,
} from "../swarm/topics.js";

// ---------------------------------------------------------------------------
// Create event (v2 — manifest-based, on-chain)
// ---------------------------------------------------------------------------

export interface CreateProgress {
  type: "progress";
  phase: string;
  current: number;
  total: number;
  message: string;
}

export async function createEventV2(opts: {
  eventId: string;
  title: string;
  tagline?: string;
  description: string;
  startDate: string;
  endDate: string;
  location: string;
  creatorAddress: Hex0x;
  creatorPodKey: string;
  imageData: Uint8Array;
  series: Array<{
    seriesId: string;
    name: string;
    description: string;
    totalSupply: number;
    signedManifest: SignedManifestV1;
    podBodies: PodV2Body[];
    approvalRequired?: boolean;
    wave?: string;
    saleStart?: string;
    saleEnd?: string;
    payment?: import("@woco/shared").PaymentConfig;
  }>;
  encryptionKey?: string;
  orderFields?: OrderField[];
  claimMode?: ClaimMode;
  skipAutoList?: boolean;
  onProgress?: (p: CreateProgress) => void;
}): Promise<EventFeed> {
  const {
    eventId, title, tagline, description, startDate, endDate, location,
    creatorAddress, creatorPodKey, imageData, series,
    encryptionKey, orderFields, claimMode, skipAutoList, onProgress,
  } = opts;

  const emit = (phase: string, current: number, total: number, message: string) =>
    onProgress?.({ type: "progress", phase, current, total, message });

  const tStart = Date.now();
  const createdAt = new Date().toISOString();
  const totalPods = series.reduce((n, s) => n + s.totalSupply, 0);

  // ── Validate all manifests before touching Swarm ─────────────────────
  for (const s of series) {
    if (s.podBodies.length !== s.totalSupply) {
      throw new Error(`Series ${s.seriesId}: expected ${s.totalSupply} pod bodies, got ${s.podBodies.length}`);
    }
    if (!verifySignedManifest(s.signedManifest)) {
      throw new Error(`Series ${s.seriesId}: manifest signature invalid`);
    }
    const { root } = buildPodTree(s.podBodies);
    if (root.toLowerCase() !== s.signedManifest.body.metadataRoot.toLowerCase()) {
      throw new Error(`Series ${s.seriesId}: Merkle root mismatch — pod bodies don't match manifest`);
    }
  }

  // ── Phase 1: Upload image (start immediately) ─────────────────────────
  emit("image", 0, 1, "Uploading event image...");
  const imagePromise = uploadToBytes(imageData);

  // ── Phase 2: Upload pod bodies for all series ─────────────────────────
  emit("pods", 0, totalPods, "Uploading pod bodies...");
  let podsUploaded = 0;
  const BATCH = 40;

  const podRefsBySeries = new Map<string, Hex64[]>();
  for (const s of series) {
    const refs: Hex64[] = [];
    for (let i = 0; i < s.podBodies.length; i += BATCH) {
      const batch = s.podBodies.slice(i, i + BATCH);
      const batchRefs = await Promise.all(batch.map((p) => uploadToBytes(JSON.stringify(p))));
      refs.push(...batchRefs);
      podsUploaded += batchRefs.length;
      emit("pods", podsUploaded, totalPods, `Uploading pods: ${podsUploaded}/${totalPods}`);
    }
    podRefsBySeries.set(s.seriesId, refs);
  }

  const imageHash = await imagePromise;
  emit("image", 1, 1, "Image uploaded");

  // ── Phase 3: Upload SeriesManifestBlob per series ─────────────────────
  emit("manifests", 0, series.length, "Uploading manifests...");

  const seriesSummaries: SeriesSummary[] = await Promise.all(
    series.map(async (s, i) => {
      const podRefs = podRefsBySeries.get(s.seriesId)!;
      const digestBytes = manifestDigest(s.signedManifest.body);
      const manifestDigestHex = bytesToHex0x(digestBytes);

      const blob: SeriesManifestBlob = {
        v: 2,
        signedManifest: s.signedManifest,
        podRefs,
        manifestDigestHex,
      };
      const swarmManifestRef = await uploadToBytes(JSON.stringify(blob));
      emit("manifests", i + 1, series.length, `Manifests: ${i + 1}/${series.length}`);

      return {
        seriesId: s.seriesId,
        name: s.name,
        description: s.description,
        totalSupply: s.totalSupply,
        price: s.payment ? parseFloat(s.payment.price) : 0,
        swarmManifestRef,
        manifestRef: manifestDigestHex,
        ...(s.approvalRequired ? { approvalRequired: true } : {}),
        ...(s.wave ? { wave: s.wave } : {}),
        ...(s.saleStart ? { saleStart: s.saleStart } : {}),
        ...(s.saleEnd ? { saleEnd: s.saleEnd } : {}),
        ...(s.payment ? { payment: s.payment } : {}),
      } as SeriesSummary;
    }),
  );

  // ── Phase 4: Write event feed ─────────────────────────────────────────
  const eventFeed: EventFeed = {
    v: 1,
    eventId,
    title,
    ...(tagline ? { tagline } : {}),
    description,
    imageHash,
    startDate,
    endDate,
    location,
    creatorAddress,
    creatorPodKey,
    series: seriesSummaries,
    createdAt,
    ...(encryptionKey ? { encryptionKey } : {}),
    ...(orderFields?.length ? { orderFields } : {}),
    ...(claimMode && claimMode !== "wallet" ? { claimMode } : {}),
  };

  emit("finalize", 0, 1, "Writing event feed...");
  await writeFeedPage(topicEvent(eventId), encodeJsonFeed(eventFeed), { fresh: true });
  invalidateEventCache(eventId);

  // ── Update directories (fire-and-forget) ─────────────────────────────
  const totalTickets = series.reduce((n, s) => n + s.totalSupply, 0);
  addToEventDirectory(
    { eventId, title, ...(tagline ? { tagline } : {}), imageHash, startDate, endDate, location, creatorAddress, seriesCount: series.length, totalTickets, createdAt },
    { skipPublicDirectory: !!skipAutoList },
  ).catch((err) => console.error("[event] Directory update failed (non-critical):", err));

  emit("finalize", 1, 1, "Event published!");
  console.log(`[event] v2 event created — ${eventId} (${series.length} series, ${totalPods} pods, ${Date.now() - tStart}ms)`);
  return eventFeed;
}

// ---------------------------------------------------------------------------
// Update on-chain registration for a series (called after registerEvent tx)
// ---------------------------------------------------------------------------

export async function confirmSeriesOnChain(
  eventId: string,
  seriesId: string,
  onChainEventId: string,
): Promise<EventFeed> {
  const feed = await getEvent(eventId);
  if (!feed) throw new Error("Event not found");

  const updated: EventFeed = {
    ...feed,
    series: feed.series.map((s) =>
      s.seriesId === seriesId ? { ...s, onChainEventId } : s,
    ),
  };

  await writeFeedPage(topicEvent(eventId), encodeJsonFeed(updated));
  invalidateEventCache(eventId);
  return updated;
}

// ---------------------------------------------------------------------------
// Read events
// ---------------------------------------------------------------------------

// 2-minute TTL cache — avoids repeat Swarm reads when multiple attendees
// hit create-checkout for the same event in a short window. Cache is
// explicitly invalidated on publish/update (see invalidateEventCache), so a
// longer TTL is safe and significantly reduces Swarm read pressure under
// bursty buy traffic.
const _eventCache = new Map<string, { feed: EventFeed; expiresAt: number }>();
const EVENT_CACHE_TTL_MS = 10 * 60_000;

export async function getEvent(eventId: string): Promise<EventFeed | null> {
  const now = Date.now();
  const cached = _eventCache.get(eventId);
  if (cached && cached.expiresAt > now) return cached.feed;

  const page = await readFeedPageWithRetry(topicEvent(eventId));
  if (!page) return null;
  const feed = decodeJsonFeed<EventFeed>(page);
  if (feed) {
    _eventCache.set(eventId, { feed, expiresAt: now + EVENT_CACHE_TTL_MS });
    for (const s of feed.series) {
      console.log(`[event] Read series "${s.name}" payment:`, s.payment ? JSON.stringify(s.payment) : "FREE");
    }
  }
  return feed;
}

/** Invalidate the event cache after a publish/update so the next read is fresh. */
export function invalidateEventCache(eventId: string): void {
  _eventCache.delete(eventId);
}

interface EventDirectory {
  v: 1;
  entries: EventDirectoryEntry[];
  updatedAt: string;
  /** Number of overflow pages (0 = all entries fit on page 0) */
  pages?: number;
}

/** Max JSON bytes per directory page (must fit in a single 4096-byte Bee chunk). */
const DIR_PAGE_LIMIT = 4096;

// ---------------------------------------------------------------------------
// In-memory directory cache
// ---------------------------------------------------------------------------
// Avoids re-reading Swarm feeds on every GET /api/events request.
// The cache is populated on the first read and kept in sync by
// addToEventDirectory / removeEventFromDirectory.

let _dirCache: EventDirectoryEntry[] | null = null;

/** Read directory from Swarm (used on first call and cache miss). */
async function readDirectoryFromSwarm(): Promise<EventDirectoryEntry[]> {
  const page0 = await readFeedPage(topicEventDirectory());
  if (!page0) return [];
  const dir = decodeJsonFeed<EventDirectory>(page0);
  if (!dir) return [];

  const all = [...dir.entries];

  const totalPages = dir.pages ?? 0;
  for (let p = 1; p <= totalPages; p++) {
    const pageData = await readFeedPage(topicEventDirectory(p));
    if (!pageData) break;
    const overflow = decodeJsonFeed<EventDirectory>(pageData);
    if (overflow?.entries) all.push(...overflow.entries);
  }

  return all;
}

export async function listEvents(): Promise<EventDirectoryEntry[]> {
  if (_dirCache !== null) return _dirCache;
  _dirCache = await readDirectoryFromSwarm();
  return _dirCache;
}

// ---------------------------------------------------------------------------
// Directory helpers
// ---------------------------------------------------------------------------

export { addToEventDirectory as addEventToDirectory };

/** Strip empty/default fields to keep directory entries small (must fit in 4096-byte Bee chunk). */
function compactEntry(e: EventDirectoryEntry): EventDirectoryEntry {
  const compact: Record<string, unknown> = {
    eventId: e.eventId,
    title: e.title,
    imageHash: e.imageHash,
    startDate: e.startDate,
    creatorAddress: e.creatorAddress,
    seriesCount: e.seriesCount,
    totalTickets: e.totalTickets,
    createdAt: e.createdAt,
  };
  if (e.endDate) compact.endDate = e.endDate;
  if (e.location) compact.location = e.location;
  if (e.apiUrl) compact.apiUrl = e.apiUrl;
  if (e.tagline) compact.tagline = e.tagline;
  return compact as unknown as EventDirectoryEntry;
}

/**
 * Returns true if the organiser has at least one event that has demonstrably
 * completed (endDate, or startDate as fallback, + 24 hours is in the past).
 * Used to decide whether to force escrow on new paid events.
 */
export async function isOrganiserTrusted(creatorAddress: string): Promise<boolean> {
  const events = await getCreatorEvents(creatorAddress);
  const now = Date.now();
  const twentyFourHoursMs = 24 * 60 * 60 * 1000;
  return events.some((e) => {
    const completionDate = e.endDate ?? e.startDate;
    const completionTime = new Date(completionDate).getTime();
    return completionTime + twentyFourHoursMs < now;
  });
}

/**
 * Write a directory (page 0 + overflow pages) to paginated feeds.
 * Each page stays within DIR_PAGE_LIMIT so bee-js uses the direct SOC path.
 */
async function writeDirectoryPages(
  allEntries: EventDirectoryEntry[],
  updatedAt: string,
  topicFn: (page: number) => import("@ethersphere/bee-js").Topic,
): Promise<void> {
  const compact = allEntries.map(compactEntry);

  // Split entries across pages that fit within 4096 bytes each
  const pages: EventDirectoryEntry[][] = [];
  let current: EventDirectoryEntry[] = [];
  for (const entry of compact) {
    current.push(entry);
    const testDir: EventDirectory = {
      v: 1,
      entries: current,
      updatedAt,
      ...(pages.length > 0 ? {} : { pages: pages.length }),
    };
    if (JSON.stringify(testDir).length > DIR_PAGE_LIMIT) {
      current.pop();
      if (current.length > 0) pages.push(current);
      current = [entry];
    }
  }
  if (current.length > 0) pages.push(current);

  // Write page 0 with the page count
  const page0: EventDirectory = {
    v: 1,
    entries: pages[0] ?? [],
    updatedAt,
    pages: pages.length - 1, // number of OVERFLOW pages
  };
  await writeFeedPage(topicFn(0), encodeJsonFeed(page0));

  // Write overflow pages
  for (let p = 1; p < pages.length; p++) {
    const overflow: EventDirectory = { v: 1, entries: pages[p], updatedAt };
    await writeFeedPage(topicFn(p), encodeJsonFeed(overflow));
  }
}

async function addToEventDirectory(
  entry: EventDirectoryEntry,
  opts: { skipPublicDirectory?: boolean } = {},
): Promise<void> {
  // Write to global public directory (skipped for site-builder events until explicitly listed)
  if (!opts.skipPublicDirectory) {
    const allEntries = await listEvents();
    if (!allEntries.some((e) => e.eventId === entry.eventId)) {
      allEntries.unshift(entry);
      // Update cache immediately so GET /api/events returns the new event
      _dirCache = [...allEntries];
      const updatedAt = new Date().toISOString();
      await writeDirectoryPages(allEntries, updatedAt, topicEventDirectory);
      console.log(`[event] Directory updated: ${allEntries.length} events`);
    }
  }

  // Also write to per-creator index (never removed from — listing status doesn't affect organiser view)
  const creatorEntries = await getCreatorEvents(entry.creatorAddress);
  if (!creatorEntries.some((e) => e.eventId === entry.eventId)) {
    creatorEntries.unshift(entry);
    const updatedAt = new Date().toISOString();
    await writeDirectoryPages(
      creatorEntries,
      updatedAt,
      (p) => topicCreatorDirectory(entry.creatorAddress, p),
    );
    console.log(`[event] Creator index updated for ${entry.creatorAddress}: ${creatorEntries.length} events`);
  }
}

export async function getCreatorEvents(ethAddress: string): Promise<EventDirectoryEntry[]> {
  const page0 = await readFeedPage(topicCreatorDirectory(ethAddress));
  if (!page0) return [];
  const dir = decodeJsonFeed<EventDirectory>(page0);
  if (!dir) return [];

  const all = [...dir.entries];
  const totalPages = dir.pages ?? 0;
  for (let p = 1; p <= totalPages; p++) {
    const pageData = await readFeedPage(topicCreatorDirectory(ethAddress, p));
    if (!pageData) break;
    const overflow = decodeJsonFeed<EventDirectory>(pageData);
    if (overflow?.entries) all.push(...overflow.entries);
  }
  return all;
}

export async function removeEventFromDirectory(eventId: string): Promise<void> {
  const allEntries = await listEvents();
  const before = allEntries.length;
  const filtered = allEntries.filter((e) => e.eventId !== eventId);
  if (filtered.length === before) return; // not in directory

  // Update cache immediately
  _dirCache = filtered;
  const updatedAt = new Date().toISOString();
  await writeDirectoryPages(filtered, updatedAt, topicEventDirectory);
  console.log(`[event] Directory updated (removed ${eventId}): ${filtered.length} events`);
}
