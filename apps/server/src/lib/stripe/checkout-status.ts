/**
 * What a buyer returning from Stripe may be shown about their order (#567).
 *
 * The session id reaches this route from a page URL on a host WoCo does not
 * control, where it can land in logs and analytics, so the answer is limited to
 * what the buyer needs to recognise their own purchase: whether it was paid, how
 * many tickets, and a masked address. Never the full email, the claimer address,
 * the order ref, the reservation id, the account id or the onchain id.
 */

export interface CheckoutStatusView {
  status: "paid" | "open" | "expired";
  quantity: number;
  seriesId: string;
  emailMasked: string | null;
}

/** A Checkout Session id as Stripe issues them (`cs_test_…` / `cs_live_…`). */
export function isCheckoutSessionId(raw: unknown): raw is string {
  return typeof raw === "string" && /^cs_(?:test|live)_[A-Za-z0-9]{10,200}$/.test(raw);
}

/** `n***@example.com`: enough to recognise, not enough to learn an address. */
export function maskEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim();
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) return null;
  return `${email[0]}***${email.slice(at)}`;
}

interface SessionLike {
  status?: string | null;
  payment_status?: string | null;
  metadata?: Record<string, string> | null;
}

/** The view of `session` for `eventId`, or null when the session belongs to another event. */
export function checkoutStatusView(session: SessionLike, eventId: string): CheckoutStatusView | null {
  const md = session.metadata ?? {};
  if (!eventId || md.eventId !== eventId) return null;
  const qty = Number.parseInt(md.quantity ?? "", 10);
  const status =
    session.status === "expired"
      ? "expired"
      : session.status === "complete" && session.payment_status === "paid"
        ? "paid"
        : "open";
  return {
    status,
    quantity: Number.isInteger(qty) && qty >= 1 ? qty : 1,
    seriesId: typeof md.seriesId === "string" ? md.seriesId : "",
    emailMasked: maskEmail(md.claimerEmail),
  };
}
