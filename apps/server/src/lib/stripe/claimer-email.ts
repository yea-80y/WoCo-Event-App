/**
 * The guest buyer's address on create-checkout (#638).
 *
 * It becomes the ticket's delivery address, Stripe's `customer_email` and a
 * session metadata value (500-character cap), so the server checks it rather
 * than trusting the clients' `includes("@")`. Same shape test as the marketing
 * send gate (`MAILABLE_EMAIL_RE`: one `@`, a dot in the domain, no whitespace),
 * plus the RFC 5321 path limit. Not trimmed here: both clients trim first, and a
 * value with whitespace would also reach Stripe as-is.
 */

import { MAILABLE_EMAIL_RE } from "@woco/shared";

export const MAX_EMAIL_LENGTH = 254;

/** A sentence the widget can show, or null. Absent is left to the caller's presence check. */
export function claimerEmailRefusal(raw: unknown): string | null {
  if (raw === undefined || raw === "") return null;
  if (typeof raw !== "string" || raw.length > MAX_EMAIL_LENGTH || !MAILABLE_EMAIL_RE.test(raw)) {
    return "Please enter a valid email address.";
  }
  return null;
}
