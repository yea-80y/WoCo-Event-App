/**
 * The seat-hold rules, pinned (#568). Each test is a way the panel could show
 * the wrong hold, blame the buyer for someone else's hold, or carry a hold
 * into checkout that no longer covers what is being bought.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { secondsUntil, formatCountdown, holdResult, usableHold, type Hold } from "../src/reservation.js";

const NOW = Date.parse("2026-09-13T18:00:00.000Z");
const inSecs = (s: number) => new Date(NOW + s * 1000).toISOString();

// ---------------------------------------------------------------------------
// Countdown
// ---------------------------------------------------------------------------

test("seconds remaining floor to whole seconds", () => {
  assert.equal(secondsUntil(new Date(NOW + 599_900).toISOString(), NOW), 599);
});

test("a past or unparseable expiry counts as expired, never negative", () => {
  assert.equal(secondsUntil(inSecs(-30), NOW), 0);
  assert.equal(secondsUntil("not a date", NOW), 0);
});

test("the countdown reads m:ss with two-digit seconds", () => {
  assert.equal(formatCountdown(600), "10:00");
  assert.equal(formatCountdown(61), "1:01");
  assert.equal(formatCountdown(0), "0:00");
  assert.equal(formatCountdown(-5), "0:00");
});

// ---------------------------------------------------------------------------
// What a /reserve response means
// ---------------------------------------------------------------------------

test("a complete success is a hold", () => {
  const r = holdResult({ ok: true, data: { reservationId: "r1", expiresAt: inSecs(600), quantity: 2 } });
  assert.deepEqual(r, { kind: "held", hold: { reservationId: "r1", expiresAt: inSecs(600), quantity: 2 } });
});

test("a success missing its id or quantity is not a hold", () => {
  assert.equal(holdResult({ ok: true, data: { expiresAt: inSecs(600), quantity: 1 } }).kind, "unavailable");
  assert.equal(holdResult({ ok: true, data: { reservationId: "r1", expiresAt: inSecs(600), quantity: 0 } }).kind, "unavailable");
});

test("no response at all stays quiet rather than reading as a refusal", () => {
  assert.equal(holdResult(null).kind, "unavailable");
  assert.equal(holdResult({ ok: false }).kind, "unavailable");
});

test("seats inside other buyers' holds are not reported as a sell-out", () => {
  const r = holdResult({ ok: false, error: "Insufficient seats", available: 0, physicalAvailable: 3 });
  assert.equal(r.kind, "refused");
  assert.match((r as { message: string }).message, /held by other buyers/);
});

test("no seats at all is a sell-out", () => {
  assert.deepEqual(
    holdResult({ ok: false, error: "Insufficient seats", available: 0, physicalAvailable: 0 }),
    { kind: "refused", message: "Sold out." },
  );
});

test("fewer seats than asked for names the count, singular and plural", () => {
  assert.match((holdResult({ ok: false, error: "Insufficient seats", available: 2, physicalAvailable: 2 }) as { message: string }).message, /^Only 2 tickets available/);
  assert.match((holdResult({ ok: false, error: "Insufficient seats", available: 1, physicalAvailable: 1 }) as { message: string }).message, /^Only 1 ticket available/);
});

test("any other server refusal is shown as the server wrote it", () => {
  const msg = "Too many seats are already being held from your network. Complete a pending purchase, or try again in a few minutes.";
  assert.deepEqual(holdResult({ ok: false, error: msg }), { kind: "refused", message: msg });
});

// ---------------------------------------------------------------------------
// Which hold checkout may carry
// ---------------------------------------------------------------------------

const hold: Hold = { reservationId: "r1", expiresAt: inSecs(120), quantity: 2 };

test("a live hold for the same quantity is carried into checkout", () => {
  assert.equal(usableHold(hold, 2, NOW), hold);
});

test("a hold for a different quantity is not carried", () => {
  assert.equal(usableHold(hold, 3, NOW), null);
});

test("an expired hold is not carried", () => {
  assert.equal(usableHold(hold, 2, NOW + 120_000), null);
});

test("no hold means none is carried", () => {
  assert.equal(usableHold(null, 1, NOW), null);
});
