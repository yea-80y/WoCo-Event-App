/**
 * What a seated hold asks for (docs/SEATING.md "Selling a seat"): the seats by index,
 * and the plan the buyer saw them on. The server holds seats only on the plan it
 * pinned at registration (decision 4); a request naming another plan is refused, so a
 * buyer is never sold seat k of a plan they were not shown.
 *
 * The reserve route refuses seated series until S4 wires this in: this is the
 * contract S4 must honour, pinned now by test/seating/reserve.test.ts.
 */

import { RESERVATION_MAX_QTY } from "../event/reservation.js";
import { isIntIn, isPlainRecord } from "../validate.js";

export interface SeatedReserveRequest {
  /** Ascending, each once, 1..RESERVATION_MAX_QTY of them. */
  seats: number[];
  /** `seatPlanDigest` of the plan the buyer picked on: 0x + 64 lowercase hex. */
  planDigest: string;
}

const DIGEST_RE = /^0x[0-9a-f]{64}$/;

/**
 * The request from an untrusted body, or null. Seats may arrive in any order; they
 * come back sorted. Other body keys (the existing `replaceReservationId`, `siteId`)
 * are the route's business, so only these two are read here.
 */
export function parseSeatedReserve(body: unknown, seatCount: number): SeatedReserveRequest | null {
  if (!isPlainRecord(body)) return null;
  const { seats, planDigest } = body as { seats?: unknown; planDigest?: unknown };
  if (typeof planDigest !== "string" || !DIGEST_RE.test(planDigest)) return null;
  if (!Array.isArray(seats) || seats.length < 1 || seats.length > RESERVATION_MAX_QTY) return null;
  if (!seats.every((k) => isIntIn(k, 0, seatCount - 1))) return null;
  const sorted = [...(seats as number[])].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) if (sorted[i] === sorted[i - 1]) return null;
  return { seats: sorted, planDigest };
}

export type SeatedReserveRefusal = "plan_changed";

/**
 * Refuse a hold for a plan other than the registration's pinned one. Returns the
 * reason, or null when the request is for the pinned plan.
 */
export function seatedReserveRefusal(req: SeatedReserveRequest, pin: { planDigest: string }): SeatedReserveRefusal | null {
  return req.planDigest !== pin.planDigest.toLowerCase() ? "plan_changed" : null;
}
