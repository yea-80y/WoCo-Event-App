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

export function getFromAddress(): string {
  return process.env.RESEND_FROM || "events@woco-net.com";
}

/**
 * Marketing from-address — kept separate from transactional so a bad campaign
 * can never tank ticket-delivery reputation. Falls back to the transactional
 * address until RESEND_FROM_MARKETING is configured (DNS split must happen
 * BEFORE the first imported cold list is emailed).
 */
export function getMarketingFromAddress(): string {
  return process.env.RESEND_FROM_MARKETING || getFromAddress();
}
