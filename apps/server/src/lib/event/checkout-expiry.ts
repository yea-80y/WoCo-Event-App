/**
 * Checkout-Session expiry clamp (#300).
 *
 * The #241 gate refuses to CREATE a session for an ended event, but a session
 * created moments before the end stayed payable long after it: create-checkout
 * set no `expires_at`, and Stripe's default is 24 hours from creation. A buyer
 * paying in that window is money-correct today (webhook → mint reverts
 * `SalesClosed` → full auto-refund) but it is the charge-then-refund path by
 * design, and the sponsor wallet pays gas for a doomed transaction. Clamping
 * expiry to the event's end shrinks the pay-after-end window from 24 h to the
 * floor below.
 *
 * Stripe contract (API ref, `POST /v1/checkout/sessions`, verified 2026-08-17):
 * `expires_at` is epoch SECONDS and "can be anywhere from 30 minutes to
 * 24 hours after Checkout Session creation"; the default is 24 hours. The
 * 30-minute floor is structural — a ≤30-minute pay-after-end window cannot be
 * configured away, and the webhook's auto-refund keeps covering it.
 */

import { salesEndMs, SALES_END_GRACE_MS } from "./sales-window.js";

/** Stripe's hard floor for `expires_at` (seconds after creation). */
export const CHECKOUT_EXPIRES_MIN_S = 30 * 60;
/** Stripe's default and ceiling (seconds after creation). */
export const CHECKOUT_EXPIRES_MAX_S = 24 * 60 * 60;
/**
 * Margin added above Stripe's floor. Stripe validates the floor against ITS
 * clock at API time; a server clock running ahead would make an exactly-30:00
 * value land under 30 minutes on Stripe's side and fail the whole checkout
 * call. Two minutes of slack costs the buyer nothing and removes the edge.
 */
export const CHECKOUT_EXPIRES_SKEW_S = 120;

/**
 * The `expires_at` create-checkout should send for this event, in epoch
 * seconds — or `undefined` to let Stripe's 24 h default stand.
 *
 * `undefined` in two cases, both deliberate:
 *  - the event's end doesn't parse: the #241 gate has already refused undated
 *    events before this runs, so this is unreachable belt-and-braces — never a
 *    reason to fail a checkout that every other gate passed;
 *  - the end is 24 h+ away: the default already expires no later than the end.
 *
 * Otherwise `clamp(end, now + 30min + skew, now + 24h)` — the session dies at
 * the event's end, but never below Stripe's floor.
 *
 * `chainEndMs` (#294) is the contract's immutable `eventEndTs`: when known it
 * CAPS the feed end, so an endDate extended past the registered close cannot
 * stretch the session's life into the every-mint-reverts window. Null/absent
 * = unknown — the feed end stands alone, as before.
 */
export function checkoutExpiresAt(
  event: { startDate?: string; endDate?: string },
  nowMs: number = Date.now(),
  chainEndMs?: number | null,
): number | undefined {
  const feedEndMs = salesEndMs(event) + SALES_END_GRACE_MS;
  const endMs =
    typeof chainEndMs === "number" && !Number.isNaN(feedEndMs)
      ? Math.min(feedEndMs, chainEndMs)
      : typeof chainEndMs === "number"
        ? chainEndMs
        : feedEndMs;
  if (Number.isNaN(endMs)) return undefined;
  const nowS = Math.floor(nowMs / 1000);
  // Ceil: a fractional-second end must round AWAY from cutting the sale short.
  const endS = Math.ceil(endMs / 1000);
  if (endS >= nowS + CHECKOUT_EXPIRES_MAX_S) return undefined;
  return Math.max(endS, nowS + CHECKOUT_EXPIRES_MIN_S + CHECKOUT_EXPIRES_SKEW_S);
}
