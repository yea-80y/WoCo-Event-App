/**
 * Authorisation for actions whose URL carries TWO identifiers — an eventId and a
 * seriesId — where only the first was ever checked (#178).
 *
 * The approve/reject endpoints proved the caller owned the EVENT in the URL and
 * then acted on the SERIES in the URL, with nothing joining them. Series ids are
 * not secret: they appear in the public event feed and in claim URLs. So an
 * organiser could authorise against an event of their own — which costs nothing
 * to create — and then approve or reject pending claims on anybody else's event.
 *
 * This is the identifier-versus-authenticator confusion: the series id was
 * treated as a mere parameter when it is the thing the authorisation should have
 * been scoped to. The privilege being exercised is over the series, so the join
 * is not a nicety — it IS the authorisation.
 *
 * Kept in its own module, free of Hono and of the Swarm read stack, so the
 * decision is a pure function the tests can exercise directly.
 */

import type { EventFeed } from "@woco/shared";

export type SeriesAuthzResult =
  | { ok: true }
  | { ok: false; status: 403 | 404; error: string };

/**
 * Decide whether `parentAddress` may act on `seriesId` under `event`.
 *
 * `event` is what `getEventForOwner(eventId, parentAddress)` returned — null
 * when the event could not be resolved at all.
 *
 * The series check returns 403, not 404. The caller is authenticated and the
 * series exists; what they lack is authority over it. A 404 would also make the
 * endpoint an existence oracle for other organisers' series ids.
 */
export function authorizeSeriesAction(
  event: EventFeed | null,
  seriesId: string,
  parentAddress: string,
  action: string,
): SeriesAuthzResult {
  if (!event) return { ok: false, status: 404, error: "Event not found" };

  if (event.creatorAddress.toLowerCase() !== parentAddress.toLowerCase()) {
    return { ok: false, status: 403, error: `Only the event organizer can ${action} claims` };
  }

  // `series`, not `ticketSeries` — EventFeed names it `series` (event/types.ts).
  // An optional-chained read of a field that does not exist yields undefined,
  // which is falsy, which would fail EVERY request rather than only the crossed
  // ones — a wrong field name here is an outage, not a weaker guard.
  if (!event.series.some((s) => s.seriesId === seriesId)) {
    return { ok: false, status: 403, error: "Series does not belong to this event" };
  }

  return { ok: true };
}
