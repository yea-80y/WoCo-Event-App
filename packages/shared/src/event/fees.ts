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
  // Booking fee is the organiser's per-series choice; the floor clamp matches
  // the server (routes/stripe.ts) so the receipt shows what Stripe will charge.
  const feePercent = payment.feePassedToCustomer
    ? Math.max(BUYER_FEE_FLOOR_PCT, payment.buyerFeePercent ?? BUYER_FEE_DEFAULT_PCT)
    : 0;
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
