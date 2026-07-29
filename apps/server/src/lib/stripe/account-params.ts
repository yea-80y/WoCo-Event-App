/**
 * The parameters every connected account is created with.
 *
 * This is the Managed Risk configuration (issue #90). The controller block is
 * the load-bearing part: `type: "express"` is INCOMPATIBLE with Managed Risk
 * because it bakes in `controller.losses.payments = "application"` — the
 * platform stays liable for unrecoverable negative balances forever, and an
 * account cannot be converted after creation. Stripe specialist email,
 * 2026-07-29 (docs/PAYOUTS.md §6):
 *
 *   controller[stripe_dashboard][type]  = express   → Stripe-hosted Express Dashboard
 *   controller[fees][payer]             = account   → organiser pays Stripe processing fees
 *   controller[losses][payments]        = stripe    → Stripe absorbs unrecoverable negative balances
 *   controller[requirement_collection]  = stripe    → Stripe-hosted onboarding collects KYC
 *
 * `application_fee_amount` continues to work under this configuration —
 * confirmed in writing by Stripe, twice (PRICING_AND_EMAIL.md §17).
 *
 * The manual payout schedule is set at creation so no account is ever briefly
 * on Stripe's automatic schedule; schedules are unaffected by Managed Risk
 * (Stripe chat, 2026-07-29). On manual, only the platform can move funds —
 * the Express Dashboard cannot self-initiate payouts (PAYOUTS.md §3.2).
 */

import type Stripe from "stripe";

export function buildConnectedAccountParams(organiserAddress: string): Stripe.AccountCreateParams {
  return {
    controller: {
      stripe_dashboard: { type: "express" },
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
