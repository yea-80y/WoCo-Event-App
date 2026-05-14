/**
 * Shared client-side event date utilities.
 *
 * Filtering past vs upcoming is a presentation concern — it belongs on the
 * client where `now` is always correct, not on the server where the result
 * would be stale by the time it hits a client-side cache. The server keeps
 * its `?filter=` support for debugging and external tooling only.
 */

/** True when an event has definitively ended.
 *  Uses endDate if present and non-empty, falls back to startDate.
 *  Returns false for malformed/missing dates (treat as upcoming). */
export function isPastEvent(
  e: { endDate?: string; startDate: string },
  now: number = Date.now(),
): boolean {
  const raw = e.endDate && e.endDate.length > 0 ? e.endDate : e.startDate;
  const ts = new Date(raw).getTime();
  return !isNaN(ts) && ts < now;
}
