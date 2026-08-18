/**
 * The honesty rules for the lap-count surfaces, pinned.
 *
 * These are not unit tests of a formatter. Each one corresponds to a way the
 * overlay or the widget could overclaim to an audience that will test it on
 * camera, which is the one unforced error available on this rail. They are
 * cheap to keep and they are the reason the display logic is a DOM-free module
 * rather than string concatenation inside a custom element.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describe as describeCount,
  parseCountData,
  SIGNED_LINE,
  NO_LAPS_LINE,
  STALE_AFTER_FAILURES,
  type CountData,
} from "../src/count/display.js";

const data = (over: Partial<CountData> = {}): CountData => ({
  count: 109,
  participants: 1,
  contributors: 1,
  unreadable: 0,
  ...over,
});

const known = (over: Partial<CountData> = {}, consecutiveFailures = 0) =>
  ({ kind: "known", data: data(over), consecutiveFailures }) as const;

// ---------------------------------------------------------------------------
// Rule 1 — a dead counter is never rendered as zero
// ---------------------------------------------------------------------------

test("before the first successful read there is no figure at all", () => {
  const d = describeCount({ kind: "pending" });
  assert.equal(d.figure, null, "a figure before any successful read would be invented");
  assert.equal(d.line, "");
});

test("zero is a real answer and renders as a number, not as an empty state", () => {
  const d = describeCount(known({ count: 0, participants: 0, contributors: 0 }));
  assert.equal(d.figure, "0");
  assert.equal(d.unit, "laps");
});

// ---------------------------------------------------------------------------
// Rule 2 — an incomplete read is a floor, and says so
// ---------------------------------------------------------------------------

test("unreadable logbooks make the figure a floor, marked with a trailing plus", () => {
  const d = describeCount(known({ unreadable: 2 }));
  assert.equal(d.figure, "109+");
  assert.equal(d.isFloor, true);
});

test("a complete read carries no plus", () => {
  const d = describeCount(known({ unreadable: 0 }));
  assert.equal(d.figure, "109");
  assert.equal(d.isFloor, false);
});

test("a floor of one stays plural — it is not a claim that the total is one", () => {
  assert.equal(describeCount(known({ count: 1, unreadable: 1 })).unit, "laps");
  assert.equal(describeCount(known({ count: 1, unreadable: 0 })).unit, "lap");
});

// ---------------------------------------------------------------------------
// Rule 3 — community scope labels itself before it can mislead
// ---------------------------------------------------------------------------

test("a single rider needs no rider count", () => {
  assert.equal(describeCount(known({ contributors: 1 })).riders, null);
});

test("a second rider makes the count self-label as community-scoped", () => {
  assert.equal(describeCount(known({ contributors: 3 })).riders, "3 riders");
});

// ---------------------------------------------------------------------------
// Rule 4 — a stale number is honest only while it is marked
// ---------------------------------------------------------------------------

test("one failed poll does not yet mark the figure", () => {
  assert.equal(describeCount(known({}, STALE_AFTER_FAILURES - 1)).notUpdating, false);
});

test("sustained failure marks the figure without removing it", () => {
  const d = describeCount(known({}, STALE_AFTER_FAILURES));
  assert.equal(d.notUpdating, true);
  assert.equal(d.figure, "109", "the last honest number stays on screen");
});

// ---------------------------------------------------------------------------
// Vocabulary — a wrong word here loses the audience on day one
// ---------------------------------------------------------------------------

test("the supporting line is the agreed line, verbatim", () => {
  assert.equal(describeCount(known()).line, SIGNED_LINE);
});

test("with no laps the line does not assert that anything was signed", () => {
  assert.equal(describeCount(known({ count: 0 })).line, NO_LAPS_LINE);
});

test("no surface calls a lap a credit, and no crypto word reaches a fan", () => {
  const states = [
    describeCount({ kind: "pending" }),
    describeCount(known()),
    describeCount(known({ count: 0 })),
    describeCount(known({ unreadable: 4, contributors: 6 }, STALE_AFTER_FAILURES)),
  ];
  const banned = [
    "credit", "wallet", "mint", "decentralised", "decentralized",
    "tamper-proof", "tamperproof", "immutable", "blockchain", "token",
  ];
  for (const s of states) {
    const words = [s.line, s.unit, s.riders ?? "", s.figure ?? ""].join(" ").toLowerCase();
    for (const b of banned) {
      assert.ok(!words.includes(b), `"${b}" must never appear on a fan-facing count surface`);
    }
  }
});

// ---------------------------------------------------------------------------
// A malformed response is a failed read, never a rendered one
// ---------------------------------------------------------------------------

test("a well-formed payload parses", () => {
  assert.deepEqual(parseCountData(data()), data());
});

test("payloads that could paint a wrong or nonsense figure are rejected", () => {
  const bad: unknown[] = [
    null,
    undefined,
    "109",
    {},
    { count: 109 },
    { count: "109", participants: 1, contributors: 1, unreadable: 0 },
    { count: 1.5, participants: 1, contributors: 1, unreadable: 0 },
    { count: -1, participants: 1, contributors: 1, unreadable: 0 },
    { count: NaN, participants: 1, contributors: 1, unreadable: 0 },
    { count: Infinity, participants: 1, contributors: 1, unreadable: 0 },
  ];
  for (const b of bad) {
    assert.equal(parseCountData(b), null, `rejected: ${JSON.stringify(b)}`);
  }
});
