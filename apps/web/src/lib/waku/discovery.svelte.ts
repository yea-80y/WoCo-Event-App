/**
 * Waku-based decentralized event discovery — Svelte 5 rune store.
 *
 * Subscribes to the Waku event announcement topic and maintains an in-memory
 * map of discovered events. The frontend merges this with the Swarm directory
 * for a unified event listing.
 *
 * Key principles:
 * - Graceful degradation: if Waku fails, the app works exactly as before
 * - Swarm directory is authoritative; Waku only adds events not in Swarm
 * - Lazy init: Waku SDK is dynamically imported on first use
 * - Singleton subscription: multiple components share one subscription
 */
import type { EventDirectoryEntry } from "@woco/shared";
import {
  WAKU_CONTENT_TOPIC,
  decodeEventAnnouncement,
  type EventAnnouncement,
} from "@woco/shared";
import { getWakuNode } from "./client.js";

// ---------------------------------------------------------------------------
// Reactive state (Svelte 5 runes)
// ---------------------------------------------------------------------------

/** Discovered events keyed by eventId */
let wakuEvents = $state<Map<string, EventDirectoryEntry>>(new Map());

/** True once the Waku node is connected and subscribed */
let wakuReady = $state(false);

/** Error message if Waku init failed (null = no error or not started) */
let wakuError = $state<string | null>(null);

/** True while Waku is connecting (loading state) */
let wakuConnecting = $state(false);

let _started = false;
let _filterNode: import("@waku/sdk").LightNode | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Get all Waku-discovered events as an array. */
export function getWakuDiscoveredEvents(): EventDirectoryEntry[] {
  return [...wakuEvents.values()];
}

/** Number of events discovered via Waku that aren't in the Swarm directory. */
export function getWakuEventCount(): number {
  return wakuEvents.size;
}

/** Whether Waku discovery is connected and receiving. */
export function isWakuReady(): boolean {
  return wakuReady;
}

/** Whether Waku is currently connecting. */
export function isWakuConnecting(): boolean {
  return wakuConnecting;
}

/** Error string if Waku failed, null otherwise. */
export function getWakuError(): string | null {
  return wakuError;
}

/**
 * Merge Swarm directory entries with Waku-discovered entries.
 * Swarm is authoritative — Waku only adds events not already in Swarm.
 */
export function mergeWithWaku(
  swarmEntries: EventDirectoryEntry[],
): EventDirectoryEntry[] {
  const merged = new Map<string, EventDirectoryEntry>();

  // Swarm directory entries take priority
  for (const e of swarmEntries) {
    merged.set(e.eventId, e);
  }

  // Add Waku-discovered events not in Swarm
  for (const [id, e] of wakuEvents) {
    if (!merged.has(id)) {
      merged.set(id, e);
    }
  }

  return [...merged.values()];
}

/**
 * Start Waku discovery. Safe to call multiple times — only runs once.
 */
export async function startWakuDiscovery(): Promise<void> {
  if (_started) return;
  _started = true;
  wakuConnecting = true;
  wakuError = null;

  try {
    const node = await getWakuNode();
    if (!node) {
      wakuError = "Could not connect to Waku network";
      wakuConnecting = false;
      return;
    }

    // 1. Query Store for recent historical announcements (last 48 hours)
    await queryHistory(node);

    // 2. Subscribe for real-time announcements
    await subscribeRealtime(node);

    wakuReady = true;
    wakuConnecting = false;
    console.log(`[waku] Discovery active — ${wakuEvents.size} event(s) from history`);
  } catch (err) {
    wakuError = err instanceof Error ? err.message : "Waku discovery failed";
    wakuConnecting = false;
    console.warn("[waku] Discovery failed:", wakuError);
  }
}

/**
 * Stop Waku discovery and clean up subscriptions.
 */
export async function stopWakuDiscovery(): Promise<void> {
  if (_filterNode) {
    try {
      _filterNode.filter.unsubscribeAll();
    } catch { /* ignore */ }
    _filterNode = null;
  }
  wakuReady = false;
  _started = false;
}

// ---------------------------------------------------------------------------
// Internal: process announcements
// ---------------------------------------------------------------------------

function processAnnouncement(announcement: EventAnnouncement): void {
  if (announcement.action === "unlisted") {
    // Remove from discovered set
    if (wakuEvents.has(announcement.eventId)) {
      const next = new Map(wakuEvents);
      next.delete(announcement.eventId);
      wakuEvents = next;
    }
    return;
  }

  // Convert to EventDirectoryEntry
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

  // Upsert — trigger reactivity by creating new Map
  const next = new Map(wakuEvents);
  next.set(entry.eventId, entry);
  wakuEvents = next;
}

// ---------------------------------------------------------------------------
// Internal: Store protocol (historical query)
// ---------------------------------------------------------------------------

async function queryHistory(node: import("@waku/sdk").LightNode): Promise<void> {
  try {
    const decoder = node.createDecoder({ contentTopic: WAKU_CONTENT_TOPIC });

    // Query messages from the last 48 hours
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);

    await node.store.queryWithOrderedCallback(
      [decoder],
      (msg) => {
        if (!msg.payload) return;
        const announcement = decodeEventAnnouncement(msg.payload);
        if (announcement) processAnnouncement(announcement);
      },
      {
        timeStart: cutoff,
        timeEnd: new Date(),
      },
    );
  } catch (err) {
    console.warn("[waku] Store query failed (non-critical):", err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// Internal: Filter protocol (real-time subscription)
// ---------------------------------------------------------------------------

async function subscribeRealtime(node: import("@waku/sdk").LightNode): Promise<void> {
  const decoder = node.createDecoder({ contentTopic: WAKU_CONTENT_TOPIC, shardId: WAKU_SHARD_INDEX });

  const callback = (msg: { payload?: Uint8Array }): void => {
    if (!msg.payload) return;
    const announcement = decodeEventAnnouncement(msg.payload);
    if (announcement) {
      processAnnouncement(announcement);
      console.log(`[waku] Received announcement: ${announcement.action} ${announcement.eventId}`);
    }
  };

  const success = await node.filter.subscribe([decoder], callback);
  if (!success) {
    console.warn("[waku] Filter subscription failed");
    return;
  }

  _filterNode = node;
}
