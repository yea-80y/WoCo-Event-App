/**
 * Payout timing policy — the constants that decide when organiser funds move.
 *
 * WoCo puts every connected account on `interval: "manual"` and releases funds
 * with `POST /v1/payouts` after the event has happened. This is Stripe's own
 * recommended pattern for future-delivery businesses (their support, 2026-07-27,
 * quoted in docs/PRICING_AND_EMAIL.md §15) and it avoids the `delay_days`
 * ceiling, which self-serve caps at 7 days.
 *
 * ⚠️ Two hard limits from Stripe's documentation live in this file. Both are
 * external constraints, not preferences — read docs/PAYOUTS.md before changing
 * either.
 */

/**
 * Stripe's documented maximum period funds may sit in a connected account's
 * balance under a manual payout schedule, keyed by the BUSINESS's country.
 *
 * Source: https://docs.stripe.com/connect/manual-payouts — "You must pay out
 * the funds within the time period specified below, based on the business's
 * country." Verified 2026-07-27.
 *
 * This is the reason WoCo cannot hold festival/early-bird money until the event
 * when tickets go on sale more than ~3 months ahead: a UK organiser's funds must
 * be paid out within 90 days of the charge, event date notwithstanding.
 */
const MAX_HOLD_DAYS_BY_COUNTRY: Record<string, number> = {
  TH: 10,
  US: 730,
};

/** Applied when the account's country is unknown or not listed above. */
const MAX_HOLD_DAYS_DEFAULT = 90;

/**
 * Margin subtracted from Stripe's ceiling so a missed job run, an API outage or
 * a weekend cannot push us past the documented limit. Breaching the ceiling is
 * a compliance problem, so the release job errs early rather than late.
 */
const HOLD_CEILING_SAFETY_DAYS = 7;

/**
 * Delay after an event ENDS before its takings are released. Covers same-night
 * no-show/refund requests and gives the organiser's own cancellation window time
 * to close before the money leaves reach.
 */
export const POST_EVENT_RELEASE_DAYS = 2;

/**
 * Shop/POS orders are immediate-delivery goods with no event date, so the
 * event-based hold makes no sense for them — but they settle into the SAME
 * connected-account balance, which `interval: "manual"` freezes wholesale.
 * Without an explicit rule a merchant's shop takings would never pay out.
 */
export const SHOP_RELEASE_DAYS = 7;

/**
 * Used when an event carries no usable start or end date. Not expected — event
 * creation requires dates — but a malformed feed must not strand money forever
 * or dump it out the next minute.
 */
export const FALLBACK_RELEASE_DAYS = 14;

const DAY_MS = 86_400_000;

/** Stripe's hold ceiling for a country, in days, before our safety margin. */
export function maxHoldDays(country?: string): number {
  if (!country) return MAX_HOLD_DAYS_DEFAULT;
  return MAX_HOLD_DAYS_BY_COUNTRY[country.toUpperCase()] ?? MAX_HOLD_DAYS_DEFAULT;
}

/**
 * The latest moment we may still be holding a charge's funds. Measured from when
 * the money landed (the charge), not from the event date.
 */
export function holdCeilingAt(recordedAt: string, country?: string): string {
  const budget = Math.max(1, maxHoldDays(country) - HOLD_CEILING_SAFETY_DAYS);
  return new Date(new Date(recordedAt).getTime() + budget * DAY_MS).toISOString();
}

/**
 * When an event's takings become releasable: event end + POST_EVENT_RELEASE_DAYS.
 * Falls back to startDate (a single-session event has no separate end) and then
 * to FALLBACK_RELEASE_DAYS if neither date parses.
 */
export function eventReleaseAfter(
  recordedAt: string,
  endDate?: string,
  startDate?: string,
): string {
  const anchor = firstValidDate(endDate, startDate);
  if (anchor === null) {
    return new Date(new Date(recordedAt).getTime() + FALLBACK_RELEASE_DAYS * DAY_MS).toISOString();
  }
  return new Date(anchor + POST_EVENT_RELEASE_DAYS * DAY_MS).toISOString();
}

/** When a shop order's takings become releasable. */
export function shopReleaseAfter(recordedAt: string): string {
  return new Date(new Date(recordedAt).getTime() + SHOP_RELEASE_DAYS * DAY_MS).toISOString();
}

function firstValidDate(...candidates: Array<string | undefined>): number | null {
  for (const c of candidates) {
    if (!c) continue;
    const t = new Date(c).getTime();
    if (Number.isFinite(t)) return t;
  }
  return null;
}
