/**
 * Server-side Waku event discovery.
 *
 * The server acts as the Waku gateway: it subscribes to announcements via
 * Filter (real-time) and Store (history), maintains an in-memory map, and
 * exposes results via GET /api/events/waku-discovered.
 *
 * Browsers don't connect to nwaku directly — they fetch from this endpoint.
 */
import type { EventDirectoryEntry } from "@woco/shared";
import {
  WAKU_CONTENT_TOPIC,
  WAKU_SHARD_INDEX,
  decodeEventAnnouncement,
  type EventAnnouncement,
} from "@woco/shared";
import { getWakuNode, isWakuEnabled } from "./client.js";

/** Discovered events keyed by eventId. */
const wakuEvents = new Map<string, EventDirectoryEntry>();

let _started = false;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** All Waku-discovered events. */
export function getWakuDiscoveredEvents(): EventDirectoryEntry[] {
  return [...wakuEvents.values()];
}

/**
 * Start Waku discovery subscription. Call once at server startup.
 * Safe to call multiple times — only runs once.
 */
export async function startWakuDiscovery(): Promise<void> {
  if (_started || !isWakuEnabled()) return;
  _started = true;

  try {
    const node = await getWakuNode();
    if (!node) {
      console.warn("[waku-discovery] No Waku node available, discovery disabled");
      _started = false;
      return;
    }

    // 1. Query Store for recent historical announcements (last 48 hours)
    await queryHistory(node);

    // 2. Subscribe for real-time announcements
    await subscribeRealtime(node);

    console.log(`[waku-discovery] Active — ${wakuEvents.size} event(s) from history`);
  } catch (err) {
    console.error("[waku-discovery] Failed to start:", err instanceof Error ? err.message : err);
    _started = false;
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function processAnnouncement(announcement: EventAnnouncement): void {
  if (announcement.action === "unlisted") {
    wakuEvents.delete(announcement.eventId);
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

  wakuEvents.set(entry.eventId, entry);
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
  } catch (err) {
    console.warn("[waku-discovery] Store query failed:", err instanceof Error ? err.message : err);
  }
}

async function subscribeRealtime(node: import("@waku/sdk").LightNode): Promise<void> {
  const decoder = node.createDecoder({ contentTopic: WAKU_CONTENT_TOPIC, shardId: WAKU_SHARD_INDEX });

  const callback = (msg: { payload?: Uint8Array }): void => {
    if (!msg.payload) return;
    const announcement = decodeEventAnnouncement(msg.payload);
    if (announcement) {
      processAnnouncement(announcement);
      console.log(`[waku-discovery] Received: ${announcement.action} ${announcement.eventId} "${announcement.title}"`);
    }
  };

  await node.filter.subscribe([decoder], callback);
}
