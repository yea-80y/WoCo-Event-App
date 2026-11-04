/**
 * The card checkout for a seated hold (docs/SEATING.md "Selling a seat"). Prices come
 * from the HOLD (pinned when the buyer held the seats) and must still be the event
 * feed's: a re-signed feed never charges a buyer other than what they were shown. One
 * Stripe line per band, one order-level "Booking fee" line in cover mode, our fee on the
 * subtotal: `cardOrderAmountsMulti`, the arithmetic the hold's view showed.
 */

import type { Stripe } from "stripe";
import { cardOrderAmountsMulti, type CardOrderAmountsMulti, type PaymentConfig } from "@woco/shared";
import { bandPricesMinor } from "@woco/shared/seating/series";
import type { SeriesSeating } from "@woco/shared";
import { isPlainRecord } from "@woco/shared/validate";
import type { SeatedHoldSeat } from "../event/reservation-store.js";

export const PRICES_CHANGED = "Seat prices for this event have changed. Hold your seats again to see the new prices.";

/** Why the hold's pinned prices are no longer the feed's, or null when they are. */
export function seatedPriceRefusal(info: readonly SeatedHoldSeat[], seating: unknown): string | null {
  if (!isPlainRecord(seating) || !Array.isArray(seating.bands)) return PRICES_CHANGED;
  let now: Map<string, number>;
  try {
    now = bandPricesMinor(seating as unknown as SeriesSeating);
  } catch {
    return PRICES_CHANGED;
  }
  return info.every((s) => now.get(s.band) === s.priceMinor) ? null : PRICES_CHANGED;
}

export function seatedCheckoutLines(
  info: readonly SeatedHoldSeat[],
  payment: Pick<PaymentConfig, "feePassedToCustomer" | "buyerFeePercent" | "coverFees">,
  currency: string,
  names: { series: string; event: string },
): { amounts: CardOrderAmountsMulti; lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] } {
  const amounts = cardOrderAmountsMulti(payment, info.map((s) => s.priceMinor));
  // Seats of one band cost the same, so each band is one line; first-seen order.
  const bands = new Map<string, { name: string; unit: number; labels: string[] }>();
  info.forEach((s, i) => {
    const b = bands.get(s.band);
    if (b) b.labels.push(s.label);
    else bands.set(s.band, { name: s.bandName, unit: amounts.chargeMinor[i], labels: [s.label] });
  });
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [...bands.values()].map((b) => ({
    price_data: {
      currency,
      product_data: { name: `${b.name} — ${names.series} — ${names.event}`, description: b.labels.join("; ") },
      unit_amount: b.unit,
    },
    quantity: b.labels.length,
  }));
  if (amounts.orderFeeMinor > 0) {
    lineItems.push({ price_data: { currency, product_data: { name: "Booking fee" }, unit_amount: amounts.orderFeeMinor }, quantity: 1 });
  }
  return { amounts, lineItems };
}
