/**
 * Ticket pricing choices shared by every way of selling (standing tickets in
 * TicketSeriesEditor, seats in SeatingSection), so the two can never price
 * differently. Fee arithmetic itself stays in @woco/shared (`cardOrderAmounts`,
 * docs/PRICING_AND_EMAIL.md).
 */

import { COVER_FEE_RATES, type Hex0x, type PaymentConfig } from "@woco/shared";

export const ALL_CURRENCIES = ["GBP", "USD", "EUR"] as const;
export type Ccy = (typeof ALL_CURRENCIES)[number];

/**
 * Stripe pays each organiser out in ONE currency; pricing in another makes Stripe
 * convert every sale and take its FX fee (#84). So only the payout currency is
 * offered once it is known; unknown (mid-onboarding, or Stripe unreachable) keeps
 * all three. The server applies the same rule.
 */
export function currencyChoices(payoutCurrency: string | undefined | null): readonly Ccy[] {
  const p = payoutCurrency?.toUpperCase();
  return p && (ALL_CURRENCIES as readonly string[]).includes(p) ? [p as Ccy] : ALL_CURRENCIES;
}

/** How the booking fee is charged: absorbed, a % on top, or "cover the fees". */
export interface FeeChoice {
  feePassedToCustomer: boolean;
  coverFees: boolean;
  buyerFeePercent: number;
}

/** The choice as stored on a series' PaymentConfig. */
export function feeSettings(c: FeeChoice): Pick<PaymentConfig, "feePassedToCustomer" | "coverFees" | "buyerFeePercent"> {
  if (!c.feePassedToCustomer) return { feePassedToCustomer: false };
  return c.coverFees
    ? { feePassedToCustomer: true, coverFees: { ...COVER_FEE_RATES } }
    : { feePassedToCustomer: true, buyerFeePercent: c.buyerFeePercent };
}

/** A card-only PaymentConfig (the only live rail): seats always sell this way. */
export function cardPayment(price: string, currency: Ccy, fee: FeeChoice): PaymentConfig {
  return {
    price,
    currency,
    recipientAddress: "0x0" as Hex0x,
    acceptedChains: [],
    escrow: false,
    cryptoEnabled: false,
    stripeEnabled: true,
    ...feeSettings(fee),
  };
}
