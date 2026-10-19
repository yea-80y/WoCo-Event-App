import type { PaymentConfig, CoverFeeRates } from "./types.js";
import { PLATFORM_FEE_BP } from "./types.js";
import { FEATURES, BUYER_FEE_FLOOR_PCT, BUYER_FEE_DEFAULT_PCT, ACCEPTED_COVER_FEE_RATES } from "../features.js";

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
  /** Booking-fee % (percent mode only); 0 otherwise. */
  feePercent: number;
  /** Receipt row label for the booking fee; null when there is none (no row). */
  feeRowLabel: string | null;
  fee: string;
  /** Crypto platform fee (PLATFORM_FEE_BP), formatted — shown on the crypto receipt. */
  platform: string;
  cardTotal: string | null;
  cryptoTotal: string | null;
}

/** The organiser's per-series booking-fee choice. */
export type BookingFeeMode = "none" | "percent" | "cover";

type FeeSettings = Pick<PaymentConfig, "feePassedToCustomer" | "buyerFeePercent" | "coverFees">;

export function bookingFeeMode(payment: FeeSettings): BookingFeeMode {
  if (payment.feePassedToCustomer !== true) return "none";
  return payment.coverFees ? "cover" : "percent";
}

/**
 * Booking fee % in percent mode, 0 otherwise. The floor clamp holds for series
 * stored before creation-time validation, not just ones the server accepted.
 */
export function bookingFeePercent(payment: FeeSettings): number {
  return bookingFeeMode(payment) === "percent"
    ? Math.max(BUYER_FEE_FLOOR_PCT, payment.buyerFeePercent ?? BUYER_FEE_DEFAULT_PCT)
    : 0;
}

/** Our 1.5% of the ticket subtotal - the checkout's application_fee_amount. */
export function platformFeeMinor(subtotalMinor: number): number {
  return Math.round((subtotalMinor * PLATFORM_FEE_BP) / 10_000);
}

/** True when checkout may charge with these stored rates. */
export function acceptedCoverFeeRates(rates: CoverFeeRates | undefined): boolean {
  return !!rates && ACCEPTED_COVER_FEE_RATES.some((a) =>
    a.stripeBp === rates.stripeBp && a.stripeFixedMinor === rates.stripeFixedMinor && a.radarMinor === rates.radarMinor);
}

/**
 * The "cover the fees" booking fee for a whole order: the smallest fee that
 * leaves the organiser at least `subtotalMinor` after card processing at
 * `rates`, Radar and our platform fee. Per order because Stripe's fixed fee is
 * per payment. Stripe rounds its fee to the nearest minor unit, half up
 * (checked against sandbox balance transactions 2026-10-19), and our fee rounds
 * the same way, so the closed form can land 1p either side - hence the search.
 */
export function coverFeeMinor(subtotalMinor: number, rates: CoverFeeRates): number {
  const fixed = rates.stripeFixedMinor + rates.radarMinor;
  const platform = platformFeeMinor(subtotalMinor);
  const net = (fee: number) => {
    const total = subtotalMinor + fee;
    return total - Math.round((total * rates.stripeBp) / 10_000) - fixed - platform;
  };
  const closed = Math.ceil(((PLATFORM_FEE_BP + rates.stripeBp) * subtotalMinor + 10_000 * fixed) / (10_000 - rates.stripeBp));
  let fee = Math.max(0, closed - 3);
  while (net(fee) < subtotalMinor) fee++;
  return fee;
}

export interface CardOrderAmounts {
  mode: BookingFeeMode;
  /** Percent mode only; 0 otherwise. */
  feePercent: number;
  /** Per-ticket line: the ticket price, plus the % fee in percent mode. */
  unitChargeMinor: number;
  /** Separate order-level "Booking fee" line in cover mode; 0 otherwise. */
  orderFeeMinor: number;
  /** All booking fee in the order, either mode. */
  bookingFeeMinor: number;
  /** What the buyer pays. */
  totalMinor: number;
  applicationFeeMinor: number;
}

/**
 * What a card order costs, in minor units: the one arithmetic the checkout
 * charges (apps/server checkout-fees.ts) and every receipt and listing shows.
 * Organiser Terms §6 states it. Percent mode rounds per ticket and folds into
 * the ticket line; cover mode is one order-level line.
 */
export function cardOrderAmounts(payment: FeeSettings, unitMinor: number, quantity: number): CardOrderAmounts {
  const qty = Math.max(1, quantity);
  const subtotal = unitMinor * qty;
  const mode = bookingFeeMode(payment);
  const feePercent = bookingFeePercent(payment);
  const unitFee = Math.round((unitMinor * feePercent) / 100);
  const orderFee = mode === "cover" ? coverFeeMinor(subtotal, payment.coverFees!) : 0;
  return {
    mode,
    feePercent,
    unitChargeMinor: unitMinor + unitFee,
    orderFeeMinor: orderFee,
    bookingFeeMinor: unitFee * qty + orderFee,
    totalMinor: (unitMinor + unitFee) * qty + orderFee,
    applicationFeeMinor: platformFeeMinor(subtotal),
  };
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
 * headline price). It is a one-ticket order, so in cover mode it is the
 * highest per-ticket price: buying more never costs more per ticket.
 */
export function headlinePrice(payment: PaymentConfig | undefined): HeadlinePrice | null {
  if (!payment) return null;
  const unit = parseFloat(payment.price);
  if (!unit || unit <= 0) return null;
  const a = cardOrderAmounts(payment, Math.round(unit * 100), 1);
  const sym = CURRENCY_SYMBOLS[payment.currency] ?? `${payment.currency} `;
  const fmt = (cents: number) => `${sym}${(cents / 100).toFixed(2)}`;
  return {
    amount: a.totalMinor / 100,
    label: fmt(a.totalMinor),
    feeLabel: a.bookingFeeMinor > 0 ? fmt(a.bookingFeeMinor) : null,
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
  // Integer cents — the server's arithmetic exactly.
  const a = cardOrderAmounts(payment, Math.round(unit * 100), qty);
  const cardTotal = a.totalMinor / 100;
  const cryptoPlatformFee = (subtotal * PLATFORM_FEE_BP) / 10_000;
  return {
    qty,
    baseLabel: qty > 1 ? `Tickets (×${qty})` : "Ticket",
    base: fmt(subtotal),
    unit: fmt(unit),
    feePercent: a.feePercent,
    feeRowLabel: a.mode === "percent" ? `Booking fee (${a.feePercent}%)` : a.mode === "cover" ? "Booking fee" : null,
    fee: fmt(a.bookingFeeMinor / 100),
    platform: fmt(cryptoPlatformFee),
    cardTotal: payment.stripeEnabled ? fmt(cardTotal) : null,
    cryptoTotal:
      FEATURES.cryptoPaymentsAllowed && payment.cryptoEnabled ? fmt(subtotal + cryptoPlatformFee) : null,
  };
}
