/**
 * A seated series' band prices, checked against its plan. Seats name bands in the
 * committed plan; the event feed names each band's price (`SeriesSeating`). The two
 * must cover each other exactly: a seat whose band has no price is unsellable.
 */

import type { PaymentConfig, SeriesSeating } from "../event/types.js";
import { MIN_TICKET_PRICE } from "../features.js";
import { hasExactKeys, isPlainRecord } from "../validate.js";
import type { SeatPlan } from "./plan.js";

/** A price as typed: whole units, optionally pence/cents. No exponents, no signs. */
const PRICE_RE = /^\d{1,6}(\.\d{1,2})?$/;

export const priceMinor = (price: string): number => Math.round(parseFloat(price) * 100);

/**
 * Why `seating` cannot go with this plan and payment, or null when it can:
 * exactly one price per plan band, each a well-formed price at or above the
 * minimum, and `payment.price` equal to the lowest (what listings show as "from").
 */
export function seriesSeatingRefusal(
  seating: unknown,
  plan: Pick<SeatPlan, "bands">,
  payment: Pick<PaymentConfig, "price"> | undefined,
): string | null {
  if (!isPlainRecord(seating) || !hasExactKeys(seating, ["bands"]) || !Array.isArray(seating.bands)) {
    return "seating must be { bands: [{ id, price }] }";
  }
  const planIds = new Set(plan.bands.map((b) => b.id));
  const seen = new Set<string>();
  let lowest = Infinity;
  for (const b of seating.bands) {
    if (!isPlainRecord(b) || !hasExactKeys(b, ["id", "price"]) || typeof b.id !== "string" || typeof b.price !== "string") {
      return "each band price must be { id, price }";
    }
    if (!planIds.has(b.id)) return `band ${b.id} is not on the seating plan`;
    if (seen.has(b.id)) return `band ${b.id} is priced twice`;
    seen.add(b.id);
    if (!PRICE_RE.test(b.price) || priceMinor(b.price) < MIN_TICKET_PRICE * 100) {
      return `band ${b.id}: the minimum ticket price is ${MIN_TICKET_PRICE}.00`;
    }
    lowest = Math.min(lowest, priceMinor(b.price));
  }
  if (seen.size !== planIds.size) return "every band on the seating plan needs a price";
  if (!payment || priceMinor(payment.price) !== lowest) return "the ticket price must be the lowest band price";
  return null;
}

/** Band id -> price in minor units, for a `seating` already checked by `seriesSeatingRefusal`. */
export function bandPricesMinor(seating: SeriesSeating): Map<string, number> {
  return new Map(seating.bands.map((b) => [b.id, priceMinor(b.price)]));
}
