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
import {
  bindCheckout,
  getReservation,
  markCheckoutClosed,
  MAX_SESSIONS_PER_HOLD,
  SEAT_SALES_PAUSED,
  type HoldCheckout,
  type Reservation,
  type SeatedHoldSeat,
  type SessionExpiry,
} from "../event/reservation-store.js";
import { expireCheckoutSession } from "../stripe/checkout-session-expire.js";

export const PRICES_CHANGED = "Seat prices for this event have changed. Hold your seats again to see the new prices.";

type FeeSettings = Pick<PaymentConfig, "currency" | "feePassedToCustomer" | "buyerFeePercent" | "coverFees">;

/** Everything besides the band prices that a seated hold's amounts depend on, as one comparable value. */
export function holdFeeKey(p: FeeSettings): string {
  const c = p.coverFees;
  return JSON.stringify([p.currency, !!p.feePassedToCustomer, p.buyerFeePercent ?? null, c ? [c.stripeBp, c.stripeFixedMinor, c.radarMinor] : null]);
}

type Refusal = { status: 409 | 410 | 503; body: { ok: false; error: string; code?: string } };
const refusal = (status: Refusal["status"], error: string, code?: string): Refusal =>
  ({ status, body: { ok: false, error, ...(code ? { code } : {}) } });

/**
 * Whether this checkout may sell the seated hold it names: the hold must be a seated one
 * on the registration's pinned plan, on ledger2, under its session cap, at the prices it
 * pinned, with the hold file readable. Null = go on.
 */
export function seatedCheckoutRefusal(a: {
  held: Reservation | null;
  pin: { planDigest: string };
  contractVersion: string;
  persisting: boolean;
  feedSeating: unknown;
  feedPayment: FeeSettings | undefined;
}): Refusal | null {
  const h = a.held;
  if (!h?.seats || !h.seatInfo || h.planDigest !== a.pin.planDigest || a.contractVersion !== "ledger2") {
    return refusal(409, "Choose your seats again to continue.", "SEATS_REQUIRED");
  }
  if (!a.persisting) return refusal(503, SEAT_SALES_PAUSED);
  if ((h.checkout?.sessions ?? 0) >= MAX_SESSIONS_PER_HOLD) return refusal(409, "Hold your seats again to continue.", "HOLD_AGAIN");
  const priceProblem = seatedPriceRefusal(h, a.feedSeating, a.feedPayment);
  return priceProblem ? refusal(409, priceProblem, "PRICES_CHANGED") : null;
}

/**
 * One payable session per seated hold: the one it has is closed at Stripe first
 * ("complete" = it was paid, no second sale of the same seats), the new one is created,
 * then bound to the hold in one step - or closed at once if the hold ran out meanwhile,
 * never left payable. `create` throwing is the caller's (nothing was bound). The hold is
 * read afresh here: another tab may have bound a session since the route's gates read it.
 */
export async function openSeatedSession<S extends { id: string; expires_at?: number | null }>(
  holdId: string,
  account: string,
  expiresAtS: number,
  create: () => Promise<S>,
  deps: {
    get(id: string): Reservation | null;
    expire(c: HoldCheckout): Promise<SessionExpiry>;
    markClosed(id: string, sessionId: string): void;
    bind: typeof bindCheckout;
  } = { get: getReservation, expire: expireCheckoutSession, markClosed: markCheckoutClosed, bind: bindCheckout },
): Promise<{ ok: true; session: S } | ({ ok: false } & Refusal)> {
  const hold = deps.get(holdId);
  if (!hold) return { ok: false, ...refusal(410, "Your hold on these seats ran out. Hold them again to continue.", "HOLD_EXPIRED") };
  const prev = hold.checkout ?? null;
  if (prev && Date.parse(prev.expiresAt) > Date.now()) {
    const closed = await deps.expire(prev);
    if (closed === "complete") return { ok: false, ...refusal(409, "These seats have been paid for. Your tickets are on the way by email.", "HOLD_PAID") };
    if (closed === "error") return { ok: false, ...refusal(503, "We couldn't start a new payment just now. Try again in a moment.") };
    deps.markClosed(hold.id, prev.sessionId);
  }
  const session = await create();
  const expiresAtMs = (session.expires_at ?? expiresAtS) * 1000;
  if (!deps.bind(hold.id, prev?.sessionId ?? null, { sessionId: session.id, account, expiresAtMs })) {
    await deps.expire({ sessionId: session.id, account, expiresAt: new Date(expiresAtMs).toISOString(), sessions: 1 });
    return { ok: false, ...refusal(410, "Your hold on these seats ran out. Hold them again to continue.", "HOLD_EXPIRED") };
  }
  return { ok: true, session };
}

/**
 * Why the hold's pinned prices or fee settings are no longer the feed's, or null when
 * they are: the hold's figures are the only ones a page showed, so checkout charges
 * those or none. Also decides whether a hold may come back as it is (`reserveSeats`).
 */
export function seatedPriceRefusal(
  h: Pick<Reservation, "seatInfo" | "feeKey">,
  seating: unknown,
  payment: FeeSettings | undefined,
): string | null {
  const info = h.seatInfo;
  if (!info || !payment || h.feeKey !== holdFeeKey(payment)) return PRICES_CHANGED;
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
