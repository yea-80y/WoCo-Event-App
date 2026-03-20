/**
 * Browser-side Waku event discovery.
 *
 * The browser connects directly to nwaku as a light node peer — no server
 * intermediary. This is the architecture we want long-term: every client is
 * a Waku peer, the server is only needed for Swarm writes.
 *
 * Discovery layers:
 * 1. SWARM (GET /api/events) — the authoritative event directory, loaded on startup.
 * 2. WAKU ANNOUNCEMENTS (Filter + Store) — real-time create/list/unlist signals.
 * 3. WAKU INDEX ANNOUNCEMENTS — discover other index providers on the network.
 * 4. WAKU CATEGORY TOPICS — subscribe to specific event categories.
 *
 * Waku = ephemeral signals, Swarm = permanent storage.
 * Graceful degradation: if Waku fails, the app falls back to GET /api/events.
 */
import type { EventDirectoryEntry } from "@woco/shared";
import {
  WAKU_CONTENT_TOPIC,
  WAKU_INDEX_ANNOUNCE_TOPIC,
  WAKU_SHARD_INDEX,
  wakuCategoryTopic,
  decodeEventAnnouncement,
  decodeIndexAnnouncement,
  type EventAnnouncement,
  type IndexAnnouncement,
} from "@woco/shared";
import { getWakuNode } from "./client.js";

// ---------------------------------------------------------------------------
// Reactive state (Svelte 5 runes)
// ---------------------------------------------------------------------------

/** Events from real-time Waku announcements (Filter + Store catch-up). */
let liveEvents = $state<Map<string, EventDirectoryEntry>>(new Map());

/** Discovered index providers from the network. */
let indexProviders = $state<Map<string, IndexAnnouncement>>(new Map());

/** Categories currently subscribed to via Filter. */
let subscribedCategories = $state<Set<string>>(new Set());

let _started = false;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Number of events known via Waku. */
export function getLiveEventCount(): number {
  return liveEvents.size;
}

/** Get discovered index providers (keyed by maintainer address). */
export function getIndexProviders(): IndexAnnouncement[] {
  return [...indexProviders.values()];
}

/**
 * Merge fetched events (from GET /api/events) with Waku-discovered events.
 * Server response takes priority (authoritative). Waku fills in anything
 * created/listed after the fetch.
 */
export function mergeWithLive(
  fetchedEntries: EventDirectoryEntry[],
): EventDirectoryEntry[] {
  if (liveEvents.size === 0) return fetchedEntries;

  const merged = new Map<string, EventDirectoryEntry>();
  for (const e of fetchedEntries) merged.set(e.eventId, e);
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
 * Start Waku discovery: connect to nwaku, query Store for recent announcements
 * and index providers, subscribe to real-time announcements via Filter.
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

    // Query Store for history and subscribe in parallel
    await Promise.all([
      queryStoreHistory(node),
      queryIndexProviders(node),
    ]);

    // Subscribe to real-time topics
    await Promise.all([
      subscribeAnnouncements(node),
      subscribeIndexAnnouncements(node),
    ]);
  } catch (err) {
    console.warn("[waku] Discovery failed:", err instanceof Error ? err.message : err);
    _started = false;
  }
}

/**
 * Subscribe to a category-specific topic for filtered event discovery.
 * Only subscribes once per category. Announcements are merged into liveEvents.
 */
export async function subscribeToCategory(category: string): Promise<void> {
  if (subscribedCategories.has(category)) return;

  try {
    const node = await getWakuNode();
    if (!node) return;

    const decoder = node.createDecoder({
      contentTopic: wakuCategoryTopic(category),
      shardId: WAKU_SHARD_INDEX,
    });

    await node.filter.subscribe([decoder], (msg) => {
      if (!msg.payload) return;
      const announcement = decodeEventAnnouncement(msg.payload);
      if (announcement) {
        processAnnouncement(announcement);
        console.log(`[waku][${category}] ${announcement.action}: "${announcement.title}"`);
      }
    });

    const next = new Set(subscribedCategories);
    next.add(category);
    subscribedCategories = next;
    console.log(`[waku] Subscribed to category: ${category}`);
  } catch (err) {
    console.warn(`[waku] Failed to subscribe to category ${category}:`, err instanceof Error ? err.message : err);
  }
}

/**
 * Stop Waku discovery.
 */
export async function stopEventStream(): Promise<void> {
  _started = false;
}

// ---------------------------------------------------------------------------
// Internal: Event announcements
// ---------------------------------------------------------------------------

function processAnnouncement(announcement: EventAnnouncement): void {
  if (announcement.action === "unlisted") {
    if (liveEvents.has(announcement.eventId)) {
      const next = new Map(liveEvents);
      next.delete(announcement.eventId);
      liveEvents = next;
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

  const next = new Map(liveEvents);
  next.set(entry.eventId, entry);
  liveEvents = next;
}

async function queryStoreHistory(node: import("@waku/sdk").LightNode): Promise<void> {
  try {
    const decoder = node.createDecoder({
      contentTopic: WAKU_CONTENT_TOPIC,
      shardId: WAKU_SHARD_INDEX,
    });
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);

    await node.store.queryWithOrderedCallback(
      [decoder],
      (msg) => {
        if (!msg.payload) return;
        const announcement = decodeEventAnnouncement(msg.payload);
        if (announcement) processAnnouncement(announcement);
      },
      { timeStart: cutoff, timeEnd: new Date() },
    );

    if (liveEvents.size > 0) {
      console.log(`[waku] Store catch-up: ${liveEvents.size} events from recent announcements`);
    }
  } catch (err) {
    console.warn("[waku] Store query failed:", err instanceof Error ? err.message : err);
  }
}

async function subscribeAnnouncements(node: import("@waku/sdk").LightNode): Promise<void> {
  const decoder = node.createDecoder({
    contentTopic: WAKU_CONTENT_TOPIC,
    shardId: WAKU_SHARD_INDEX,
  });

  await node.filter.subscribe([decoder], (msg) => {
    if (!msg.payload) return;
    const announcement = decodeEventAnnouncement(msg.payload);
    if (announcement) {
      processAnnouncement(announcement);
      console.log(`[waku] ${announcement.action}: "${announcement.title}"`);
    }
  });
}

// ---------------------------------------------------------------------------
// Internal: Index provider discovery
// ---------------------------------------------------------------------------

async function queryIndexProviders(node: import("@waku/sdk").LightNode): Promise<void> {
  try {
    const decoder = node.createDecoder({
      contentTopic: WAKU_INDEX_ANNOUNCE_TOPIC,
      shardId: WAKU_SHARD_INDEX,
    });
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);

    await node.store.queryWithOrderedCallback(
      [decoder],
      (msg) => {
        if (!msg.payload) return;
        const idx = decodeIndexAnnouncement(msg.payload);
        if (idx) processIndexAnnouncement(idx);
      },
      { timeStart: cutoff, timeEnd: new Date() },
    );

    if (indexProviders.size > 0) {
      console.log(`[waku] Discovered ${indexProviders.size} index provider(s) from Store`);
    }
  } catch (err) {
    console.warn("[waku] Index provider Store query failed:", err instanceof Error ? err.message : err);
  }
}

async function subscribeIndexAnnouncements(node: import("@waku/sdk").LightNode): Promise<void> {
  const decoder = node.createDecoder({
    contentTopic: WAKU_INDEX_ANNOUNCE_TOPIC,
    shardId: WAKU_SHARD_INDEX,
  });

  await node.filter.subscribe([decoder], (msg) => {
    if (!msg.payload) return;
    const idx = decodeIndexAnnouncement(msg.payload);
    if (idx) {
      processIndexAnnouncement(idx);
      console.log(`[waku] Index provider: ${idx.maintainer} (${idx.eventCount} events)`);
    }
  });
}

function processIndexAnnouncement(idx: IndexAnnouncement): void {
  const key = `${idx.maintainer}:${idx.swarmFeedTopic}`;
  const existing = indexProviders.get(key);
  // Only update if newer
  if (existing && existing.updatedAt >= idx.updatedAt) return;

  const next = new Map(indexProviders);
  next.set(key, idx);
  indexProviders = next;
}
