/**
 * Browser-side Waku event discovery.
 *
 * The browser connects directly to nwaku as a light node peer — no server
 * intermediary. This is the architecture we want long-term: every client is
 * a Waku peer, the server is only needed for Swarm writes.
 *
 * - Filter subscription: real-time announcements (events appear instantly)
 * - Store query: historical announcements (events from the last 48h)
 * - Graceful degradation: if Waku fails, the app works with Swarm directory only
 */
import type { EventDirectoryEntry } from "@woco/shared";
import {
  WAKU_CONTENT_TOPIC,
  WAKU_SHARD_INDEX,
  decodeEventAnnouncement,
  type EventAnnouncement,
} from "@woco/shared";
import { getWakuNode, stopWakuNode } from "./client.js";

// ---------------------------------------------------------------------------
// Reactive state (Svelte 5 runes)
// ---------------------------------------------------------------------------

/** Discovered events keyed by eventId */
let wakuEvents = $state<Map<string, EventDirectoryEntry>>(new Map());

let _started = false;
let _filterDecoder: import("@waku/sdk").IDecoder<import("@waku/sdk").IDecodedMessage> | null = null;
let _wakuNode: import("@waku/sdk").LightNode | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Get all Waku-discovered events as an array. */
export function getLiveEvents(): EventDirectoryEntry[] {
  return [...wakuEvents.values()];
}

/** Number of live events discovered via Waku. */
export function getLiveEventCount(): number {
  return wakuEvents.size;
}

/**
 * Merge fetched events with Waku-discovered events.
 * Fetched list (from GET /api/events) takes priority on duplicates.
 */
export function mergeWithLive(
  fetchedEntries: EventDirectoryEntry[],
): EventDirectoryEntry[] {
  if (wakuEvents.size === 0) return fetchedEntries;

  const merged = new Map<string, EventDirectoryEntry>();
  for (const e of fetchedEntries) merged.set(e.eventId, e);
  for (const [id, e] of wakuEvents) {
    if (!merged.has(id)) merged.set(id, e);
  }
  return [...merged.values()];
}

/** Clear the live events buffer (call after a full refresh from the server). */
export function clearLiveEvents(): void {
  wakuEvents = new Map();
}

/**
 * Start Waku discovery: connect to nwaku, query history, subscribe to real-time.
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

    // Query Store for recent historical announcements (last 48h)
    await queryHistory(node);

    // Subscribe to real-time announcements via Filter
    _wakuNode = node;
    await subscribeRealtime(node);
  } catch (err) {
    console.warn("[waku] Discovery failed:", err instanceof Error ? err.message : err);
    _started = false;
  }
}

/**
 * Stop Waku discovery and disconnect.
 */
export async function stopEventStream(): Promise<void> {
  if (_filterDecoder && _wakuNode) {
    try { await _wakuNode.filter.unsubscribe(_filterDecoder); } catch { /* ignore */ }
    _filterDecoder = null;
  }
  _started = false;
  // Don't stop the node here — other features may use it in the future
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function processAnnouncement(announcement: EventAnnouncement): void {
  if (announcement.action === "unlisted") {
    if (wakuEvents.has(announcement.eventId)) {
      const next = new Map(wakuEvents);
      next.delete(announcement.eventId);
      wakuEvents = next;
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

  // Create new Map to trigger Svelte 5 reactivity
  const next = new Map(wakuEvents);
  next.set(entry.eventId, entry);
  wakuEvents = next;
}

async function queryHistory(node: import("@waku/sdk").LightNode): Promise<void> {
  try {
    const decoder = node.createDecoder({ contentTopic: WAKU_CONTENT_TOPIC, shardId: WAKU_SHARD_INDEX });
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

    if (wakuEvents.size > 0) {
      console.log(`[waku] Loaded ${wakuEvents.size} event(s) from history`);
    }
  } catch (err) {
    console.warn("[waku] Store query failed:", err instanceof Error ? err.message : err);
  }
}

async function subscribeRealtime(node: import("@waku/sdk").LightNode): Promise<void> {
  const decoder = node.createDecoder({ contentTopic: WAKU_CONTENT_TOPIC, shardId: WAKU_SHARD_INDEX });

  const callback = (msg: { payload?: Uint8Array }): void => {
    if (!msg.payload) return;
    const announcement = decodeEventAnnouncement(msg.payload);
    if (announcement) {
      processAnnouncement(announcement);
      console.log(`[waku] ${announcement.action}: "${announcement.title}"`);
    }
  };

  _filterDecoder = decoder;
  await node.filter.subscribe([decoder], callback);
}
