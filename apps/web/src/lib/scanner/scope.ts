/**
 * Every check-in stored on a scanner belongs to ONE event. Kept apart from
 * `db.ts` (IndexedDB) so the rules are testable in node:
 * `apps/web/test/scanner-scope.test.ts`.
 *
 * Until DB v2 the phone keyed check-ins, the unsynced queue and in-flight claims
 * by ticket alone. Setting up a new event cleared none of them, so the header
 * counted every event the phone had ever scanned (the owner's phone said 3 in
 * when 1 was), and an earlier event's unsynced records were sent to the NEW
 * event's /sync, where they joined its check-in set and the dashboard count.
 */

/** Never in an event id (server-issued, inside the HMAC'd pass), so it cannot split one. */
const SEP = "\u0000";

export function storeKey(eventId: string, seriesId: string, edition: number): string {
  return `${eventId}${SEP}${seriesId} ${edition}`;
}

/** [lower, upper) of every key stored for this event, and of no other event's. */
export function eventKeyBounds(eventId: string): [string, string] {
  return [`${eventId}${SEP}`, `${eventId}\u0001`];
}

/** The event a stored key belongs to; null for a key from before v2. */
export function keyEvent(key: string): string | null {
  const i = key.indexOf(SEP);
  return i > 0 ? key.slice(0, i) : null;
}

/** How many unsynced records the phone holds for events other than `current`. */
export function unsyncedElsewhere(pendingKeys: string[], current: string | null): number {
  return pendingKeys.filter((k) => keyEvent(k) !== current).length;
}

interface PackSeries {
  eventId: string;
  series: { seriesId: string }[];
}

/** The stored pack's event and ticket types, or null when it cannot place anything. */
function packSeries(pack: unknown): { eventId: string; series: Set<string> } | null {
  const p = pack as Partial<PackSeries> | null | undefined;
  if (!p || typeof p.eventId !== "string" || !p.eventId || !Array.isArray(p.series)) return null;
  return { eventId: p.eventId, series: new Set(p.series.map((s) => s?.seriesId).filter((id): id is string => typeof id === "string")) };
}

function isTicketRecord(r: unknown): r is { seriesId: string; edition: number } {
  const rec = r as { seriesId?: unknown; edition?: unknown } | null;
  return !!rec && typeof rec === "object" && typeof rec.seriesId === "string" && Number.isInteger(rec.edition) && (rec.edition as number) >= 1;
}

/**
 * The legacy copy's decision for each stored record. A legacy record names no
 * event: the only one it can be placed in is the phone's stored pack, by its
 * ticket type. The rest are dropped - they belong to an event whose pass the
 * phone no longer holds, so they could never sync to the right place, and
 * keeping them is what sent them to the wrong one. A record that cannot be read
 * is skipped. Pre-launch: no real door's records are affected.
 */
export function scopeV1Records<T extends { seriesId: string; edition: number }>(
  pack: unknown,
  records: unknown,
): { key: string; record: T }[] {
  const placed = packSeries(pack);
  if (!placed || !Array.isArray(records)) return [];
  return records
    .filter((r): r is T => isTicketRecord(r) && placed.series.has(r.seriesId))
    .map((record) => ({ key: storeKey(placed.eventId, record.seriesId, record.edition), record }));
}

/** The same decision for in-flight claim ids, stored legacy as `{ "seriesId edition": claimId }`. */
export function scopeV1Claims(pack: unknown, claims: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const placed = packSeries(pack);
  if (!placed || !claims || typeof claims !== "object") return out;
  for (const [key, claimId] of Object.entries(claims as Record<string, unknown>)) {
    const at = key.lastIndexOf(" ");
    const seriesId = key.slice(0, at);
    const edition = Number(key.slice(at + 1));
    if (at > 0 && typeof claimId === "string" && Number.isInteger(edition) && edition >= 1 && placed.series.has(seriesId)) {
      out[storeKey(placed.eventId, seriesId, edition)] = claimId;
    }
  }
  return out;
}
