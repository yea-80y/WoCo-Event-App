/**
 * #1000 — the Stripe key's mode, read from its prefix, and which webhook
 * secrets a server holding it must have before it boots.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { missingWebhookSecrets, stripeKeyMode } from "../src/lib/stripe/key-mode.js";

test("secret AND restricted keys read as their mode; anything else is unknown", () => {
  assert.equal(stripeKeyMode("sk_live_abc"), "live");
  assert.equal(stripeKeyMode("rk_live_abc"), "live", "a restricted live key is live - refusing it would stop all fulfilment");
  assert.equal(stripeKeyMode("sk_test_abc"), "test");
  assert.equal(stripeKeyMode("rk_test_abc"), "test");
  for (const key of ["pk_live_abc", "pk_test_abc", "whsec_abc", "sk_live", "SK_LIVE_abc", " sk_live_abc", "", undefined]) {
    assert.equal(stripeKeyMode(key), "unknown", String(key));
  }
});

const BOTH = { STRIPE_WEBHOOK_SECRET: "whsec_a", STRIPE_WEBHOOK_SECRET_PLATFORM: "whsec_b" };

test("a live key owes both webhook secrets even with NODE_ENV lost", () => {
  assert.deepEqual(missingWebhookSecrets({ STRIPE_SECRET_KEY: "sk_live_x" }), ["STRIPE_WEBHOOK_SECRET", "STRIPE_WEBHOOK_SECRET_PLATFORM"]);
  assert.deepEqual(missingWebhookSecrets({ STRIPE_SECRET_KEY: "rk_live_x", STRIPE_WEBHOOK_SECRET: "whsec_a" }), ["STRIPE_WEBHOOK_SECRET_PLATFORM"]);
  assert.deepEqual(missingWebhookSecrets({ STRIPE_SECRET_KEY: "sk_live_x", ...BOTH }), []);
});

test("production owes them whatever the key; a test-mode dev server and a Stripe-less one do not", () => {
  assert.deepEqual(missingWebhookSecrets({ NODE_ENV: "production", STRIPE_SECRET_KEY: "sk_test_x" }), ["STRIPE_WEBHOOK_SECRET", "STRIPE_WEBHOOK_SECRET_PLATFORM"]);
  assert.deepEqual(missingWebhookSecrets({ STRIPE_SECRET_KEY: "sk_test_x" }), []);
  assert.deepEqual(missingWebhookSecrets({ NODE_ENV: "production" }), [], "no Stripe configured: nothing owed");
});
