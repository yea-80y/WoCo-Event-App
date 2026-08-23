/**
 * How many seats one network may hold unpaid, at one event, at one time (#223).
 *
 * WHAT THIS IS NOT. It is not a ticket limit. Incumbents publish a per-order
 * limit and enforce it against identity — name, email, billing address, card.
 * Ours is `RESERVATION_MAX_QTY`, and it is the buyer-facing rule. This cap is
 * invisible infrastructure sitting behind it, and its job is to make an
 * inventory lockout expensive without ever refusing a real buyer.
 *
 * WHY IT IS SIZED BY THE EVENT. A reservation holds a seat for ten minutes
 * BEFORE payment, so holding is free and the only cost of a lockout is patience.
 * A flat cap therefore means something different at every event: 30 seats is 60%
 * of a 50-seat room and 1.5% of an arena. The same number that barely
 * inconveniences an arena lets one address sit on most of a small room.
 *
 * So the cap SHRINKS for small events and is never raised above the flat 30 it
 * replaces. This change tightens; it loosens nothing.
 *
 * WHY DECLARED SUPPLY, NOT REMAINING. The denominator is what the organiser said
 * the event holds, summed across series, taken from the event record the route
 * has already loaded. It costs no I/O. Live remaining supply would cost one
 * uncached chain read per series on an unauthenticated endpoint, and add a
 * partial-failure mode to a path whose fail-closed behaviour is currently clean.
 * It would also need awaits inside the cap-check-to-insert stretch, which is
 * what keeps that stretch atomic. An organiser who inflates their own declared
 * supply only loosens the cap on their own event.
 */

import { RESERVATION_MAX_QTY } from "./reservation-store.js";

/** Fraction of an event's declared supply one network may hold at once. */
const SEAT_CAP_FRACTION = 0.1;

/**
 * Absolute ceiling, whatever the event size. Deliberately the SAME 30 this
 * replaced, so no event of any size is loosened by this change.
 *
 * An earlier draft raised it to 100 to admit the "40-person corporate block
 * booking" #223 describes being refused. That was wrong, and the reason matters:
 * a consumed hold stops counting the moment payment lands (`isActive` requires
 * `!consumedAt`), so a 40-seat purchase already completes under a cap of 30 —
 * or of 10 — by paying for each order before starting the next, which is simply
 * how checkout works. The cap constrains seats held UNPAID AND SIMULTANEOUSLY;
 * it never constrains how much a network buys in total.
 *
 * So nobody legitimate needs a large simultaneous hold, and the party that does
 * is the one this cap exists to slow down. Incumbents agree by construction:
 * their model is one cart holding at most the published ticket limit (4-8), with
 * no concurrent holds to accumulate at all.
 */
const SEAT_CAP_CEILING = 30;

/**
 * The cap for an event of `declaredSupply` seats.
 *
 * The floor is `RESERVATION_MAX_QTY` and must stay tied to it. Below that the
 * platform would advertise a maximum order size and then refuse the first order
 * of exactly that size — which is what #223's own suggested `max(5, …)` did, on
 * any event under ~50 seats.
 */
export function perIpSeatCapForEvent(declaredSupply: number): number {
  // A non-finite supply must collapse to the floor, not propagate. NaN compares
  // false against everything, so it would survive both clamp arms and disable
  // the cap silently — the one failure mode of this function that fails OPEN.
  // `declaredSupplyOf` cannot produce one; this makes the function total anyway.
  const supply = Number.isFinite(declaredSupply) ? Math.max(0, declaredSupply) : 0;
  const proportional = Math.ceil(supply * SEAT_CAP_FRACTION);
  return Math.min(SEAT_CAP_CEILING, Math.max(RESERVATION_MAX_QTY, proportional));
}

/**
 * Declared supply of an event — the sum of its series.
 *
 * Tolerant of a malformed series rather than throwing: a missing or negative
 * `totalSupply` contributes nothing, and an event that sums to zero still gets
 * the floor, so a seat hold is never refused because of a bad supply field.
 */
export function declaredSupplyOf(series: readonly { totalSupply?: number }[]): number {
  let total = 0;
  for (const s of series) {
    const n = Number(s?.totalSupply);
    if (Number.isFinite(n) && n > 0) total += n;
  }
  return total;
}
