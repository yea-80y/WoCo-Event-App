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
 *
 * ONE EXCEPTION: A LEDGER2 CUT. On ledger2 the organiser can lower a series' supply
 * on chain after registration, and the feed keeps the registered number (the
 * manifest commits exactly that many editions). Sized from 1000 after a cut to 40,
 * one network could hold 30 of the 40. So the series being reserved counts at no
 * more than its live supply, from the chain read `reserve` already makes for
 * availability (Fable design consult for the ledger2 relay, 2026-11-02): no extra
 * I/O, and that read is awaited BEFORE the synchronous cap-check-to-insert stretch,
 * so the stretch stays atomic. Other series still count at their declared number;
 * a hold in one of them is sized as if the cut had not happened, still under the
 * ceiling, while a hold in the cut series always meets its live number.
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
  // `capSupplyOf` cannot produce one; this makes the function total anyway.
  const supply = Number.isFinite(declaredSupply) ? Math.max(0, declaredSupply) : 0;
  const proportional = Math.ceil(supply * SEAT_CAP_FRACTION);
  return Math.min(SEAT_CAP_CEILING, Math.max(RESERVATION_MAX_QTY, proportional));
}

/**
 * The supply one reserve's cap is sized from: the event's declared supply (the sum
 * of its series), with `seriesId` counted at no more than `live`. The live number
 * only ever tightens: above the declared one, null, or negative, it changes nothing.
 *
 * Tolerant of a malformed series rather than throwing: a missing or negative
 * `totalSupply` contributes nothing, and an event that sums to zero still gets
 * the floor, so a seat hold is never refused because of a bad supply field.
 */
export function capSupplyOf(
  series: readonly { seriesId?: string; totalSupply?: number }[],
  seriesId: string,
  live: number | null,
): number {
  // NaN fails `>= 0`; Infinity loses the `min` below.
  const usable = live !== null && live >= 0;
  let total = 0;
  for (const s of series) {
    let n = Number(s?.totalSupply);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (usable && s?.seriesId === seriesId) n = Math.min(n, live);
    total += n;
  }
  return total;
}

/**
 * The cap for one reserve. The availability read reports the series' live supply
 * through `sawLiveSupply`; `cap` is synchronous by type so `reserve` evaluates it
 * after that read, inside its atomic stretch. Before any read it is the declared cap.
 */
export function seatCapForReserve(
  series: readonly { seriesId?: string; totalSupply?: number }[],
  seriesId: string,
): { sawLiveSupply(n: number): void; cap(): number } {
  let live: number | null = null;
  return {
    sawLiveSupply(n) {
      live = n;
    },
    cap: () => perIpSeatCapForEvent(capSupplyOf(series, seriesId, live)),
  };
}
