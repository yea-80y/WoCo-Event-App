/**
 * The Managed Risk account shape (#90) — the launch gate for onboarding real
 * organisers.
 *
 * An account created with the wrong controller block is wrong FOREVER: Stripe
 * cannot convert it, and `type: "express"` silently bakes in platform
 * liability for every negative balance. These tests pin the fully embedded
 * configuration confirmed by Stripe support (2026-07-31, PAYOUTS.md §4.1) so
 * a well-meaning refactor cannot drift it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";
import { buildConnectedAccountParams, isPlatformLiable, isLegacyShape } from "../src/lib/stripe/account-params.js";

const ORG = "0xabcd000000000000000000000000000000000001";

test("creates accounts with the Managed Risk controller block, never type", () => {
  const params = buildConnectedAccountParams(ORG);

  assert.equal("type" in params, false, "`type` is incompatible with Managed Risk");
  assert.deepEqual(params.controller, {
    stripe_dashboard: { type: "full" },
    fees: { payer: "account" },
    losses: { payments: "stripe" },
    requirement_collection: "stripe",
  });
});

test("country is explicit — controller-created accounts reject the block without it", () => {
  assert.equal(buildConnectedAccountParams(ORG).country, "GB");
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

test("isLegacyShape flags every account we would not create today", () => {
  const current = { controller: { losses: { payments: "stripe" }, stripe_dashboard: { type: "full" } } } as Stripe.Account;
  const noDashboard = { controller: { losses: { payments: "stripe" }, stripe_dashboard: { type: "none" } } } as Stripe.Account;
  const liable = { controller: { losses: { payments: "application" }, stripe_dashboard: { type: "full" } } } as Stripe.Account;

  assert.equal(isLegacyShape(current), false);
  assert.equal(isLegacyShape(noDashboard), true, "a none account is retired (#645)");
  assert.equal(isLegacyShape(liable), true);
  assert.equal(isLegacyShape({} as Stripe.Account), true);
});
