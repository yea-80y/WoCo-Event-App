/**
 * Card-checkout fee arithmetic. The numbers come from `cardOrderAmounts` in
 * packages/shared event/fees.ts, the same function every receipt and listing
 * shows, so the advertised price is the charged price. Organiser Terms §6
 * states this structure contractually.
 *
 * The organiser chooses per series: no booking fee (absorb), their own booking
 * fee % (`buyerFeePercent` ≥ floor, default 10%, folded into the ticket line),
 * or "cover the fees" (`coverFees`, one order-level Booking fee line). The
 * platform's application fee is not computed here: create-checkout takes it on
 * `subtotalAmount` at the rate the organiser's account is on (launch-rate.ts).
 * Stripe's processing fee is charged to the organiser's connected account
 * separately (fees.payer = "account" — account-params.ts) and never appears here.
 */

import { cardOrderAmounts, type PaymentConfig } from "@woco/shared";

export interface CardFees {
  /** Booking-fee % actually applied (percent mode only; 0 otherwise). */
  buyerFeePct: number;
  /** Per-ticket line amount, in minor units. */
  chargeAmount: number;
  /** Separate order-level "Booking fee" line ("cover the fees"); 0 otherwise. */
  orderFeeAmount: number;
  /** What the buyer pays for the whole order, in minor units. */
  sessionAmount: number;
  /** Ticket prices only, in minor units: what our application fee is taken on. */
  subtotalAmount: number;
}

/**
 * The smallest platform fee a card sale may carry, in minor units. A sale whose
 * fee rounds to 0 creates no ApplicationFee, and the webhook proves a session is
 * ours by that fee (#645, checkout-provenance.ts) - so it would be charged and
 * never fulfilled. Both create routes refuse below this: "price too low".
 */
export const MIN_APPLICATION_FEE_MINOR = 1;

export function computeCardFees(
  payment: Pick<PaymentConfig, "feePassedToCustomer" | "buyerFeePercent" | "coverFees">,
  priceFloat: number,
  quantity: number,
): CardFees {
  const a = cardOrderAmounts(payment, Math.round(priceFloat * 100), quantity);
  return {
    buyerFeePct: a.feePercent,
    chargeAmount: a.unitChargeMinor,
    orderFeeAmount: a.orderFeeMinor,
    sessionAmount: a.totalMinor,
    subtotalAmount: a.subtotalMinor,
  };
}
