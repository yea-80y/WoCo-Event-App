/**
 * When order answers fall due (`legal/order-retention.ts`, #547).
 *
 * MUTATION: drop the end-of-month clamp and "Aug 31 + 6" goes red; carry the
 * year by plain division and "across a year" goes red; let the membership check
 * accept any number and "only a period an organiser can pick" goes red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { addCalendarMonthsUtc, isNoticeRetentionMonths } from "../src/legal/order-retention.js";

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();

test("Aug 31 + 6 months clamps to the end of February, leap years included", () => {
  assert.equal(iso(addCalendarMonthsUtc(at("2026-08-31T21:30:00.000Z"), 6)), "2027-02-28T21:30:00.000Z");
  assert.equal(iso(addCalendarMonthsUtc(at("2027-08-31T21:30:00.000Z"), 6)), "2028-02-29T21:30:00.000Z");
  assert.equal(iso(addCalendarMonthsUtc(at("2026-03-31T00:00:00.000Z"), 6)), "2026-09-30T00:00:00.000Z");
});

test("the day and time of day are kept when the target month has them", () => {
  assert.equal(iso(addCalendarMonthsUtc(at("2026-10-14T23:59:59.999Z"), 6)), "2027-04-14T23:59:59.999Z");
  assert.equal(iso(addCalendarMonthsUtc(at("2026-01-31T12:00:00.000Z"), 12)), "2027-01-31T12:00:00.000Z");
});

test("across a year, in UTC whatever the server's zone", () => {
  assert.equal(iso(addCalendarMonthsUtc(at("2026-12-01T00:30:00.000Z"), 12)), "2027-12-01T00:30:00.000Z");
  assert.equal(iso(addCalendarMonthsUtc(at("2026-07-15T00:00:00.000Z"), 6)), "2027-01-15T00:00:00.000Z");
  assert.equal(iso(addCalendarMonthsUtc(at("2026-12-31T23:00:00.000Z"), 2)), "2027-02-28T23:00:00.000Z");
});

test("bad input throws rather than producing a date", () => {
  assert.throws(() => addCalendarMonthsUtc(Number.NaN, 6), RangeError);
  assert.throws(() => addCalendarMonthsUtc(0, 1.5), RangeError);
});

test("only the period a notice can carry is an instruction to erase", () => {
  assert.equal(isNoticeRetentionMonths(6), true);
  // 12 was offered until 2026-10-22 (owner: one period, never asked).
  for (const v of [0, 1, 3, 7, 12, 24, "6", undefined, null, Number.NaN]) assert.equal(isNoticeRetentionMonths(v), false, String(v));
});
