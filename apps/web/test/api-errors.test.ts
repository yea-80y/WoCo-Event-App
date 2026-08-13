/**
 * The typed-error bridge and the #256 discriminator.
 *
 * `isSessionInvalid` is what keeps "the server rejected the session" from
 * rendering as "you have no data" — the properties pinned here are that it
 * fires ONLY on the exact envelope shape (`ok: false` + the SESSION_INVALID
 * code) and never on a success, a codeless failure, or a different code.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { isSessionInvalid, apiError, MarketingSenderUnavailable } from "../src/lib/api/errors.js";

test("a rejected session is recognised by code, not by text", () => {
  assert.ok(isSessionInvalid({ ok: false, code: "SESSION_INVALID" }));
});

test("no other envelope counts as a rejected session", () => {
  assert.ok(!isSessionInvalid({ ok: true }));
  // ok:true with a stray code must never read as a failure.
  assert.ok(!isSessionInvalid({ ok: true, code: "SESSION_INVALID" }));
  assert.ok(!isSessionInvalid({ ok: false }));
  assert.ok(!isSessionInvalid({ ok: false, code: "SESSION_CLOCK_SKEW" }));
  assert.ok(!isSessionInvalid({ ok: false, code: "SESSION_REPLAY" }));
});

test("apiError keeps the marketing-sender code across the throw, and only that one", () => {
  const typed = apiError({ error: "no sender", code: MarketingSenderUnavailable.CODE }, "fallback");
  assert.ok(typed instanceof MarketingSenderUnavailable);
  const plain = apiError({ error: "boom", code: "SESSION_INVALID" }, "fallback");
  assert.ok(!(plain instanceof MarketingSenderUnavailable));
  assert.equal(plain.message, "boom");
  assert.equal(apiError({}, "fallback").message, "fallback");
});
