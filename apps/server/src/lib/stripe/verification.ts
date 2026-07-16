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
