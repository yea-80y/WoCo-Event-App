/**
 * Which ticket types (series) an event has, as of the last pack this server
 * built for it. /claim and /sync take records only for these.
 *
 * A scanner kept its check-ins by ticket alone, so records from an earlier event
 * on the same phone were sent to the next event's /sync, and the server merged
 * them in: the owner's dashboard counted 3 in when 1 was (2026-10-14). The
 * scanner no longer does that; this is the server not accepting it either.
 *
 * Filled from /pack only, which already loads the event: a scanner must load a
 * pack before it can scan, refreshes it every minute and again on any ticket it
 * cannot place - including a ticket type added since - so every claim for a
 * series follows a pack that listed it. No Swarm read is ever added to a claim
 * or a sync. Until the first pack after a restart nothing is known, and records
 * go through as before: a door must not stop on our bookkeeping (the same choice
 * `outdatedPass` makes for an unreadable key ring).
 */

const known = new Map<string, Set<string>>();

export function rememberEventSeries(eventId: string, seriesIds: Iterable<string>): void {
  known.set(eventId, new Set(seriesIds));
}

/** null: no pack built for this event since the server started. */
export function eventSeries(eventId: string): ReadonlySet<string> | null {
  return known.get(eventId) ?? null;
}

/** Keep only records of the event's series; all of them when the series are not known yet. */
export function ofEventSeries<T extends { seriesId?: unknown }>(eventId: string, records: T[]): T[] {
  const series = known.get(eventId);
  return series ? records.filter((r) => typeof r?.seriesId === "string" && series.has(r.seriesId)) : records;
}

/** Tests only. */
export function forgetEventSeries(): void {
  known.clear();
}
