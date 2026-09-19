/**
 * The lap journal's rules (apps/web/src/lib/credits/lap-journal.ts).
 *
 * These decide two things a phone in a park cannot be asked to demonstrate on
 * demand: that a lap's recorded time is the time of its TAP, and that laps made
 * without signal are neither lost nor shown as counted before they are.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addTap,
  beginPrepared,
  cardNumbers,
  emptyJournal,
  holdBefore,
  journalCounts,
  lapRows,
  lastTapAt,
  markAccepted,
  markSealed,
  nextGroup,
  nextUnsealed,
  parseJournal,
  preparedLanded,
  preparedLost,
  pruneJournal,
  rideDate,
  utcDateOf,
  type LapJournal,
  type PreparedRide,
} from "../src/lib/credits/lap-journal.js";
import { CREDIT_STATEMENT_FORMAT, type CreditStatementV1, type Hex0x } from "@woco/shared";

const SUBJECT = `0x${"11".repeat(32)}` as Hex0x;

/** 21 Sep 2026, 10:00:00 UTC — the ride day, mid-morning. */
const T0 = Date.UTC(2026, 8, 21, 10, 0, 0);
const MIN = 60_000;

function statement(over: Partial<CreditStatementV1> = {}): CreditStatementV1 {
  return {
    format: CREDIT_STATEMENT_FORMAT,
    subject: SUBJECT,
    holder: "aa".repeat(32),
    seq: 7,
    total: 40,
    session: { date: "2026-09-21", count: 3 },
    holderSig: "bb".repeat(64),
    ...over,
  };
}

function prepared(times: number[], over: Partial<PreparedRide> = {}): PreparedRide {
  return {
    times,
    statement: statement(),
    visibility: "private",
    band: 0,
    version: 12,
    body: { ciphertext: "cc" },
    indexed: true,
    rollover: false,
    attempted: false,
    accepted: false,
    ...over,
  };
}

function taps(...ats: number[]): LapJournal {
  return ats.reduce((j, at) => addTap(j, at), emptyJournal());
}

// ---------------------------------------------------------------------------
// The time is the tap's
// ---------------------------------------------------------------------------

test("a tap is kept exactly as read, in tap order", () => {
  const j = taps(T0, T0 + 3 * MIN, T0 + 5 * MIN);
  assert.deepEqual(j.waiting, [T0, T0 + 3 * MIN, T0 + 5 * MIN]);
});

test("a tap time must be a whole positive number", () => {
  assert.throws(() => addTap(emptyJournal(), 0));
  assert.throws(() => addTap(emptyJournal(), T0 + 0.5));
  assert.throws(() => addTap(emptyJournal(), Number.NaN));
});

test("the statement's date comes from the taps, not from when they are sent", () => {
  // Tapped late on the 21st (UTC). Whenever this group is sent — that night,
  // the next morning, a week later — the date it signs is the 21st.
  const late = Date.UTC(2026, 8, 21, 23, 59, 50);
  assert.equal(rideDate([late, late + 5_000]), "2026-09-21");
  assert.equal(utcDateOf(Date.UTC(2026, 8, 22, 0, 0, 0)), "2026-09-22");
});

test("laps from two days can never share a statement", () => {
  assert.throws(() => rideDate([Date.UTC(2026, 8, 21, 23, 59, 59), Date.UTC(2026, 8, 22, 0, 0, 1)]));
  assert.throws(() => rideDate([]));
});

test("half past midnight in Britain is still the previous UTC day", () => {
  // BST is UTC+1, so 00:30 on the 22nd at Alton Towers is 23:30 UTC on the 21st.
  assert.equal(utcDateOf(Date.UTC(2026, 8, 21, 23, 30, 0)), "2026-09-21");
});

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

test("a whole offline day is ONE group carrying every tap's own time", () => {
  const day = Array.from({ length: 130 }, (_, i) => T0 + i * 3 * MIN);
  const group = nextGroup(taps(...day));
  assert.equal(group?.date, "2026-09-21");
  assert.deepEqual(group?.times, day, "130 laps, 130 distinct times — never one time for the group");
  assert.equal(new Set(group?.times).size, 130);
});

test("the OLDEST date goes first, even when the queue order says otherwise", () => {
  const monday = Date.UTC(2026, 8, 21, 16, 0, 0);
  const tuesday = Date.UTC(2026, 8, 22, 9, 0, 0);
  // A clock correction can put a later tap earlier in the queue.
  const group = nextGroup(taps(tuesday, monday, tuesday + MIN));
  assert.deepEqual(group, { date: "2026-09-21", times: [monday] });
});

test("a group is capped, and the rest waits for the next statement", () => {
  const j = taps(T0, T0 + MIN, T0 + 2 * MIN);
  assert.deepEqual(nextGroup(j, 2)?.times, [T0, T0 + MIN]);
});

test("nothing waiting means no group", () => {
  assert.equal(nextGroup(emptyJournal()), null);
});

// ---------------------------------------------------------------------------
// One exact write, bound to its taps
// ---------------------------------------------------------------------------

test("binding taps to a write removes exactly those taps", () => {
  const j = beginPrepared(taps(T0, T0 + MIN, T0 + 2 * MIN), prepared([T0, T0 + MIN]));
  assert.deepEqual(j.waiting, [T0 + 2 * MIN]);
  assert.deepEqual(j.prepared?.times, [T0, T0 + MIN]);
});

test("two taps in the same millisecond are two laps", () => {
  const j = beginPrepared(taps(T0, T0), prepared([T0]));
  assert.deepEqual(j.waiting, [T0]);
});

test("there is never more than one write outstanding", () => {
  const j = beginPrepared(taps(T0, T0 + MIN), prepared([T0]));
  assert.throws(() => beginPrepared(j, prepared([T0 + MIN])));
});

test("a write cannot claim a tap that is not waiting", () => {
  assert.throws(() => beginPrepared(taps(T0), prepared([T0 + MIN])));
  assert.throws(() => beginPrepared(taps(T0), prepared([])));
});

test("a landed write becomes counted laps with their times, still unsealed", () => {
  const j = preparedLanded(beginPrepared(taps(T0, T0 + MIN), prepared([T0, T0 + MIN])));
  assert.equal(j.prepared, null);
  assert.deepEqual(j.counted, [{ seq: 7, total: 40, times: [T0, T0 + MIN], sealed: false }]);
});

test("a lost write hands its taps back to the FRONT with their original times", () => {
  let j = beginPrepared(taps(T0, T0 + MIN), prepared([T0, T0 + MIN]));
  j = addTap(j, T0 + 9 * MIN); // tapped while the write was in the air
  j = preparedLost(j);
  assert.equal(j.prepared, null);
  assert.deepEqual(j.waiting, [T0, T0 + MIN, T0 + 9 * MIN]);
  assert.deepEqual(j.counted, []);
});

test("settling with nothing outstanding changes nothing", () => {
  const j = taps(T0);
  assert.deepEqual(preparedLanded(j), j);
  assert.deepEqual(preparedLost(j), j);
});

// ---------------------------------------------------------------------------
// What the screen may claim
// ---------------------------------------------------------------------------

test("waiting laps are NEVER part of the count on screen", () => {
  const j = taps(T0, T0 + MIN);
  assert.deepEqual(cardNumbers({ headTotal: 128, rememberedTotal: 120, journal: j }), { counted: 128, waiting: 2 });
});

test("with no live head the remembered count shows, and waiting still stays apart", () => {
  const j = taps(T0);
  assert.deepEqual(cardNumbers({ headTotal: null, rememberedTotal: 57, journal: j }), { counted: 57, waiting: 1 });
  assert.deepEqual(cardNumbers({ headTotal: null, rememberedTotal: null, journal: j }), { counted: 0, waiting: 1 });
});

test("a write in doubt is waiting; an accepted one is already in the count", () => {
  const bound = beginPrepared(taps(T0, T0 + MIN, T0 + 2 * MIN), prepared([T0, T0 + MIN]));
  assert.equal(journalCounts(bound).waiting, 3, "two in doubt plus one not yet bound");
  assert.equal(journalCounts(markAccepted(bound)).waiting, 1, "the accepted write's laps moved into the head");
});

test("unsealed counts laps whose times exist only on this phone", () => {
  const landed = preparedLanded(beginPrepared(taps(T0, T0 + MIN), prepared([T0, T0 + MIN])));
  assert.equal(journalCounts(landed).unsealed, 2);
  assert.equal(nextUnsealed(landed)?.seq, 7);
  const sealed = markSealed(landed, 7);
  assert.equal(journalCounts(sealed).unsealed, 0);
  assert.equal(nextUnsealed(sealed), null);
});

test("laps are numbered from the statement's carried total", () => {
  const landed = preparedLanded(beginPrepared(taps(T0, T0 + MIN, T0 + 2 * MIN), prepared([T0, T0 + MIN, T0 + 2 * MIN])));
  const rows = lapRows(landed, utcDateOf, "2026-09-21");
  assert.deepEqual(rows.map((r) => r.lap), [38, 39, 40]);
  assert.deepEqual(rows.map((r) => r.at), [T0, T0 + MIN, T0 + 2 * MIN]);
});

test("the list shows waiting laps with their times, unnumbered", () => {
  const rows = lapRows(taps(T0), utcDateOf, "2026-09-21");
  assert.deepEqual(rows, [{ at: T0, lap: null, state: "waiting" }]);
});

test("the list is one day's laps only", () => {
  const j = taps(T0, T0 + 24 * 60 * MIN);
  assert.equal(lapRows(j, utcDateOf, "2026-09-21").length, 1);
  assert.equal(lapRows(j, utcDateOf, "2026-09-22").length, 1);
});

// ---------------------------------------------------------------------------
// Held laps
// ---------------------------------------------------------------------------

test("laps dated before a newer head are held, and newer laps still go", () => {
  const monday = Date.UTC(2026, 8, 21, 16, 0, 0);
  const tuesday = Date.UTC(2026, 8, 22, 9, 0, 0);
  const j = holdBefore(taps(monday, tuesday), "2026-09-22");
  assert.deepEqual(nextGroup(j), { date: "2026-09-22", times: [tuesday] });
  assert.deepEqual(journalCounts(j), { waiting: 2, held: 1, unsealed: 0 });
  assert.equal(lapRows(j, utcDateOf, "2026-09-21")[0]?.state, "held");
});

test("a hold only ever moves forward", () => {
  assert.equal(holdBefore(holdBefore(emptyJournal(), "2026-09-22"), "2026-09-20").heldBefore, "2026-09-22");
});

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

test("the double-tap guard reads the newest tap this phone knows of", () => {
  assert.equal(lastTapAt(emptyJournal()), 0);
  const j = addTap(preparedLanded(beginPrepared(taps(T0), prepared([T0]))), T0 + 4 * MIN);
  assert.equal(lastTapAt(j), T0 + 4 * MIN);
});

test("pruning never drops times that are not sealed yet", () => {
  const old = T0 - 30 * 24 * 60 * MIN;
  const landed = preparedLanded(beginPrepared(taps(old), prepared([old])));
  assert.equal(pruneJournal(landed, T0, 14 * 24 * 60 * MIN).counted.length, 1, "unsealed: the only copy");
  assert.equal(pruneJournal(markSealed(landed, 7), T0, 14 * 24 * 60 * MIN).counted.length, 0);
});

test("a journal survives the JSON round trip it is stored in", () => {
  const j = addTap(markAccepted(beginPrepared(taps(T0, T0 + MIN), prepared([T0]))), T0 + 2 * MIN);
  assert.deepEqual(parseJournal(JSON.parse(JSON.stringify(j))), j);
});

test("anything that is not a journal reads as an empty one", () => {
  for (const junk of [null, 1, "x", [], {}, { v: 2 }, { v: 1, waiting: ["a"], counted: [] }, { v: 1, waiting: [], counted: [{}] }]) {
    assert.deepEqual(parseJournal(junk), emptyJournal());
  }
});
