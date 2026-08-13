/**
 * Past-event gate (#241) — fail-closed tests in the #207 style.
 *
 * The invariant: the server must refuse to CHARGE no later than the contract
 * refuses to MINT (WoCoEventV2 reverts `SalesClosed` at
 * `block.timestamp >= eventEndTs`). Anything this gate lets through for an
 * ended event becomes charge → revert → auto-refund, so every boundary here
 * is asserted from the refusing side.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkSalesWindow,
  salesClosedMessage,
  SALES_END_GRACE_MS,
} from "../src/lib/event/sales-window.js";

const NOW = Date.parse("2026-08-09T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const DAY = 24 * 60 * 60 * 1000;

test("refuses an event whose endDate is in the past (the #241 repro shape)", () => {
  // Production repro: endDate five days before the probe still sold a ticket.
  const v = checkSalesWindow({ startDate: iso(-6 * DAY), endDate: iso(-5 * DAY) }, NOW);
  assert.deepEqual(v, { open: false, reason: "ended" });
});

test("allows an event whose endDate is in the future", () => {
  const v = checkSalesWindow({ startDate: iso(-1 * DAY), endDate: iso(2 * DAY) }, NOW);
  assert.deepEqual(v, { open: true });
});

test("allows a live multi-day event (started, not yet ended) — door sales", () => {
  const v = checkSalesWindow({ startDate: iso(-2 * DAY), endDate: iso(1 * DAY) }, NOW);
  assert.deepEqual(v, { open: true });
});

test("closes exactly AT endDate — contract parity with `block.timestamp >= eventEndTs`", () => {
  const v = checkSalesWindow({ startDate: iso(-1 * DAY), endDate: iso(0) }, NOW);
  assert.deepEqual(v, { open: false, reason: "ended" });
});

test("still open one millisecond before endDate", () => {
  const v = checkSalesWindow({ startDate: iso(-1 * DAY), endDate: iso(1) }, NOW);
  assert.deepEqual(v, { open: true });
});

test("empty endDate falls back to startDate — past start refuses", () => {
  // Mirrors the client's isPastEvent: such an event shows "This event has
  // ended" in the UI, so the server must refuse the charge too.
  const v = checkSalesWindow({ startDate: iso(-1 * DAY), endDate: "" }, NOW);
  assert.deepEqual(v, { open: false, reason: "ended" });
});

test("empty endDate falls back to startDate — future start allows", () => {
  const v = checkSalesWindow({ startDate: iso(3 * DAY), endDate: "" }, NOW);
  assert.deepEqual(v, { open: true });
});

test("fails CLOSED when no date parses — never defaults to allow", () => {
  assert.deepEqual(checkSalesWindow({}, NOW), { open: false, reason: "undated" });
  assert.deepEqual(
    checkSalesWindow({ startDate: "not a date", endDate: "" }, NOW),
    { open: false, reason: "undated" },
  );
});

test("a garbage endDate does not fall through to startDate", () => {
  // A non-empty endDate is THE end claim; if it doesn't parse we refuse
  // rather than guess from startDate (a live-looking startDate would open
  // sales the contract may already refuse).
  const v = checkSalesWindow({ startDate: iso(3 * DAY), endDate: "garbage" }, NOW);
  assert.deepEqual(v, { open: false, reason: "undated" });
});

test("grace period is pinned to zero while the contract closes sharp", () => {
  // Raising this without first adding the same grace to the on-chain
  // eventEndTs (routes/events.ts registration) re-opens the
  // charge-then-auto-refund window this gate exists to close.
  assert.equal(SALES_END_GRACE_MS, 0);
});

test("refusal copy exists for both reasons and never claims an undated event ended", () => {
  assert.match(salesClosedMessage("ended"), /ended/i);
  assert.doesNotMatch(salesClosedMessage("undated"), /ended/i);
});
