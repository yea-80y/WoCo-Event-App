/**
 * Which event a scanner tab shows, when one phone holds several (two doors, two
 * tabs, or one door switching). Kept apart from the store (runes) and storage
 * so each rule is testable in node: `apps/web/test/scanner-events.test.ts`.
 *
 * Each tab remembers its own event in a NON-secret URL marker, `#/e/{eventId}`,
 * so a reload reopens that tab's event, and setting up another event in another
 * tab never changes it. The pass itself (token + roster key) never goes there.
 */
import { keyEvent } from "./scope.js";
import { isPassExpired } from "./pass-gate.js";

export interface PassSummary {
  eventId: string;
  exp: number;
  lastUsedAt?: number;
  dead?: string;
}

const MARKER = /^#\/e\/([^/]+)$/;

export function eventMarker(eventId: string): string {
  return `#/e/${encodeURIComponent(eventId)}`;
}

export function parseEventMarker(hash: string): string | null {
  const m = hash.match(MARKER);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

export function isLive(p: PassSummary, now: number): boolean {
  return !p.dead && !isPassExpired(p.exp, now);
}

/** Events a tab may open or switch to: live passes only, most recently used first. */
export function liveEvents<T extends PassSummary>(passes: T[], now: number): T[] {
  return passes.filter((p) => isLive(p, now)).sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
}

export type EventChoice =
  | { kind: "open"; eventId: string }
  /** The tab's own event (or, on a fresh open, the latest) can no longer be opened. */
  | { kind: "ended"; eventId: string; reason: "expired" | "dead"; message?: string }
  | { kind: "none" };

/**
 * A tab with a marker reopens ITS event, or says why it cannot - it never
 * quietly turns into another event's door. A fresh open (home-screen icon, bare
 * URL) opens the most recently used live event.
 */
export function chooseEvent(marker: string | null, passes: PassSummary[], now: number): EventChoice {
  if (marker !== null) {
    const own = passes.find((p) => p.eventId === marker);
    if (!own) return { kind: "none" };
    return isLive(own, now) ? { kind: "open", eventId: own.eventId } : ended(own);
  }
  const live = liveEvents(passes, now);
  if (live.length > 0) return { kind: "open", eventId: live[0].eventId };
  const latest = [...passes].sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))[0];
  return latest ? ended(latest) : { kind: "none" };
}

function ended(p: PassSummary): EventChoice {
  return p.dead
    ? { kind: "ended", eventId: p.eventId, reason: "dead", message: p.dead }
    : { kind: "ended", eventId: p.eventId, reason: "expired" };
}

/**
 * What an ended event (pass expired or refused) leaves on the phone. Its roster
 * and pack - attendee data nothing can use any more - go at once. Its check-ins
 * stay while any are unsynced, then the event goes entirely.
 */
export function endedEventCleanup(passes: PassSummary[], pendingKeys: string[], now: number): { clear: string[]; dropAttendeeData: string[] } {
  const unsynced = new Set(pendingKeys.map(keyEvent));
  const clear: string[] = [];
  const dropAttendeeData: string[] = [];
  for (const p of passes) {
    if (isLive(p, now)) continue;
    (unsynced.has(p.eventId) ? dropAttendeeData : clear).push(p.eventId);
  }
  return { clear, dropAttendeeData };
}
