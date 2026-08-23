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
 * of a 50-seat room and 1.5% of an arena. It was simultaneously too loose to
 * protect a small event and too tight to admit a corporate block booking at a
 * large one.
 *
 * WHY DECLARED SUPPLY, NOT REMAINING. The denominator is what the organiser said
 * the event holds, summed across series, taken from the event record the route
 * has already loaded. It costs no I/O. Live remaining supply would cost one
 * uncached chain read per series on an unauthenticated endpoint, add a
 * partial-failure mode, and — being smaller late in a sale — would refuse
 * exactly the late group booking this issue exists to admit. An organiser who
 * inflates their own supply only loosens the cap on their own event.
 */

import { RESERVATION_MAX_QTY } from "./reservation-store.js";

/** Fraction of an event's declared supply one network may hold at once. */
const SEAT_CAP_FRACTION = 0.1;

/**
 * Absolute ceiling, whatever the event size.
 *
 * Ten concurrent max-size unpaid orders behind one address — a plausible peak
 * for a campus or venue NAT at a big on-sale, and ~2% of an arena. Above this
 * the proportional cap stops buying protection and starts buying an attacker
 * room, since one bucket is already the wrong unit at that scale.
 */
const SEAT_CAP_CEILING = 100;

/**
 * The cap for an event of `declaredSupply` seats.
 *
 * The floor is `RESERVATION_MAX_QTY` and must stay tied to it. Below that the
 * platform would advertise a maximum order size and then refuse the first order
 * of exactly that size — which is what #223's own suggested `max(5, …)` did, on
 * any event under ~50 seats.
 */
export function perIpSeatCapForEvent(declaredSupply: number): number {
  const proportional = Math.ceil(Math.max(0, declaredSupply) * SEAT_CAP_FRACTION);
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
