/**
 * The carry rule for coaster credits (docs/COASTER_CREDITS_PLAN.md, frozen
 * aggregation): `total` is CARRIED on every statement and NEVER summed across
 * writes. An indexer takes the total from the highest-`seq` statement, full
 * stop — so if the write side ever emitted a delta instead, eight taps would
 * read as the sum of eight totals rather than eight rides.
 *
 * That trap is the reason this logic is separated from the module that reaches
 * the auth store: it is worth pinning, and it is pure.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { nextCreditStatement, utcSessionDate } from "../src/lib/credits/next-statement.js";
import { CREDIT_STATEMENT_FORMAT, type CreditStatementV1, type Hex0x } from "@woco/shared";

const SUBJECT = `0x${"11".repeat(32)}` as Hex0x;
const HOLDER = "aa".repeat(32);

function head(over: Partial<CreditStatementV1> = {}): CreditStatementV1 {
  return {
    format: CREDIT_STATEMENT_FORMAT,
    subject: SUBJECT,
    holder: HOLDER,
    seq: 4,
    total: 37,
    session: { date: "2026-09-12", count: 9 },
    holderSig: "bb".repeat(64),
    ...over,
  };
}

test("a first ride starts at seq 0 with a total of one", () => {
  const s = nextCreditStatement({ prev: null, subject: SUBJECT, holder: HOLDER, laps: 1, date: "2026-09-12" });
  assert.equal(s.seq, 0);
  assert.equal(s.total, 1);
  assert.deepEqual(s.session, { date: "2026-09-12", count: 1 });
});

test("total is carried and incremented, never re-summed", () => {
  const s = nextCreditStatement({ prev: head(), subject: SUBJECT, holder: HOLDER, laps: 1, date: "2026-09-12" });
  assert.equal(s.total, 38, "38 = the carried 37 plus this ride");
  assert.equal(s.seq, 5);
});

test("eight taps in a day read as eight rides, not the sum of eight totals", () => {
  // The regression this file exists for. Walk the write path the way a rider's
  // device would, then assert the number an indexer would actually publish.
  let prev: CreditStatementV1 | null = null;
  for (let i = 0; i < 8; i++) {
    const next = nextCreditStatement({ prev, subject: SUBJECT, holder: HOLDER, laps: 1, date: "2026-09-12" });
    prev = { ...next, holderSig: "cc".repeat(64) };
  }
  assert.equal(prev!.total, 8);
  assert.equal(prev!.session.count, 8);
  assert.equal(prev!.seq, 7);
});

test("the session block resets on a new UTC day but the lifetime total does not", () => {
  const s = nextCreditStatement({ prev: head(), subject: SUBJECT, holder: HOLDER, laps: 1, date: "2026-09-13" });
  assert.equal(s.session.count, 1, "a new day starts its own block");
  assert.equal(s.session.date, "2026-09-13");
  assert.equal(s.total, 38, "lifetime carries across the date boundary");
});

test("a batched offline day is one statement, not one per lap", () => {
  // The property that makes airplane-mode collecting work: because the total is
  // carried rather than delta-summed, laps recorded while offline collapse into
  // a single write when signal returns.
  const s = nextCreditStatement({ prev: head(), subject: SUBJECT, holder: HOLDER, laps: 47, date: "2026-09-12" });
  assert.equal(s.total, 84);
  assert.equal(s.session.count, 56);
  assert.equal(s.seq, 5, "one write, so seq advances once");
});

test("laps must be a positive whole number", () => {
  for (const laps of [0, -1, 1.5, NaN]) {
    assert.throws(
      () => nextCreditStatement({ prev: null, subject: SUBJECT, holder: HOLDER, laps, date: "2026-09-12" }),
      /positive whole number/,
    );
  }
});

test("the session date is UTC, so it never depends on the subject registry", () => {
  // 23:30 at a UTC-8 park is already the NEXT UTC day — the accepted cost of a
  // signed field that cannot be reinterpreted by a later registry correction.
  assert.equal(utcSessionDate(new Date("2026-09-13T07:30:00Z")), "2026-09-13");
  assert.equal(utcSessionDate(new Date("2026-09-12T23:59:59Z")), "2026-09-12");
});
