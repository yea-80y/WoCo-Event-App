/**
 * The parameters every connected account is created with.
 *
 * This is the Managed Risk configuration (issue #90). The controller block is
 * the load-bearing part: `type: "express"` is INCOMPATIBLE with Managed Risk
 * because it bakes in `controller.losses.payments = "application"` — the
 * platform stays liable for unrecoverable negative balances forever, and an
 * account cannot be converted after creation.
 *
 *   controller[stripe_dashboard][type]  = full      → the organiser's own Stripe Dashboard (#645)
 *   controller[fees][payer]             = account   → organiser pays Stripe processing fees
 *   controller[losses][payments]        = stripe    → Stripe absorbs unrecoverable negative balances
 *   controller[requirement_collection]  = stripe    → Stripe-hosted onboarding collects KYC
 *
 * `full` replaced `none` (owner decision 2026-08-25, #645): organisers refund,
 * answer disputes and run Radar in their own dashboard. Two things `none` gave
 * us structurally now rest elsewhere:
 *  - who created a Checkout Session: the webhook proves it
 *    (checkout-provenance.ts), since an organiser can now create their own.
 *  - no self-payout: the platform's Connect dashboard settings turn payouts and
 *    API access off for connected accounts (PAYOUTS.md §4.1). Without that
 *    setting an organiser could pay out before their event.
 * The dashboard type is fixed at creation; an older `none` account is retired,
 * not converted (`isLegacyShape`).
 *
 * Accepted by `accounts.create` in the sandbox 2026-09-23 (Stripe reports it as
 * `type: "standard"`); the manual schedule and our Account Session components
 * work on it, and Express login links do not (organisers sign in to Stripe
 * directly). `application_fee_amount` continues under this configuration —
 * confirmed in writing by Stripe, twice (PRICING_AND_EMAIL.md §17).
 *
 * The manual payout schedule is set at creation so no account is ever briefly
 * on Stripe's automatic schedule (PAYOUTS.md §3.2).
 */

import type Stripe from "stripe";

export const CONNECT_DASHBOARD_TYPE = "full";

export function buildConnectedAccountParams(organiserAddress: string): Stripe.AccountCreateParams {
  return {
    // Required for controller-created accounts — `type: "express"` used to
    // default it, `accounts.create` now rejects the block without it. Country
    // is immutable after creation, so non-UK organisers need a product
    // decision here, not a payload tweak.
    country: "GB",
    controller: {
      stripe_dashboard: { type: CONNECT_DASHBOARD_TYPE },
      fees: { payer: "account" },
      losses: { payments: "stripe" },
      requirement_collection: "stripe",
    },
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    settings: { payouts: { schedule: { interval: "manual" } } },
    metadata: { organiserAddress },
  };
}

/**
 * True when a retrieved account carries the platform-liable legacy shape.
 * Such an account must never belong to a real organiser — it cannot be
 * converted, only retired (scripts/retire-legacy-accounts.ts).
 */
export function isPlatformLiable(account: Stripe.Account): boolean {
  return account.controller?.losses?.payments !== "stripe";
}

/**
 * True when a retrieved account is not the shape this platform creates today:
 * platform-liable, or on any dashboard other than `full`. Neither can be
 * changed after creation, so such an account is retired, never converted
 * (scripts/retire-legacy-accounts.ts).
 */
export function isLegacyShape(account: Stripe.Account): boolean {
  return isPlatformLiable(account) || account.controller?.stripe_dashboard?.type !== CONNECT_DASHBOARD_TYPE;
}
