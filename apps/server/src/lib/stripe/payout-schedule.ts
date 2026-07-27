/**
 * Puts a connected account on a manual payout schedule.
 *
 * `interval: "manual"` means Stripe never moves the organiser's money on its own
 * — we release it with `POST /v1/payouts` after the event (see payout-release.ts).
 * Stripe's support recommended exactly this for future-delivery businesses like
 * ticketing (docs/PRICING_AND_EMAIL.md §15).
 *
 * ⚠️ WHAT THIS DOES NOT DO — read before relying on it as a control.
 * A manual schedule stops AUTOMATIC payouts. It does not stop the organiser from
 * initiating their own payout from the Express Dashboard. Stripe, verbatim:
 * "Connected accounts can still make manual payouts after you, as the platform,
 * choose to restrict connected accounts from updating their own payout schedule."
 * Locking that down is not self-serve — it needs a support request
 * (https://docs.stripe.com/connect/platform-controls-for-stripe-dashboard-accounts).
 * Until Stripe grants it, this is the DEFAULT funds sit under, not a guarantee
 * they stay there. Tracked in docs/PAYOUTS.md §"Open with Stripe".
 */

import { getStripe } from "./client.js";

/**
 * Set `settings.payouts.schedule.interval = "manual"`.
 *
 * We stay on Accounts v1 (`type: "express"`), so this uses the v1 `settings.payouts`
 * hash rather than the newer Balance Settings API. Stripe supports both: "If you're
 * currently using settings.payouts on Accounts v1, you can continue to do so."
 *
 * Idempotent and safe to call repeatedly — setting an already-manual schedule is a
 * no-op at Stripe. Never throws: a failure here must not break onboarding or a
 * webhook, but it MUST be loud, because the account is then on Stripe's default
 * fast schedule and its funds are not being held at all.
 */
export async function ensureManualPayoutSchedule(stripeAccountId: string): Promise<boolean> {
  try {
    const s = getStripe();
    await s.accounts.update(stripeAccountId, {
      settings: { payouts: { schedule: { interval: "manual" } } },
    });
    return true;
  } catch (err) {
    console.error(
      `[payout-schedule] FAILED to set manual payouts on ${stripeAccountId} — ` +
        `this account is on Stripe's automatic schedule and its funds are NOT held:`,
      err,
    );
    return false;
  }
}

/** True when the account is confirmed on a manual schedule at Stripe. */
export async function isManualPayoutSchedule(stripeAccountId: string): Promise<boolean | null> {
  try {
    const s = getStripe();
    const account = await s.accounts.retrieve(stripeAccountId);
    return account.settings?.payouts?.schedule?.interval === "manual";
  } catch (err) {
    console.error(`[payout-schedule] Could not read schedule for ${stripeAccountId}:`, err);
    return null;
  }
}
