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
  // Trimmed for the same reason as the marketing address: a whitespace-only
  // value in an env_file is truthy, and here it would skip the default and
  // reach `createJob`'s empty-sender throw as an unhandled 500.
  return (
    (process.env.EMAIL_FROM || "").trim() ||
    (process.env.RESEND_FROM || "").trim() ||
    "events@woco-net.com"
  );
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
 * because `KEY=` and `KEY="   "` are both things an env file expresses easily
 * and both mean "not configured" — a truthiness test alone would read either as
 * an address and hand it to the provider.
 */
export function getMarketingFromAddress(): string | null {
  const configured = (process.env.EMAIL_FROM_MARKETING || process.env.RESEND_FROM_MARKETING || "").trim();
  return configured || null;
}

/**
 * `/api/health` → `email.marketingSender`. A fail-closed nobody can see is a
 * mystery outage: without this, "why can no organiser broadcast" is answered by
 * reading source. Reports the flag and the key to set, never the address —
 * this endpoint is public.
 *
 * Organisers with their own verified domain are unaffected either way, so
 * `ok: false` means the PLATFORM marketing lane is refusing, not that every
 * send is.
 */
export function marketingSenderHealth(): { ok: boolean; reason?: string } {
  if (getMarketingFromAddress()) return { ok: true };
  return {
    ok: false,
    reason: "EMAIL_FROM_MARKETING is not set — platform marketing sends are refused",
  };
}

/**
 * Boot-time counterpart, logged beside the provider check. The health flag
 * needs somebody to curl it; the deploy log is what an operator is already
 * watching at STEP 3. Non-fatal by design — transactional email is unaffected.
 */
export function checkMarketingSenderConfig(): boolean {
  const health = marketingSenderHealth();
  if (!health.ok) {
    console.warn(`[email] ${health.reason} (organisers with a verified domain are unaffected)`);
  }
  return health.ok;
}
