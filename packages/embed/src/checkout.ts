/**
 * DOM-free decision logic for the buy flow — the rules that decide what the
 * widget may sell, what it sends, and when a failed seat hold stops a
 * purchase. Kept out of the custom element so they are testable (same shape
 * as count/display.ts) and so the wire contract with create-checkout is
 * pinned in one place.
 */

import {
  calculateBuyerFees,
  orderFormShown,
  resolveBuyerEmail,
  ORDER_EMAIL_FIELD_ID,
  type OrderField,
  type PaymentConfig,
  type SealedBox,
} from "@woco/shared";

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

export type BuyPanelVerdict = { ok: true; email: string } | { ok: false; error: string };

/**
 * The buy panel's checks, top to bottom in the order the buyer sees them, so
 * the first message names the first thing to fix (#597).
 *
 * The ticket address comes from the shared rule (`resolveBuyerEmail`): the
 * order form's own email field when the form shows one, else the widget's box.
 * This widget has no wallet or account path, so that field is required here
 * whatever the organiser ticked - it is the only way the ticket can arrive.
 */
export function validateBuyPanel(i: {
  fields: readonly OrderField[] | undefined;
  encryptionKey: string | undefined;
  formData: Record<string, string>;
  inlineEmail: string;
}): BuyPanelVerdict {
  if (orderFormShown(i.fields, i.encryptionKey)) {
    for (const f of i.fields!) {
      const isEmail = f.id === ORDER_EMAIL_FIELD_ID;
      // Never an internal id: OrderFieldsEditor starts every field with label "".
      const label = f.label || f.placeholder || (isEmail ? "Email" : "This field");
      const value = (i.formData[f.id] ?? "").trim();
      if ((f.required || isEmail) && !value) return { ok: false, error: `${label} is required` };
      if (isEmail && !resolveBuyerEmail(i.formData, i.fields, i.encryptionKey, "")) {
        return { ok: false, error: `Enter a valid email address in ${label}` };
      }
    }
  }
  const email = resolveBuyerEmail(i.formData, i.fields, i.encryptionKey, i.inlineEmail);
  return email ? { ok: true, email } : { ok: false, error: "Enter a valid email address" };
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
  /** The organiser page the buyer is on (see resolvePageUrl), when it is known. */
  pageUrl?: string;
  encryptedOrder?: SealedBox;
  reservationId?: string;
}

/**
 * The exact create-checkout wire body. No returnUrl and no cancelUrl: the server
 * derives both Stripe redirects from `pageUrl` (#567), and without a page it
 * sends the buyer to the WoCo pages — the ticket email is the durable artifact
 * either way.
 */
export function buildCheckoutBody(i: CheckoutBodyInputs): Record<string, unknown> {
  const body: Record<string, unknown> = {
    eventId: i.eventId,
    seriesId: i.seriesId,
    claimerEmail: i.claimerEmail,
    marketingConsent: i.marketingConsent,
  };
  if (i.pageUrl) body.pageUrl = i.pageUrl;
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

// ---------------------------------------------------------------------------
// Returning from Stripe (#567)
// ---------------------------------------------------------------------------

function httpUrl(raw: string): string | undefined {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The organiser page the buyer is on. Inside the /embed/frame iframe the frame's
 * own URL is WoCo's, never the organiser's, so only the snippet's `page-url` can
 * name the page there; without it the server's WoCo pages apply.
 */
export function resolvePageUrl(pageUrlAttr: string | null, href: string, framed: boolean): string | undefined {
  const named = pageUrlAttr ? httpUrl(pageUrlAttr) : undefined;
  if (named) return named;
  return framed ? undefined : httpUrl(href);
}

export type ReturnMarker = { kind: "success"; sessionId: string } | { kind: "cancelled" };

/** The return marker the server put in the page's query, when this page load is a return from Stripe. */
export function parseReturn(pageUrl: string | undefined): ReturnMarker | null {
  if (!pageUrl) return null;
  let params: URLSearchParams;
  try {
    params = new URL(pageUrl).searchParams;
  } catch {
    return null;
  }
  const marker = params.get("woco");
  if (marker === "cancelled") return { kind: "cancelled" };
  if (marker !== "success") return null;
  const sessionId = params.get("session_id") ?? "";
  return /^cs_(?:test|live)_[A-Za-z0-9]{10,200}$/.test(sessionId) ? { kind: "success", sessionId } : null;
}

/** `href` without the return marker, every other query pair and the hash left as they were. */
export function withoutReturnMarker(href: string): string {
  const hashAt = href.indexOf("#");
  const beforeHash = hashAt === -1 ? href : href.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : href.slice(hashAt);
  const q = beforeHash.indexOf("?");
  if (q === -1) return href;
  const kept = beforeHash
    .slice(q + 1)
    .split("&")
    .filter((pair) => {
      const key = pair.split("=")[0];
      return pair !== "" && key !== "woco" && key !== "session_id";
    })
    .join("&");
  return `${beforeHash.slice(0, q)}${kept ? `?${kept}` : ""}${hash}`;
}

export type ReturnView =
  | { kind: "checking" }
  | { kind: "paid"; quantity: number; emailMasked: string | null }
  | { kind: "unpaid" }
  | { kind: "unconfirmed" };

/**
 * What the widget may say about a return, from the server's answer alone. A
 * marker in the URL proves nothing was paid, so anything short of a well-formed
 * confirmation reads as "unconfirmed", never "paid".
 */
export function returnView(resp: { ok: boolean; data?: unknown } | null): ReturnView {
  const d = resp?.ok && resp.data && typeof resp.data === "object" ? resp.data as Record<string, unknown> : null;
  if (!d) return { kind: "unconfirmed" };
  if (d.status === "open" || d.status === "expired") return { kind: "unpaid" };
  if (d.status !== "paid" || !Number.isInteger(d.quantity) || (d.quantity as number) < 1) {
    return { kind: "unconfirmed" };
  }
  return {
    kind: "paid",
    quantity: d.quantity as number,
    emailMasked: typeof d.emailMasked === "string" ? d.emailMasked : null,
  };
}
