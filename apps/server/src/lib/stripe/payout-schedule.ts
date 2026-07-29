/**
 * Puts a connected account on a manual payout schedule.
 *
 * `interval: "manual"` means Stripe never moves the organiser's money on its own
 * — we release it with `POST /v1/payouts` after the event (see payout-release.ts).
 * Stripe's support recommended exactly this for future-delivery businesses like
 * ticketing (docs/PRICING_AND_EMAIL.md §15).
 *
 * On a manual schedule only the platform can move funds: the Express Dashboard
 * cannot self-initiate payouts, and schedule editing is a platform-configurable
 * capability we have not enabled — confirmed in writing by Stripe, 2026-07-29
 * (docs/PAYOUTS.md §3.2). Payout schedules are unaffected by Managed Risk.
 */

import { getStripe } from "./client.js";

/**
 * Set `settings.payouts.schedule.interval = "manual"`.
 *
 * We stay on Accounts v1 (controller-created, Express Dashboard — see
 * lib/stripe/account-params.ts), so this uses the v1 `settings.payouts` hash
 * rather than the newer Balance Settings API. Stripe supports both: "If you're
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
    pendingHeals.delete(stripeAccountId);
    return true;
  } catch (err) {
    pendingHeals.add(stripeAccountId);
    console.error(
      `[payout-schedule] FAILED to set manual payouts on ${stripeAccountId} — ` +
        `this account is on Stripe's automatic schedule and its funds are NOT held. ` +
        `Queued for retry on the next payout sweep:`,
      err,
    );
    return false;
  }
}

/**
 * Accounts whose correction to a manual schedule failed and has not yet
 * succeeded.
 *
 * The `account.updated` webhook fires the correction and does not wait for it.
 * That was fine for the happy path and silent for the failure path: a transient
 * Stripe error meant the account stayed on the automatic schedule, and the next
 * attempt waited for another webhook that might never come — while the
 * organiser's funds paid out on Stripe's fast schedule instead of being held
 * for their event. Retrying from the hourly sweep closes that.
 *
 * In memory on purpose — it is a retry queue, not a record. A restart empties
 * it; the backstops for that are the next `account.updated` webhook and the
 * payout-schedule audit script (PAYOUTS.md §9), which sweeps EVERY account.
 * Persisting the queue would add a store that can itself go stale.
 */
const pendingHeals = new Set<string>();

/** For /api/health — a heal that never succeeds means funds are not being held. */
export function pendingScheduleHeals(): string[] {
  return [...pendingHeals];
}

/**
 * Retry every queued correction. Called from the hourly payout sweep.
 *
 * Each attempt re-enters `ensureManualPayoutSchedule`, so a success removes
 * itself from the queue and a failure leaves it for the next sweep.
 */
export async function retryPendingScheduleHeals(): Promise<{ attempted: number; healed: number }> {
  const queued = [...pendingHeals];
  let healed = 0;
  for (const accountId of queued) {
    if (await ensureManualPayoutSchedule(accountId)) healed++;
  }
  if (queued.length > 0) {
    console.log(`[payout-schedule] Retried ${queued.length} schedule heal(s), ${healed} succeeded`);
  }
  return { attempted: queued.length, healed };
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
