/**
 * Checkout-Session expiry clamp (#300).
 *
 * The properties pinned: a session never outlives the event it sells for
 * (beyond Stripe's structural 30-minute floor), the value is epoch SECONDS
 * inside Stripe's documented 30min–24h window, and the two "leave the default
 * alone" cases (end 24h+ away, unparseable dates) return undefined — the
 * clamp must never be the reason a checkout fails.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkoutExpiresAt,
  CHECKOUT_EXPIRES_MIN_S,
  CHECKOUT_EXPIRES_MAX_S,
  CHECKOUT_EXPIRES_SKEW_S,
} from "../src/lib/event/checkout-expiry.js";

const NOW_MS = new Date("2026-08-17T12:00:00Z").getTime();
const NOW_S = Math.floor(NOW_MS / 1000);
const HOUR_S = 3600;
const iso = (sFromNow: number) => new Date(NOW_MS + sFromNow * 1000).toISOString();

test("event ending within 24h — session expires exactly at the event's end", () => {
  const got = checkoutExpiresAt({ startDate: iso(-HOUR_S), endDate: iso(2 * HOUR_S) }, NOW_MS);
  assert.equal(got, NOW_S + 2 * HOUR_S);
});

test("no endDate — startDate is the end, same rule as the sales gate", () => {
  const got = checkoutExpiresAt({ startDate: iso(3 * HOUR_S) }, NOW_MS);
  assert.equal(got, NOW_S + 3 * HOUR_S);
});

test("event ending inside Stripe's floor — clamped up to floor + skew, never refused", () => {
  const got = checkoutExpiresAt({ startDate: iso(-HOUR_S), endDate: iso(10 * 60) }, NOW_MS);
  assert.equal(got, NOW_S + CHECKOUT_EXPIRES_MIN_S + CHECKOUT_EXPIRES_SKEW_S);
});

test("event ending 24h+ away — undefined, Stripe's default is already tighter", () => {
  assert.equal(
    checkoutExpiresAt({ startDate: iso(-HOUR_S), endDate: iso(48 * HOUR_S) }, NOW_MS),
    undefined,
  );
  // Boundary: exactly 24h out is the default itself — nothing to clamp.
  assert.equal(
    checkoutExpiresAt({ startDate: iso(-HOUR_S), endDate: iso(CHECKOUT_EXPIRES_MAX_S) }, NOW_MS),
    undefined,
  );
});

test("unparseable/absent dates — undefined; the clamp never fails a checkout the gates passed", () => {
  assert.equal(checkoutExpiresAt({ startDate: "garbage" }, NOW_MS), undefined);
  assert.equal(checkoutExpiresAt({}, NOW_MS), undefined);
});

test("result always lands inside Stripe's documented window when defined", () => {
  for (const endIn of [60, 45 * 60, 5 * HOUR_S, 23 * HOUR_S]) {
    const got = checkoutExpiresAt({ startDate: iso(-HOUR_S), endDate: iso(endIn) }, NOW_MS);
    assert.ok(got !== undefined);
    assert.ok(got >= NOW_S + CHECKOUT_EXPIRES_MIN_S, `end+${endIn}s below Stripe floor`);
    assert.ok(got <= NOW_S + CHECKOUT_EXPIRES_MAX_S, `end+${endIn}s above Stripe ceiling`);
  }
});
