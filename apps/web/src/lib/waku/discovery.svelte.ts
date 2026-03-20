/**
 * Browser-side Waku event discovery.
 *
 * The browser connects directly to nwaku as a light node peer — no server
 * intermediary. This is the architecture we want long-term: every client is
 * a Waku peer, the server is only needed for Swarm writes.
 *
 * Discovery works in two layers:
 * 1. SWARM (GET /api/events) — the authoritative event directory, loaded on startup.
 * 2. WAKU ANNOUNCEMENTS (Filter subscription + Store catch-up) — real-time
 *    create/list/unlist signals that appear instantly in the UI.
 *
 * Waku is NOT a database. The Swarm directory feed IS the catalog.
 * Waku = ephemeral signals, Swarm = permanent storage.
 *
 * Graceful degradation: if Waku fails, the app falls back to GET /api/events.
 */
import type { EventDirectoryEntry } from "@woco/shared";
import {
  WAKU_CONTENT_TOPIC,
  WAKU_SHARD_INDEX,
  decodeEventAnnouncement,
  type EventAnnouncement,
} from "@woco/shared";
import { getWakuNode } from "./client.js";

// ---------------------------------------------------------------------------
// Reactive state (Svelte 5 runes)
// ---------------------------------------------------------------------------

/** Events from real-time Waku announcements (Filter + Store catch-up). */
let liveEvents = $state<Map<string, EventDirectoryEntry>>(new Map());

let _started = false;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Number of events known via Waku. */
export function getLiveEventCount(): number {
  return liveEvents.size;
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
 * Start Waku discovery: connect to nwaku, query Store for recent announcements,
 * subscribe to real-time announcements via Filter.
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

    // 1. Query Store for recent announcements (catch-up for last 48h)
    await queryStoreHistory(node);

    // 2. Subscribe to real-time announcements via Filter
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
// Internal
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

async function subscribeRealtime(node: import("@waku/sdk").LightNode): Promise<void> {
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
