/**
 * What a seated hold asks for (docs/SEATING.md "Selling a seat"): the seats by index,
 * and the plan the buyer saw them on. The server holds seats only on the plan it
 * pinned at registration (decision 4); a request naming another plan is refused, so a
 * buyer is never sold seat k of a plan they were not shown.
 *
 * The reserve route refuses seated series until S4 wires this in: this is the
 * contract S4 must honour, pinned now by test/seating/reserve.test.ts.
 */

import { RESERVATION_MAX_QTY } from "../event/reservation.js";
import { CURRENCY_SYMBOLS, type BuyerFees } from "../event/fees.js";
import { isIntIn, isPlainRecord } from "../validate.js";

export interface SeatedReserveRequest {
  /** Ascending, each once, 1..RESERVATION_MAX_QTY of them. */
  seats: number[];
  /** `seatPlanDigest` of the plan the buyer picked on: 0x + 64 lowercase hex. */
  planDigest: string;
}

const DIGEST_RE = /^0x[0-9a-f]{64}$/;

/**
 * The request from an untrusted body, or null. Seats may arrive in any order; they
 * come back sorted. Other body keys (the existing `replaceReservationId`, `siteId`)
 * are the route's business, so only these two are read here.
 */
export function parseSeatedReserve(body: unknown, seatCount: number): SeatedReserveRequest | null {
  if (!isPlainRecord(body)) return null;
  const { seats, planDigest } = body as { seats?: unknown; planDigest?: unknown };
  if (typeof planDigest !== "string" || !DIGEST_RE.test(planDigest)) return null;
  if (!Array.isArray(seats) || seats.length < 1 || seats.length > RESERVATION_MAX_QTY) return null;
  if (!seats.every((k) => isIntIn(k, 0, seatCount - 1))) return null;
  const sorted = [...(seats as number[])].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) if (sorted[i] === sorted[i - 1]) return null;
  return { seats: sorted, planDigest };
}

/**
 * The server's answer to a seated hold (POST .../reserve): each seat's pinned price and
 * charge, and the order's amounts by `cardOrderAmountsMulti` - the only figures a page
 * shows for a seated order, because they are what checkout charges. `checkout`: a
 * Stripe page is open for this hold, so the page offers "Pay" again.
 */
export interface SeatedHold {
  reservationId: string;
  expiresAt: string;
  quantity: number;
  planDigest: string;
  seats: Array<{ seat: number; label: string; band: string; bandName: string; priceMinor: number; chargeMinor: number }>;
  amounts: {
    currency: string;
    mode: string;
    feePercent: number;
    subtotalMinor: number;
    orderFeeMinor: number;
    bookingFeeMinor: number;
    totalMinor: number;
  };
  checkout: boolean;
}

/** A seated hold as the card receipt every checkout panel already draws. */
export function seatedHoldFees(h: Pick<SeatedHold, "quantity" | "amounts">): BuyerFees {
  const a = h.amounts;
  const sym = CURRENCY_SYMBOLS[a.currency] ?? `${a.currency} `;
  const fmt = (minor: number) => `${sym}${(minor / 100).toFixed(2)}`;
  return {
    qty: h.quantity,
    baseLabel: h.quantity > 1 ? `Seats (×${h.quantity})` : "Seat",
    base: fmt(a.subtotalMinor),
    unit: fmt(Math.round(a.subtotalMinor / Math.max(1, h.quantity))),
    feePercent: a.feePercent,
    feeRowLabel: a.mode === "percent" ? `Booking fee (${a.feePercent}%)` : a.mode === "cover" ? "Booking fee" : null,
    fee: fmt(a.bookingFeeMinor),
    platform: "",
    cardTotal: fmt(a.totalMinor),
    cryptoTotal: null,
  };
}

export type SeatedReserveRefusal = "plan_changed";

/**
 * Refuse a hold for a plan other than the registration's pinned one. Returns the
 * reason, or null when the request is for the pinned plan.
 */
export function seatedReserveRefusal(req: SeatedReserveRequest, pin: { planDigest: string }): SeatedReserveRefusal | null {
  return req.planDigest !== pin.planDigest.toLowerCase() ? "plan_changed" : null;
}
