import type { PaymentConfig } from "@woco/shared";
import { PLATFORM_FEE_BP } from "@woco/shared";
import { CURRENCY_SYMBOLS } from "./helpers.js";

/** Buyer always sees ticket × 1.10 on card payments.
 * Crypto path uses the escrow contract's 1.5% (PLATFORM_FEE_BP). */
export const FLAT_BUYER_FEE_RATE = 0.10;

export interface BuyerFees {
  qty: number;
  baseLabel: string;
  base: string;
  unit: string;
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
  const cardFee = subtotal * FLAT_BUYER_FEE_RATE;
  const cryptoPlatformFee = (subtotal * PLATFORM_FEE_BP) / 10_000;
  return {
    qty,
    baseLabel: qty > 1 ? `Tickets (\u00d7${qty})` : "Ticket",
    base: fmt(subtotal),
    unit: fmt(unit),
    fee: fmt(cardFee),
    platform: fmt(cryptoPlatformFee),
    cardTotal: payment.stripeEnabled ? fmt(subtotal + cardFee) : null,
    cryptoTotal: payment.cryptoEnabled ? fmt(subtotal + cryptoPlatformFee) : null,
  };
}
