/**
 * The Managed Risk account shape (#90) — the launch gate for onboarding real
 * organisers.
 *
 * An account created with the wrong controller block is wrong FOREVER: Stripe
 * cannot convert it, and `type: "express"` silently bakes in platform
 * liability for every negative balance. These tests pin the exact
 * configuration from Stripe's specialist email (2026-07-29, PAYOUTS.md §6) so
 * a well-meaning refactor cannot drift it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";
import { buildConnectedAccountParams, isPlatformLiable } from "../src/lib/stripe/account-params.js";

const ORG = "0xabcd000000000000000000000000000000000001";

test("creates accounts with the Managed Risk controller block, never type", () => {
  const params = buildConnectedAccountParams(ORG);

  assert.equal("type" in params, false, "`type` is incompatible with Managed Risk");
  assert.deepEqual(params.controller, {
    stripe_dashboard: { type: "express" },
    fees: { payer: "account" },
    losses: { payments: "stripe" },
    requirement_collection: "stripe",
  });
});

test("manual payout schedule is set at creation", () => {
  const params = buildConnectedAccountParams(ORG);
  assert.equal(params.settings?.payouts?.schedule?.interval, "manual");
});

test("card_payments capability requested (Managed Risk requirement)", () => {
  const params = buildConnectedAccountParams(ORG);
  assert.equal(params.capabilities?.card_payments?.requested, true);
});

test("organiser address travels in metadata", () => {
  assert.equal(buildConnectedAccountParams(ORG).metadata?.organiserAddress, ORG);
});

test("isPlatformLiable flags legacy and absent controller shapes, not Managed Risk", () => {
  const managedRisk = { controller: { losses: { payments: "stripe" } } } as Stripe.Account;
  const legacy = { controller: { losses: { payments: "application" } } } as Stripe.Account;
  const noController = {} as Stripe.Account;

  assert.equal(isPlatformLiable(managedRisk), false);
  assert.equal(isPlatformLiable(legacy), true);
  // Fail toward "liable": an unreadable controller must never pass as safe.
  assert.equal(isPlatformLiable(noController), true);
});
