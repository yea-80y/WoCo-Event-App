/**
 * Behaviour the routes lean on from the shared limiter (#176, #301).
 *
 * Time is injected everywhere so these are deterministic — a limiter test that
 * sleeps is a flaky test, and a flaky gate is no gate.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { SlidingWindowLimiter } from "../src/lib/http/rate-limit.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

test("allows up to the limit inside the window, then refuses", () => {
  const l = new SlidingWindowLimiter([{ limit: 3, windowMs: MIN }]);
  assert.equal(l.allow("k", 0), true);
  assert.equal(l.allow("k", 1), true);
  assert.equal(l.allow("k", 2), true);
  assert.equal(l.allow("k", 3), false);
});

test("the window slides: hits age out individually, not all at once", () => {
  const l = new SlidingWindowLimiter([{ limit: 2, windowMs: MIN }]);
  assert.equal(l.allow("k", 0), true);
  assert.equal(l.allow("k", 30_000), true);
  assert.equal(l.allow("k", 59_000), false);
  // The hit at 0 is now outside the window; the one at 30_000 is not.
  assert.equal(l.allow("k", MIN + 1), true);
  assert.equal(l.allow("k", MIN + 2), false);
  assert.equal(l.allow("k", MIN + 30_001), true);
});

test("multiple windows: the burst cap and the sustained cap are both enforced", () => {
  const l = new SlidingWindowLimiter([
    { limit: 3, windowMs: MIN },
    { limit: 5, windowMs: HOUR },
  ]);
  // Burst of 3 in the first minute, 4th refused by the minute window.
  for (let i = 0; i < 3; i++) assert.equal(l.allow("k", i), true);
  assert.equal(l.allow("k", 10), false);
  // Next minute: 2 more allowed (5 total in the hour), then the HOUR window refuses
  // even though the minute window would allow.
  assert.equal(l.allow("k", MIN + 1), true);
  assert.equal(l.allow("k", MIN + 2), true);
  assert.equal(l.allow("k", MIN + 3), false);
  assert.equal(l.allow("k", 10 * MIN), false);
  // After the hour the oldest hits age out.
  assert.equal(l.allow("k", HOUR + 1), true);
});

test("keys are independent", () => {
  const l = new SlidingWindowLimiter([{ limit: 1, windowMs: MIN }]);
  assert.equal(l.allow("a", 0), true);
  assert.equal(l.allow("b", 0), true);
  assert.equal(l.allow("a", 1), false);
  assert.equal(l.allow("b", 1), false);
});

test("a refused hit is not recorded — refusals cannot extend the lockout", () => {
  const l = new SlidingWindowLimiter([{ limit: 1, windowMs: MIN }]);
  assert.equal(l.allow("k", 0), true);
  for (let t = 1; t < 1000; t++) assert.equal(l.allow("k", t), false);
  // Had refusals been recorded, the window would have restarted at t=999.
  assert.equal(l.allow("k", MIN + 1), true);
});

test("allowAll: refused on the second key means the first was not charged", () => {
  const l = new SlidingWindowLimiter([{ limit: 1, windowMs: MIN }]);
  l.record("ip", 0); // the IP bucket is already full
  assert.equal(l.allowAll(["p:alice", "ip"], 1), false);
  // alice's own bucket is untouched: she is allowed once the IP bucket clears.
  assert.equal(l.peek("p:alice", 1), true);
  assert.equal(l.allowAll(["p:alice", "ip"], MIN + 1), true);
  assert.equal(l.allowAll(["p:alice", "ip"], MIN + 2), false);
});

test("allowAll records every key when allowed", () => {
  const l = new SlidingWindowLimiter([{ limit: 1, windowMs: MIN }]);
  assert.equal(l.allowAll(["a", "b"], 0), true);
  assert.equal(l.peek("a", 1), false);
  assert.equal(l.peek("b", 1), false);
});

test("key count is bounded: stale keys go first, then the least recently touched", () => {
  // limit 1 so `peek` doubles as "is this key still held with a live hit".
  const l = new SlidingWindowLimiter([{ limit: 1, windowMs: MIN }], 3);
  l.record("stale", 0);
  l.record("a", MIN + 1);
  l.record("b", MIN + 2);
  assert.equal(l.size(), 3);
  // A 4th key: "stale" aged out of the window and is dropped first.
  l.record("c", MIN + 3);
  assert.equal(l.size(), 3);
  assert.equal(l.peek("stale", MIN + 3), true);
  assert.equal(l.peek("a", MIN + 3), false);
  // A 5th key with nothing stale: "a" is the least recently touched → evicted.
  l.record("d", MIN + 4);
  assert.equal(l.size(), 3);
  assert.equal(l.peek("a", MIN + 4), true);
  assert.equal(l.peek("b", MIN + 4), false);
  // Touching "b" moves it to the tail, so the next eviction takes "c".
  l.record("b", MIN + 5);
  l.record("e", MIN + 6);
  assert.equal(l.size(), 3);
  assert.equal(l.peek("c", MIN + 6), true);
  assert.equal(l.peek("d", MIN + 6), false);
  assert.equal(l.peek("b", MIN + 6), false);
  assert.equal(l.peek("e", MIN + 6), false);
});

test("per-key history is trimmed to the largest limit", () => {
  const l = new SlidingWindowLimiter([{ limit: 2, windowMs: HOUR }]);
  for (let i = 0; i < 100; i++) l.record("k", i);
  // Still refuses (2 within the hour) …
  assert.equal(l.peek("k", 200), false);
  // … and after the two most recent age out, allows again — the 98 older hits
  // were not kept to extend the lockout.
  assert.equal(l.peek("k", HOUR + 99), true);
});

test("constructor rejects nonsense", () => {
  assert.throws(() => new SlidingWindowLimiter([]));
  assert.throws(() => new SlidingWindowLimiter([{ limit: 0, windowMs: MIN }]));
  assert.throws(() => new SlidingWindowLimiter([{ limit: 1, windowMs: 0 }]));
});
