/**
 * Waku event discovery — Svelte 5 rune store.
 *
 * Fetches Waku-discovered events from the server (which runs the Waku light
 * node and subscribes to announcements). The browser doesn't connect to nwaku
 * directly — the server acts as the Waku gateway.
 *
 * Key principles:
 * - Graceful degradation: if Waku endpoint fails, the app works with Swarm only
 * - Swarm directory is authoritative; Waku only adds events not in Swarm
 * - Polls periodically for new discoveries
 */
import type { EventDirectoryEntry } from "@woco/shared";

// ---------------------------------------------------------------------------
// Reactive state (Svelte 5 runes)
// ---------------------------------------------------------------------------

/** Discovered events keyed by eventId */
let wakuEvents = $state<Map<string, EventDirectoryEntry>>(new Map());

/** True once the first fetch has completed */
let wakuReady = $state(false);

/** Error message if fetch failed (null = no error or not started) */
let wakuError = $state<string | null>(null);

/** True while fetching */
let wakuConnecting = $state(false);

let _started = false;
let _pollTimer: ReturnType<typeof setInterval> | null = null;

/** How often to poll for new Waku discoveries (ms). */
const POLL_INTERVAL = 30_000;

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

/** Whether Waku discovery has loaded. */
export function isWakuReady(): boolean {
  return wakuReady;
}

/** Whether Waku is currently fetching. */
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
 * Start Waku discovery polling. Safe to call multiple times — only runs once.
 */
export async function startWakuDiscovery(): Promise<void> {
  if (_started) return;
  _started = true;

  // Fetch immediately, then poll
  await fetchWakuDiscovered();

  _pollTimer = setInterval(() => {
    fetchWakuDiscovered().catch(() => {});
  }, POLL_INTERVAL);
}

/**
 * Stop Waku discovery polling.
 */
export async function stopWakuDiscovery(): Promise<void> {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
  wakuReady = false;
  _started = false;
}

// ---------------------------------------------------------------------------
// Internal: fetch from server
// ---------------------------------------------------------------------------

const API_BASE =
  import.meta.env.VITE_API_URL ||
  (typeof window !== "undefined" ? window.location.origin : "");

async function fetchWakuDiscovered(): Promise<void> {
  wakuConnecting = true;
  wakuError = null;

  try {
    const resp = await fetch(`${API_BASE}/api/events/waku-discovered`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      wakuError = `Server returned ${resp.status}`;
      wakuConnecting = false;
      return;
    }

    const json = (await resp.json()) as {
      ok: boolean;
      data?: EventDirectoryEntry[];
      error?: string;
    };

    if (!json.ok || !json.data) {
      wakuError = json.error || "Unknown error";
      wakuConnecting = false;
      return;
    }

    // Update reactive state
    const next = new Map<string, EventDirectoryEntry>();
    for (const e of json.data) {
      next.set(e.eventId, e);
    }
    wakuEvents = next;

    wakuReady = true;
    wakuConnecting = false;
  } catch (err) {
    wakuError = err instanceof Error ? err.message : "Fetch failed";
    wakuConnecting = false;
  }
}
