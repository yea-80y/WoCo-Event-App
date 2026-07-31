/**
 * Account Sessions — what an organiser can reach, and how we fail.
 *
 * Two things are worth pinning. The components block decides which parts of
 * their Stripe account an organiser can see and edit; widening it is a
 * permissions change that should have to be deliberate. And the error mapping
 * is the whole reason this endpoint is safe to put behind a money screen — a
 * Stripe 4xx must read as "finish setup", never as our outage, and a deleted
 * account must self-heal rather than loop.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACCOUNT_SESSION_COMPONENTS,
  buildAccountSessionParams,
  classifyAccountSessionError,
  resolvePublishableKey,
} from "../src/lib/stripe/account-session.js";

const ACCT = "acct_1Tz5bcDU6bf5ODe9";

test("enables exactly the two components the payouts screen mounts", () => {
  assert.deepEqual(Object.keys(ACCOUNT_SESSION_COMPONENTS).sort(), [
    "account_management",
    "notification_banner",
  ]);
  assert.equal(ACCOUNT_SESSION_COMPONENTS.account_management.enabled, true);
  assert.equal(ACCOUNT_SESSION_COMPONENTS.notification_banner.enabled, true);
});

test("external account collection stays on — it is how organisers set their bank details", () => {
  // The button this component replaced ("Manage bank details") did exactly this
  // job. If the feature is ever defaulted off, organisers silently lose the
  // ability to get paid into a different account.
  assert.equal(ACCOUNT_SESSION_COMPONENTS.account_management.features.external_account_collection, true);
  assert.equal(ACCOUNT_SESSION_COMPONENTS.notification_banner.features.external_account_collection, true);
});

test("never claims to disable Stripe user authentication", () => {
  // Stripe rejects `true` unless controller.requirement_collection is
  // "application"; ours is "stripe". Sending it would be a silent no-op that
  // reads in code like a guarantee we do not have.
  for (const component of Object.values(ACCOUNT_SESSION_COMPONENTS)) {
    assert.equal(
      "disable_stripe_user_authentication" in component.features,
      false,
      "we cannot disable Stripe user auth under requirement_collection: stripe",
    );
  }
});

test("session is scoped to the one account it was built for", () => {
  const params = buildAccountSessionParams(ACCT);
  assert.equal(params.account, ACCT);
  assert.deepEqual(params.components, ACCOUNT_SESSION_COMPONENTS);
});

test("a deleted Stripe account self-heals instead of looping", () => {
  const byStatus = classifyAccountSessionError({ statusCode: 404 });
  const byCode = classifyAccountSessionError({ code: "resource_missing" });

  for (const failure of [byStatus, byCode]) {
    assert.equal(failure.dropRecord, true, "the stale local record must be dropped");
    assert.equal(failure.status, 400);
    assert.match(failure.message, /Connect Stripe again/);
  }
});

test("an unverified account reads as finish-setup, not as our outage", () => {
  const failure = classifyAccountSessionError({ statusCode: 400 });
  assert.equal(failure.status, 400);
  assert.equal(failure.dropRecord, false);
  assert.match(failure.message, /finish verification/);
});

test("Stripe throttling US is not the organiser's fault", () => {
  // 429 means slow down, not "your account is wrong" — telling an organiser to
  // finish verification here sends them to a form with nothing left to fill in.
  const failure = classifyAccountSessionError({ statusCode: 429 });
  assert.equal(failure.status, 502);
  assert.equal(failure.dropRecord, false);
  assert.match(failure.message, /try again shortly/i);
});

test("a live secret key with a test publishable key is refused", () => {
  // The frontend and server deploy separately, so this mismatch is a realistic
  // deploy mistake rather than a typo — and it would otherwise only show up as
  // a broken widget in an organiser's browser.
  const live = resolvePublishableKey("sk_live_abc", "pk_test_abc");
  assert.equal(live.ok, false);
  assert.match((live as { reason: string }).reason, /mismatch/);

  const test_ = resolvePublishableKey("sk_test_abc", "pk_live_abc");
  assert.equal(test_.ok, false);
});

test("matching key modes resolve, including restricted keys", () => {
  assert.deepEqual(resolvePublishableKey("sk_test_abc", "pk_test_xyz"), {
    ok: true,
    publishableKey: "pk_test_xyz",
  });
  assert.deepEqual(resolvePublishableKey("sk_live_abc", "pk_live_xyz"), {
    ok: true,
    publishableKey: "pk_live_xyz",
  });
  // Restricted keys carry the same mode marker and must not read as a mismatch.
  assert.equal(resolvePublishableKey("rk_live_abc", "pk_live_xyz").ok, true);
});

test("a missing or malformed publishable key never reaches the browser", () => {
  assert.equal(resolvePublishableKey("sk_test_abc", undefined).ok, false);
  assert.equal(resolvePublishableKey("sk_test_abc", "").ok, false);
  // A secret key pasted into the publishable slot must not be served to clients.
  assert.equal(resolvePublishableKey("sk_test_abc", "sk_test_abc").ok, false);
});

test("an unrecognised secret key shape does not block a valid publishable key", () => {
  // Stripe has changed key prefixes before. Refusing to serve on an unknown
  // secret prefix would take payouts down for a cosmetic reason.
  assert.equal(resolvePublishableKey("unknown_prefix", "pk_live_xyz").ok, true);
  assert.equal(resolvePublishableKey(undefined, "pk_test_xyz").ok, true);
});

test("Stripe 5xx and unrecognised failures surface as a retryable outage", () => {
  for (const err of [{ statusCode: 500 }, { statusCode: 503 }, new Error("socket hang up"), null, undefined]) {
    const failure = classifyAccountSessionError(err);
    assert.equal(failure.status, 502, `expected 502 for ${JSON.stringify(err)}`);
    assert.equal(failure.dropRecord, false, "never drop an account record on a transient failure");
  }
});
