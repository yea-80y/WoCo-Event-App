/**
 * Event discovery transport layer.
 *
 * Currently a no-op — events are loaded from the API server (GET /api/events)
 * which reads from the Swarm directory feed. This module provides the "slot"
 * where a real-time transport (WebSocket, SSE, Waku, etc.) can be plugged in
 * later without changing any UI components.
 *
 * Components import: startEventStream, stopEventStream, mergeWithLive, clearLiveEvents
 * When a real-time transport is added, implement startEventStream() to populate
 * the liveEvents map, and mergeWithLive() will automatically include them.
 */
import type { EventDirectoryEntry } from "@woco/shared";

// ---------------------------------------------------------------------------
// Reactive state (Svelte 5 runes)
// ---------------------------------------------------------------------------

/** Events from real-time transport (empty until a transport is implemented). */
let liveEvents = $state<Map<string, EventDirectoryEntry>>(new Map());

// ---------------------------------------------------------------------------
// Public API — stable interface for UI components
// ---------------------------------------------------------------------------

/** Number of events known via the real-time transport. */
export function getLiveEventCount(): number {
  return liveEvents.size;
}

/**
 * Merge fetched events (from GET /api/events) with real-time discovered events.
 * Server response takes priority (authoritative). Live events fill in anything
 * created after the fetch.
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
 * Start the real-time event stream.
 * Currently a no-op — plug in WebSocket/SSE/Waku here in the future.
 */
export async function startEventStream(): Promise<void> {
  // No-op: real-time transport not yet implemented.
  // When ready, this function should connect to the transport and
  // populate liveEvents via processAnnouncement().
}

/**
 * Stop the real-time event stream.
 */
export async function stopEventStream(): Promise<void> {
  // No-op
}
