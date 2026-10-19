import type { PaymentConfig } from "./types.js";
import { PLATFORM_FEE_BP } from "./types.js";
import { FEATURES, BUYER_FEE_FLOOR_PCT, BUYER_FEE_DEFAULT_PCT } from "../features.js";

export const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  GBP: "£",
  EUR: "€",
};

export interface BuyerFees {
  qty: number;
  baseLabel: string;
  base: string;
  unit: string;
  /** Booking-fee % the buyer pays; 0 when the organiser absorbs fees (no receipt row). */
  feePercent: number;
  fee: string;
  /** Crypto platform fee (PLATFORM_FEE_BP), formatted — shown on the crypto receipt. */
  platform: string;
  cardTotal: string | null;
  cryptoTotal: string | null;
}

/**
 * Booking fee % the buyer pays: the organiser's per-series choice, 0 when they
 * absorb fees. The floor clamp matches the server (checkout-fees.ts) so what
 * we display is what Stripe will charge.
 */
export function bookingFeePercent(payment: PaymentConfig): number {
  return payment.feePassedToCustomer
    ? Math.max(BUYER_FEE_FLOOR_PCT, payment.buyerFeePercent ?? BUYER_FEE_DEFAULT_PCT)
    : 0;
}

export interface HeadlinePrice {
  /** One ticket, booking fee included, in major units. */
  amount: number;
  /** `amount` with its currency symbol. */
  label: string;
  /** The booking fee inside `label`; null when the organiser absorbs fees. */
  feeLabel: string | null;
}

/**
 * What one ticket costs the buyer, booking fee included. The booking fee is
 * mandatory, so this - never the bare ticket price - is the figure every
 * listing leads with (CMA209 price transparency: mandatory fees belong in the
 * headline price). Same per-unit cents arithmetic as the checkout.
 */
export function headlinePrice(payment: PaymentConfig | undefined): HeadlinePrice | null {
  if (!payment) return null;
  const unit = parseFloat(payment.price);
  if (!unit || unit <= 0) return null;
  const unitCents = Math.round(unit * 100);
  const feeCents = Math.round((unitCents * bookingFeePercent(payment)) / 100);
  const sym = CURRENCY_SYMBOLS[payment.currency] ?? `${payment.currency} `;
  const fmt = (cents: number) => `${sym}${(cents / 100).toFixed(2)}`;
  return {
    amount: (unitCents + feeCents) / 100,
    label: fmt(unitCents + feeCents),
    feeLabel: feeCents > 0 ? fmt(feeCents) : null,
  };
}

/** Cheapest and dearest headline price across an event's paid ticket types. */
export function headlinePriceRange(
  series: readonly { payment?: PaymentConfig }[],
): { min: HeadlinePrice; max: HeadlinePrice } | null {
  let min: HeadlinePrice | null = null;
  let max: HeadlinePrice | null = null;
  for (const s of series) {
    const p = headlinePrice(s.payment);
    if (!p) continue;
    if (!min || p.amount < min.amount) min = p;
    if (!max || p.amount > max.amount) max = p;
  }
  return min && max ? { min, max } : null;
}

export function calculateBuyerFees(
  payment: PaymentConfig | undefined,
  quantity: number,
): BuyerFees | null {
  if (!payment) return null;
  const unit = parseFloat(payment.price);
  if (!unit || unit <= 0) return null;
  const qty = Math.max(1, quantity);
  const subtotal = unit * qty;
  const sym = CURRENCY_SYMBOLS[payment.currency] ?? "";
  const fmt = (n: number) => `${sym}${n.toFixed(2)}`;
  const feePercent = bookingFeePercent(payment);
  // Integer cents, rounded per unit — the server's arithmetic exactly.
  const unitCents = Math.round(unit * 100);
  const feeCentsPerUnit = Math.round((unitCents * feePercent) / 100);
  const cardFee = (feeCentsPerUnit * qty) / 100;
  const cardTotal = ((unitCents + feeCentsPerUnit) * qty) / 100;
  const cryptoPlatformFee = (subtotal * PLATFORM_FEE_BP) / 10_000;
  return {
    qty,
    baseLabel: qty > 1 ? `Tickets (×${qty})` : "Ticket",
    base: fmt(subtotal),
    unit: fmt(unit),
    feePercent,
    fee: fmt(cardFee),
    platform: fmt(cryptoPlatformFee),
    cardTotal: payment.stripeEnabled ? fmt(cardTotal) : null,
    cryptoTotal:
      FEATURES.cryptoPaymentsAllowed && payment.cryptoEnabled ? fmt(subtotal + cryptoPlatformFee) : null,
  };
}
