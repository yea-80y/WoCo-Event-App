import { Resend } from "resend";

let _resend: Resend | null = null;

export function getResend(): Resend {
  if (!_resend) {
    const key = process.env.RESEND_API_KEY;
    if (!key) throw new Error("RESEND_API_KEY is not set");
    _resend = new Resend(key);
  }
  return _resend;
}

/**
 * `EMAIL_FROM` is the provider-neutral name; `RESEND_FROM` is still read so the
 * SES cutover does not require an env rename in the same change. Drop the
 * fallback when the Resend adapter goes.
 */
export function getFromAddress(): string {
  return process.env.EMAIL_FROM || process.env.RESEND_FROM || "events@woco-net.com";
}

/**
 * Marketing from-address, or `null` when the platform has not configured one.
 *
 * It deliberately does NOT fall back to the transactional address. That
 * fallback is what the name hides: the address returned here fronts imported
 * cold lists, whose complaint and bounce rates are what burn a domain — and
 * the transactional address is the one that delivers everybody's tickets. A
 * platform-tier organiser has no sending domain of their own, so every one of
 * them shares this single reputation; putting their marketing on the ticket
 * domain puts event-day ticket delivery in the spam folder.
 *
 * `null` is a refusal, not a default. Callers that legitimately want the
 * transactional address must say so at the call site — see the event lane in
 * `routes/broadcast-jobs.ts`.
 *
 * `EMAIL_FROM_MARKETING` is the provider-neutral name; `RESEND_FROM_MARKETING`
 * is still read so the SES cutover did not require an env rename. Trimmed
 * because production carries the key with an EMPTY value, and a whitespace
 * value is the same non-answer.
 */
export function getMarketingFromAddress(): string | null {
  const configured = (process.env.EMAIL_FROM_MARKETING || process.env.RESEND_FROM_MARKETING || "").trim();
  return configured || null;
}
