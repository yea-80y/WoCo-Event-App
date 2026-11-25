/**
 * The launch rate's clock (Organiser Terms §6, the organiser flyer): 0.9% for
 * three months from the account's first paid sale, then 1.5%. Every boundary
 * here errs towards the organiser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { LAUNCH_RATE_FEE_BP, PLATFORM_FEE_BP } from "@woco/shared";
import { launchRateEnd, platformFeeBpAt } from "../src/lib/stripe/launch-rate.js";

const ms = (iso: string) => Date.parse(iso);

test("the last day is the corresponding date three months on, clamped to a shorter month", () => {
  // Times before 10:00 UTC, where the latest date on earth (UTC+14) is still the UTC date.
  const cases: Array<[string, string]> = [
    ["2026-12-05T08:00:00.000Z", "2027-03-05"],
    ["2026-10-15T09:00:00.000Z", "2027-01-15"], // across a year end
    ["2026-11-30T05:00:00.000Z", "2027-02-28"], // no 30 Feb
    ["2027-01-31T08:00:00.000Z", "2027-04-30"], // no 31 Apr
    ["2027-11-30T00:00:00.000Z", "2028-02-29"], // leap year
    ["2026-11-25T00:00:00.000Z", "2027-02-25"],
  ];
  for (const [first, last] of cases) assert.equal(launchRateEnd(ms(first)).lastDay, last, first);
});

test("the first sale's date is the latest date anywhere on earth: no organiser's own date is later", () => {
  // 00:30 BST on 1 June is 23:30 UTC on 31 May: a UK organiser reads 1 June, and so do we.
  const ukJustAfterMidnight = ms("2027-05-31T23:30:00.000Z");
  assert.equal(launchRateEnd(ukJustAfterMidnight).lastDay, "2027-09-01");
  // ...so they keep 0.9% through the end of their own 1 September (23:00 UTC).
  assert.equal(platformFeeBpAt(ukJustAfterMidnight, ms("2027-09-01T22:59:59.000Z")), LAUNCH_RATE_FEE_BP);
  // UTC+14 turns the date at 10:00 UTC.
  assert.equal(launchRateEnd(ms("2027-06-01T09:59:59.000Z")).lastDay, "2027-09-01");
  assert.equal(launchRateEnd(ms("2027-06-01T10:00:00.000Z")).lastDay, "2027-09-02");
});

test("the rate runs through the whole last day in every time zone: until 12:00 UTC the day after", () => {
  const first = ms("2026-12-05T08:00:00.000Z");
  assert.equal(launchRateEnd(first).endMs, ms("2027-03-06T12:00:00.000Z"));
  assert.equal(platformFeeBpAt(first, ms("2027-03-06T11:59:59.999Z")), LAUNCH_RATE_FEE_BP);
  assert.equal(platformFeeBpAt(first, ms("2027-03-06T12:00:00.000Z")), PLATFORM_FEE_BP);
});

test("no first sale on record is the launch rate; the first sale itself is at the launch rate", () => {
  assert.equal(platformFeeBpAt(null, ms("2030-01-01T00:00:00.000Z")), LAUNCH_RATE_FEE_BP);
  const first = ms("2026-12-05T14:00:00.000Z");
  assert.equal(platformFeeBpAt(first, first), LAUNCH_RATE_FEE_BP);
  assert.equal(platformFeeBpAt(first, ms("2027-02-01T00:00:00.000Z")), LAUNCH_RATE_FEE_BP);
  assert.equal(platformFeeBpAt(first, ms("2027-06-01T00:00:00.000Z")), PLATFORM_FEE_BP);
});

test("never more than the standard rate, never less than the launch rate", () => {
  const first = ms("2026-11-30T10:00:00.000Z");
  for (let day = -10; day < 200; day++) {
    const bp = platformFeeBpAt(first, first + day * 86_400_000);
    assert.ok(bp === LAUNCH_RATE_FEE_BP || bp === PLATFORM_FEE_BP);
    if (day < 89) assert.equal(bp, LAUNCH_RATE_FEE_BP, `day ${day}`);
  }
});
