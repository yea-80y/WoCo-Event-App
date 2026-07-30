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
 * Marketing from-address — kept separate from transactional so a bad campaign
 * can never tank ticket-delivery reputation. Falls back to the transactional
 * address until RESEND_FROM_MARKETING is configured (DNS split must happen
 * BEFORE the first imported cold list is emailed).
 */
export function getMarketingFromAddress(): string {
  return process.env.EMAIL_FROM_MARKETING || process.env.RESEND_FROM_MARKETING || getFromAddress();
}
