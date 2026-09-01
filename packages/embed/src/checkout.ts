/**
 * DOM-free decision logic for the buy flow — the rules that decide what the
 * widget may sell, what it sends, and when a failed seat hold stops a
 * purchase. Kept out of the custom element so they are testable (same shape
 * as count/display.ts) and so the wire contract with create-checkout is
 * pinned in one place.
 */

import { calculateBuyerFees, type PaymentConfig, type SealedBox } from "@woco/shared";

/** Server-side clamp is RESERVATION_MAX_QTY / create-checkout's own max(10). */
export const MAX_QTY = 10;

/**
 * A series is sellable here only when a card checkout can actually complete:
 * Stripe enabled and price > 0. `cardTotal` is null otherwise — which also
 * keeps a crypto-only series unsellable while the crypto rail is feature-
 * flagged off, without this module restating the flag.
 */
export function seriesPayable(payment: PaymentConfig | undefined): boolean {
  return !!calculateBuyerFees(payment, 1)?.cardTotal;
}

/** Trimmed email, or null when it cannot receive a ticket. */
export function validateEmail(raw: string): string | null {
  const email = raw.trim();
  return email && email.includes("@") ? email : null;
}

/** Quantity the picker may offer: 1..min(10, available), never below 1. */
export function maxSelectableQty(available: number): number {
  return Math.max(1, Math.min(MAX_QTY, Number.isFinite(available) ? available : MAX_QTY));
}

/**
 * The sealed-order payload — mirrors the main checkout's inline seal
 * (ClaimButton) so the organiser dashboard decrypts both identically.
 */
export function buildOrderPayload(
  formData: Record<string, string>,
  seriesId: string,
  claimerEmail: string,
): { fields: Record<string, string>; seriesId: string; claimerEmail: string } {
  return { fields: formData, seriesId, claimerEmail };
}

export interface CheckoutBodyInputs {
  eventId: string;
  seriesId: string;
  claimerEmail: string;
  quantity: number;
  /** The consent box was rendered, so the opt-out WAS offered — an untouched
   *  box is an explicit refusal (recorded as a suppression), not "never asked". */
  marketingConsent: boolean;
  /** The organiser's page URL — Stripe's cancel button returns the buyer
   *  exactly there. The server falls back to the platform event page if it
   *  is not a well-formed https URL. */
  cancelUrl: string;
  encryptedOrder?: SealedBox;
  reservationId?: string;
}

/**
 * The exact create-checkout wire body. Deliberately NO returnUrl: the
 * organiser's domain cannot be in ALLOWED_HOSTS, so the server would refuse
 * it — omitting it selects the platform's purchased page, and the ticket
 * email is the durable artifact either way.
 */
export function buildCheckoutBody(i: CheckoutBodyInputs): Record<string, unknown> {
  const body: Record<string, unknown> = {
    eventId: i.eventId,
    seriesId: i.seriesId,
    claimerEmail: i.claimerEmail,
    cancelUrl: i.cancelUrl,
    marketingConsent: i.marketingConsent,
  };
  if (i.quantity > 1) body.quantity = i.quantity;
  if (i.encryptedOrder) body.encryptedOrder = i.encryptedOrder;
  if (i.reservationId) body.reservationId = i.reservationId;
  return body;
}

export type ReserveOutcome =
  | { kind: "reserved"; reservationId: string }
  | { kind: "blocked"; message: string }
  | { kind: "proceed" };

/**
 * What a seat-hold response means for the purchase. A definitive "not enough
 * seats" stops it honestly ("Insufficient seats" is the route's stable API
 * literal). Anything else — rate limit, sales-window refusal, network
 * failure, malformed body — proceeds WITHOUT a hold: create-checkout runs
 * its own availability and sales-window checks and refuses with its own
 * message, and the contract re-checks supply at mint, so a broken
 * reservation service must never block a sale it cannot protect.
 */
export function reserveOutcome(
  resp: { ok: boolean; error?: string; data?: { reservationId?: string } } | null,
): ReserveOutcome {
  if (resp?.ok && resp.data?.reservationId) {
    return { kind: "reserved", reservationId: resp.data.reservationId };
  }
  if (resp && !resp.ok && resp.error === "Insufficient seats") {
    return { kind: "blocked", message: "Not enough tickets left at this quantity" };
  }
  return { kind: "proceed" };
}
