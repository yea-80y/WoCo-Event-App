/**
 * The pacing numbers (#619). The ladder is a published table, so the test pins
 * it cell by cell: a typo here would pace every organiser at the wrong speed
 * and nothing downstream would notice.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  PACING_CHUNK,
  PACING_LADDER,
  PACING_THRESHOLDS,
  batchAllowance,
  crosses,
  pacingRung,
  planSchedule,
  rungLimits,
} from "../../src/marketing/pacing.js";

const HOUR = 60 * 60_000;
const at = (iso: string) => Date.parse(iso);

test("the ladder is Resend's existing-domain table, both columns", () => {
  // https://resend.com/docs/knowledge-base/warming-up, "Existing domain", read 2026-09-22.
  assert.deepEqual(
    PACING_LADDER.map((r) => [r.batchMax, r.dayMax]),
    [
      [100, 1_000],
      [300, 2_500],
      [600, 5_000],
      [800, 5_000],
      [1_000, 7_500],
      [1_500, 7_500],
      [2_000, 10_000],
    ],
  );
});

test("every batch and day figure is whole chunks", () => {
  for (const r of PACING_LADDER) {
    assert.equal(r.batchMax % PACING_CHUNK, 0);
    assert.equal(r.dayMax % PACING_CHUNK, 0);
  }
});

test("the rung is one plus the earlier sending days, and the last rung never ends", () => {
  assert.equal(pacingRung(0), 1);
  assert.equal(pacingRung(1), 2);
  assert.equal(pacingRung(6), 7);
  assert.equal(pacingRung(400), 7, "pacing does not switch off after the table's last day");
  assert.equal(rungLimits(7).batchMax, 2_000);
});

test("thresholds are the published lines", () => {
  assert.deepEqual(PACING_THRESHOLDS, {
    holdBounce: { rate: 0.04, floor: 4 },
    stopBounce: { rate: 0.1, floor: 10 },
    holdComplaint: { rate: 0.0008, floor: 2 },
    stopComplaint: { rate: 0.005, floor: 5 },
  });
});

test("a rate needs its floor, and the floor needs its rate", () => {
  const t = PACING_THRESHOLDS.holdBounce;
  assert.equal(crosses(t, 4, 100), true, "4 of 100 is 4%");
  assert.equal(crosses(t, 3, 100), false, "below the floor");
  assert.equal(crosses(t, 1, 1), false, "one bounce of one send is 100% and still noise");
  assert.equal(crosses(t, 4, 101), false, "just under the rate");
  assert.equal(crosses(t, 4, 0), true, "a bounce counted before its send is not a division by zero");
});

test("the batch allowance is the rung's batch, capped by what is left of the day", () => {
  const pos = { earlierSendingDays: 0, admittedToday: 0, nextAllowedAt: null, at: at("2026-09-22T09:00:00Z") };
  assert.deepEqual(batchAllowance(pos), { rung: 1, size: 100, dayRemaining: 1_000 });
  assert.equal(batchAllowance({ ...pos, admittedToday: 1_000 }).size, 0);
  assert.equal(batchAllowance({ ...pos, earlierSendingDays: 1, admittedToday: 2_400 }).size, 100);
  assert.equal(batchAllowance({ ...pos, admittedToday: 950 }).size, 0, "never a partial chunk");
});

test("1,000 new contacts on a first send is ten hourly batches the same day", () => {
  const from = at("2026-09-22T09:00:00Z");
  const plan = planSchedule({ earlierSendingDays: 0, admittedToday: 0, nextAllowedAt: null, at: from }, 1_000);
  assert.equal(plan.batches, 10);
  assert.equal(plan.endsAt, from + 9 * HOUR);
});

test("the day ceiling carries the rest to the next UTC day, one rung up", () => {
  const from = at("2026-09-22T09:00:00Z");
  const plan = planSchedule({ earlierSendingDays: 0, admittedToday: 0, nextAllowedAt: null, at: from }, 1_300);
  // Ten batches of 100 today (09:00-18:00), then one of 300 at midnight.
  assert.equal(plan.batches, 11);
  assert.equal(plan.endsAt, at("2026-09-23T00:00:00Z"));
});

test("a late start still honours the hour gap across midnight", () => {
  const from = at("2026-09-22T23:30:00Z");
  const plan = planSchedule({ earlierSendingDays: 0, admittedToday: 0, nextAllowedAt: null, at: from }, 400);
  // 100 at 23:30 (day 1), then 300 at 00:30 on day 2 at rung 2.
  assert.equal(plan.batches, 2);
  assert.equal(plan.endsAt, at("2026-09-23T00:30:00Z"));
});

test("a sender who already used part of today starts from where they are", () => {
  const from = at("2026-09-22T12:00:00Z");
  const plan = planSchedule(
    { earlierSendingDays: 0, admittedToday: 900, nextAllowedAt: from + 30 * 60_000, at: from },
    200,
  );
  // 100 at 12:30 finishes today's 1,000; the other 100 go at midnight.
  assert.equal(plan.batches, 2);
  assert.equal(plan.endsAt, at("2026-09-23T00:00:00Z"));
});

test("a full 20,000-contact list from a first-time sender plans inside the hold ceiling", () => {
  const from = at("2026-09-22T20:00:00Z");
  const plan = planSchedule({ earlierSendingDays: 0, admittedToday: 0, nextAllowedAt: null, at: from }, 20_000);
  const days = (plan.endsAt - from) / (24 * HOUR);
  assert.ok(days > 3 && days < 6, `planned ${days.toFixed(1)} days`);
});

test("nothing to send plans nothing", () => {
  const from = at("2026-09-22T09:00:00Z");
  assert.deepEqual(
    planSchedule({ earlierSendingDays: 3, admittedToday: 0, nextAllowedAt: null, at: from }, 0),
    { batches: 0, endsAt: from },
  );
});
