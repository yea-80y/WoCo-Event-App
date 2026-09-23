/**
 * Stripe organiser verification — the SAME gate paid-event publishing uses
 * (routes/events.ts): a Connect Express account with charges_enabled. Live-check
 * against Stripe so a stale local cache can never grant access; the local record
 * is synced as a side effect. On a Stripe API outage we fall back to the cached
 * onboardingComplete — availability over strictness for a hosting gate (the
 * money-path gate in events.ts stays strict).
 */

import { getStripe } from "./client.js";
import { getStripeAccount, setStripeAccount } from "./accounts.js";

export async function isVerifiedOrganiser(address: string): Promise<boolean> {
  const key = address.toLowerCase();
  const record = getStripeAccount(key);
  if (!record) return false;
  try {
    const account = await getStripe().accounts.retrieve(record.stripeAccountId);
    const verified = !!account.charges_enabled;
    if (verified !== record.onboardingComplete) {
      setStripeAccount(key, record.stripeAccountId, verified);
    }
    return verified;
  } catch (err) {
    const e = err as { statusCode?: number; code?: string };
    if (e?.statusCode === 404 || e?.code === "resource_missing") return false;
    return record.onboardingComplete;
  }
}

/** The code every surface gated on a verified organiser answers with. */
export const STRIPE_VERIFICATION_REQUIRED = "STRIPE_VERIFICATION_REQUIRED";

/**
 * One gate, one refusal shape, per-surface wording: marketing sending and badge
 * minting both refuse an unverified organiser, and neither should carry its own
 * copy of the check or the body. Returns null when the caller may proceed.
 */
export async function refuseUnlessVerifiedOrganiser(
  address: string,
  sentence: string,
): Promise<{ ok: false; error: string; code: string } | null> {
  if (await isVerifiedOrganiser(address)) return null;
  return { ok: false, error: sentence, code: STRIPE_VERIFICATION_REQUIRED };
}
