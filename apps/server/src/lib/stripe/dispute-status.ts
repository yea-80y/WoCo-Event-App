/**
 * One partition of Stripe's dispute statuses (stripe-node Dispute.Status), for
 * both the ticket side (sale-refunds.ts) and the money side (payout-release.ts),
 * so the two cannot drift.
 *
 *   chargeback — funds withdrawn by the buyer's bank and not given back yet
 *   inquiry    — `warning_*`: no funds moved, but it can escalate
 *   open       — outcome not known: chargeback or inquiry, minus `lost`
 *   needs a response — someone must submit evidence before a deadline
 *
 * `won`, `warning_closed`, `prevented` and any status Stripe adds later are none
 * of these.
 */

export const CHARGEBACK_STATUSES: ReadonlySet<string> = new Set(["needs_response", "under_review", "lost"]);
export const INQUIRY_STATUSES: ReadonlySet<string> = new Set(["warning_needs_response", "warning_under_review"]);
export const NEEDS_RESPONSE_STATUSES: ReadonlySet<string> = new Set(["needs_response", "warning_needs_response"]);
export const OPEN_DISPUTE_STATUSES: ReadonlySet<string> = new Set(
  [...CHARGEBACK_STATUSES, ...INQUIRY_STATUSES].filter((s) => s !== "lost"),
);
