/**
 * Card-checkout fee arithmetic — one place, because Organiser Terms §6 states
 * this structure contractually and the buyer receipt (packages/shared
 * event/fees.ts, rendered by the web app and the embed) mirrors it. Change
 * all three together.
 *
 * The organiser chooses per series: pass a booking fee to the buyer
 * (`feePassedToCustomer`, `buyerFeePercent` ≥ floor, default 10%) and keep the
 * markup, or absorb fees into the ticket price. The platform's application fee
 * is PLATFORM_FEE_BP (1.5%) of the ticket subtotal. Stripe's processing fee is
 * charged to the organiser's connected account separately
 * (fees.payer = "account" — account-params.ts) and never appears here.
 */

import { PLATFORM_FEE_BP, BUYER_FEE_FLOOR_PCT, BUYER_FEE_DEFAULT_PCT } from "@woco/shared";

export interface CardFees {
  /** Booking-fee % actually applied (0 when the organiser absorbs fees). */
  buyerFeePct: number;
  /** What the buyer pays per ticket, in minor units. */
  chargeAmount: number;
  /** Platform application fee for the whole session, in minor units. */
  totalApplicationFee: number;
}

export function computeCardFees(
  payment: { feePassedToCustomer?: boolean; buyerFeePercent?: number },
  priceFloat: number,
  quantity: number,
): CardFees {
  const baseAmount = Math.round(priceFloat * 100);
  // The floor re-clamps here because checkout must hold for series stored
  // before creation-time validation, not just ones events.ts accepted.
  const buyerFeePct = payment.feePassedToCustomer === true
    ? Math.max(BUYER_FEE_FLOOR_PCT, payment.buyerFeePercent ?? BUYER_FEE_DEFAULT_PCT)
    : 0;
  const buyerFeeAmount = Math.round((baseAmount * buyerFeePct) / 100); // per unit
  return {
    buyerFeePct,
    chargeAmount: baseAmount + buyerFeeAmount,
    totalApplicationFee: Math.round((baseAmount * quantity * PLATFORM_FEE_BP) / 10_000),
  };
}
