/**
 * The parameters every connected account is created with.
 *
 * This is the Managed Risk configuration (issue #90). The controller block is
 * the load-bearing part: `type: "express"` is INCOMPATIBLE with Managed Risk
 * because it bakes in `controller.losses.payments = "application"` — the
 * platform stays liable for unrecoverable negative balances forever, and an
 * account cannot be converted after creation. Fully embedded shape confirmed
 * by Stripe support in writing 2026-07-31 (docs/PAYOUTS.md §4.1):
 *
 *   controller[stripe_dashboard][type]  = none      → no Stripe dashboard; embedded components only
 *   controller[fees][payer]             = account   → organiser pays Stripe processing fees
 *   controller[losses][payments]        = stripe    → Stripe absorbs unrecoverable negative balances
 *   controller[requirement_collection]  = stripe    → Stripe-hosted onboarding collects KYC
 *
 * `express` + losses=stripe is REJECTED by accounts.create ("your platform
 * must collect fees and be liable…"); `none` + losses=stripe is accepted —
 * both proven against the sandbox (PAYOUTS.md §4.1, §6.3).
 *
 * `application_fee_amount` continues to work under this configuration —
 * confirmed in writing by Stripe, twice (PRICING_AND_EMAIL.md §17).
 *
 * The manual payout schedule is set at creation so no account is ever briefly
 * on Stripe's automatic schedule; schedules are unaffected by Managed Risk
 * (Stripe chat, 2026-07-29). With no dashboard there is no payout button at
 * all: only the platform can move funds (PAYOUTS.md §3.2, §4.1).
 */

import type Stripe from "stripe";

export function buildConnectedAccountParams(organiserAddress: string): Stripe.AccountCreateParams {
  return {
    // Required for controller-created accounts — `type: "express"` used to
    // default it, `accounts.create` now rejects the block without it. Country
    // is immutable after creation, so non-UK organisers need a product
    // decision here, not a payload tweak.
    country: "GB",
    controller: {
      stripe_dashboard: { type: "none" },
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
