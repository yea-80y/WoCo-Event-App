/**
 * Browser-side Waku event discovery.
 *
 * The browser connects directly to nwaku as a light node peer — no server
 * intermediary. This is the architecture we want long-term: every client is
 * a Waku peer, the server is only needed for Swarm writes.
 *
 * Discovery works in two layers:
 * 1. CATALOG (Store query) — the server periodically publishes the full event
 *    directory. Browser queries Store for the latest catalog on startup,
 *    getting ALL events regardless of age.
 * 2. ANNOUNCEMENTS (Filter subscription) — real-time create/list/unlist events
 *    that arrive between catalog publishes. These appear instantly in the UI.
 *
 * Graceful degradation: if Waku fails, the app falls back to GET /api/events.
 */
import type { EventDirectoryEntry } from "@woco/shared";
import {
  WAKU_CONTENT_TOPIC,
  WAKU_CATALOG_TOPIC,
  WAKU_SHARD_INDEX,
  decodeEventAnnouncement,
  decodeEventCatalog,
  type EventAnnouncement,
} from "@woco/shared";
import { getWakuNode } from "./client.js";

// ---------------------------------------------------------------------------
// Reactive state (Svelte 5 runes)
// ---------------------------------------------------------------------------

/** Events from the latest catalog (full directory snapshot). */
let catalogEvents = $state<Map<string, EventDirectoryEntry>>(new Map());

/** Events from real-time announcements received after the catalog. */
let liveEvents = $state<Map<string, EventDirectoryEntry>>(new Map());

/** Timestamp of the latest catalog we've received. */
let catalogTimestamp = $state<string | null>(null);

let _started = false;
let _wakuNode: import("@waku/sdk").LightNode | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Number of events known via Waku (catalog + live). */
export function getLiveEventCount(): number {
  return catalogEvents.size + liveEvents.size;
}

/**
 * Merge fetched events (from GET /api/events) with Waku-discovered events.
 * The combined Waku set (catalog + live announcements) fills in anything
 * the server response didn't include.
 */
export function mergeWithLive(
  fetchedEntries: EventDirectoryEntry[],
): EventDirectoryEntry[] {
  if (catalogEvents.size === 0 && liveEvents.size === 0) return fetchedEntries;

  const merged = new Map<string, EventDirectoryEntry>();
  // Server response takes priority (it's the most authoritative)
  for (const e of fetchedEntries) merged.set(e.eventId, e);
  // Catalog fills in anything the server didn't have
  for (const [id, e] of catalogEvents) {
    if (!merged.has(id)) merged.set(id, e);
  }
  // Live announcements (newest) fill in anything created after the fetch
  for (const [id, e] of liveEvents) {
    if (!merged.has(id)) merged.set(id, e);
  }
  return [...merged.values()];
}

/** Clear the live events buffer (call after a full refresh from the server). */
export function clearLiveEvents(): void {
  liveEvents = new Map();
}

/**
 * Start Waku discovery: connect to nwaku, load catalog, subscribe to announcements.
 * Safe to call multiple times — only runs once.
 */
export async function startEventStream(): Promise<void> {
  if (_started) return;
  _started = true;

  try {
    const node = await getWakuNode();
    if (!node) {
      _started = false;
      return;
    }
    _wakuNode = node;

    // 1. Query Store for the latest catalog (full event directory)
    await loadCatalog(node);

    // 2. Subscribe to real-time announcements + catalog updates via Filter
    await subscribeRealtime(node);
  } catch (err) {
    console.warn("[waku] Discovery failed:", err instanceof Error ? err.message : err);
    _started = false;
  }
}

/**
 * Stop Waku discovery.
 */
export async function stopEventStream(): Promise<void> {
  _started = false;
}

// ---------------------------------------------------------------------------
// Internal: Catalog (full directory from Store)
// ---------------------------------------------------------------------------

async function loadCatalog(node: import("@waku/sdk").LightNode): Promise<void> {
  try {
    const decoder = node.createDecoder({
      contentTopic: WAKU_CATALOG_TOPIC,
      shardId: WAKU_SHARD_INDEX,
    });

    let latestTimestamp = "";
    let latestEntries: EventDirectoryEntry[] = [];

    await node.store.queryWithOrderedCallback(
      [decoder],
      (msg) => {
        if (!msg.payload) return;
        const catalog = decodeEventCatalog(msg.payload);
        if (!catalog) return;
        // Keep only the most recent catalog
        if (catalog.publishedAt > latestTimestamp) {
          latestTimestamp = catalog.publishedAt;
          latestEntries = catalog.entries.map((e) => ({
            eventId: e.eventId,
            title: e.title,
            imageHash: e.imageHash,
            startDate: e.startDate,
            location: e.location,
            creatorAddress: e.creatorAddress as `0x${string}`,
            seriesCount: e.seriesCount,
            totalTickets: e.totalTickets,
            createdAt: e.createdAt,
            ...(e.apiUrl ? { apiUrl: e.apiUrl } : {}),
          }));
        }
      },
      { timeStart: new Date(Date.now() - 48 * 60 * 60 * 1000), timeEnd: new Date() },
    );

    if (latestEntries.length > 0) {
      const next = new Map<string, EventDirectoryEntry>();
      for (const e of latestEntries) next.set(e.eventId, e);
      catalogEvents = next;
      catalogTimestamp = latestTimestamp;
      console.log(`[waku] Loaded catalog: ${latestEntries.length} events (published ${latestTimestamp})`);
    }
  } catch (err) {
    console.warn("[waku] Catalog query failed:", err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// Internal: Real-time announcements + catalog updates (Filter)
// ---------------------------------------------------------------------------

function processAnnouncement(announcement: EventAnnouncement): void {
  if (announcement.action === "unlisted") {
    // Remove from both catalog and live
    let changed = false;
    if (catalogEvents.has(announcement.eventId)) {
      const next = new Map(catalogEvents);
      next.delete(announcement.eventId);
      catalogEvents = next;
      changed = true;
    }
    if (liveEvents.has(announcement.eventId)) {
      const next = new Map(liveEvents);
      next.delete(announcement.eventId);
      liveEvents = next;
      changed = true;
    }
    return;
  }

  const entry: EventDirectoryEntry = {
    eventId: announcement.eventId,
    title: announcement.title,
    imageHash: announcement.imageHash,
    startDate: announcement.startDate,
    location: announcement.location,
    creatorAddress: announcement.creatorAddress as `0x${string}`,
    seriesCount: announcement.seriesCount,
    totalTickets: announcement.totalTickets,
    createdAt: announcement.createdAt,
    ...(announcement.apiUrl ? { apiUrl: announcement.apiUrl } : {}),
  };

  // Add to live events (not catalog — catalog comes from the server's periodic publish)
  const next = new Map(liveEvents);
  next.set(entry.eventId, entry);
  liveEvents = next;
}

async function subscribeRealtime(node: import("@waku/sdk").LightNode): Promise<void> {
  // Subscribe to both announcements AND catalog updates
  const announceDecoder = node.createDecoder({
    contentTopic: WAKU_CONTENT_TOPIC,
    shardId: WAKU_SHARD_INDEX,
  });
  const catalogDecoder = node.createDecoder({
    contentTopic: WAKU_CATALOG_TOPIC,
    shardId: WAKU_SHARD_INDEX,
  });

  // Announcement handler
  await node.filter.subscribe([announceDecoder], (msg) => {
    if (!msg.payload) return;
    const announcement = decodeEventAnnouncement(msg.payload);
    if (announcement) {
      processAnnouncement(announcement);
      console.log(`[waku] ${announcement.action}: "${announcement.title}"`);
    }
  });

  // Catalog handler — replaces the full catalog when a new one arrives
  await node.filter.subscribe([catalogDecoder], (msg) => {
    if (!msg.payload) return;
    const catalog = decodeEventCatalog(msg.payload);
    if (!catalog) return;
    // Only accept if newer than what we have
    if (catalogTimestamp && catalog.publishedAt <= catalogTimestamp) return;

    const next = new Map<string, EventDirectoryEntry>();
    for (const e of catalog.entries) {
      next.set(e.eventId, {
        eventId: e.eventId,
        title: e.title,
        imageHash: e.imageHash,
        startDate: e.startDate,
        location: e.location,
        creatorAddress: e.creatorAddress as `0x${string}`,
        seriesCount: e.seriesCount,
        totalTickets: e.totalTickets,
        createdAt: e.createdAt,
        ...(e.apiUrl ? { apiUrl: e.apiUrl } : {}),
      });
    }
    catalogEvents = next;
    catalogTimestamp = catalog.publishedAt;
    // Clear live events — the new catalog includes them
    liveEvents = new Map();
    console.log(`[waku] Updated catalog: ${catalog.entries.length} events`);
  });
}
