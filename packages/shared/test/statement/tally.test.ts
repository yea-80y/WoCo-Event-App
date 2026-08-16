/**
 * Tally rules. These decide whether two independent indexers, handed the same
 * statements, publish the same number — which is the entire basis for anyone
 * being able to disbelieve ours and check for themselves.
 *
 * The properties worth pinning are the ones whose failure is SILENT: a wrong
 * winner still produces a plausible count, and unsorted evidence produces two
 * manifests that disagree byte-for-byte while agreeing on the number.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tallyBooleanStatements,
  tallyCarriedTotals,
  booleanEvidenceManifest,
  carriedEvidenceManifest,
  recountManifest,
  type ObservedStatement,
} from "../../src/statement/tally.js";
import type { Hex0x } from "../../src/types.js";

const OWNER_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex0x;
const OWNER_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex0x;
const OWNER_C = "0xcccccccccccccccccccccccccccccccccccccccc" as Hex0x;
const SUBJECT = `0x${"11".repeat(32)}` as Hex0x;

const digest = (n: string): Hex0x => `0x${n.repeat(32)}` as Hex0x;

function like(feedOwner: Hex0x, version: number, value: boolean, d = "01"): ObservedStatement<{ value: boolean }> {
  return { feedOwner, version, digest: digest(d), statement: { value } };
}

/**
 * `version` defaults to 0 rather than to `seq`, deliberately: they are
 * different numbers (the holder's ordering vs the feed's, and the feed's
 * restarts at 0 on the public topic), and a helper that quietly set one from
 * the other would hide the distinction the evidence leaf now has to carry.
 */
function credit(
  feedOwner: Hex0x,
  holder: string,
  seq: number,
  total: number,
  d = "01",
  version = 0,
): ObservedStatement<{ holder: string; seq: number; total: number }> {
  return { feedOwner, version, digest: digest(d), statement: { holder, seq, total } };
}

// ---------------------------------------------------------------------------
// Boolean
// ---------------------------------------------------------------------------

test("the highest SOC version wins per feed owner", () => {
  const t = tallyBooleanStatements([
    like(OWNER_A, 0, true, "01"),
    like(OWNER_A, 1, false, "02"),
    like(OWNER_A, 2, true, "03"),
  ]);
  assert.equal(t.count, 1);
  assert.equal(t.evidence.length, 1, "one owner, one surviving statement");
  assert.equal(t.evidence[0]!.version, 2);
});

test("input order does not change the winner", () => {
  const forwards = tallyBooleanStatements([like(OWNER_A, 0, true, "01"), like(OWNER_A, 1, false, "02")]);
  const backwards = tallyBooleanStatements([like(OWNER_A, 1, false, "02"), like(OWNER_A, 0, true, "01")]);
  assert.deepEqual(forwards, backwards);
  assert.equal(forwards.count, 0, "the retraction is current");
});

test("a retraction is excluded from the count but PRESENT in the evidence", () => {
  // Dropping it would make an unlike indistinguishable from never having liked,
  // and someone checking "was my retraction read?" needs to see it.
  const t = tallyBooleanStatements([like(OWNER_A, 1, false), like(OWNER_B, 0, true)]);
  assert.equal(t.count, 1);
  assert.equal(t.evidence.length, 2);
  assert.equal(t.evidence.find((e) => e.feedOwner === OWNER_A)?.value, false);
});

test("evidence is sorted, so two indexers publish byte-identical manifests", () => {
  const one = tallyBooleanStatements([like(OWNER_C, 0, true), like(OWNER_A, 0, true), like(OWNER_B, 0, true)]);
  const two = tallyBooleanStatements([like(OWNER_A, 0, true), like(OWNER_B, 0, true), like(OWNER_C, 0, true)]);
  assert.deepEqual(one.evidence, two.evidence);
  assert.deepEqual(one.evidence.map((e) => e.feedOwner), [OWNER_A, OWNER_B, OWNER_C]);
});

test("two different statements at one version is impossible, so it throws", () => {
  // A SOC is immutable: the first write at a version is the only write at it.
  // Seeing two means the input did not come from one feed, and silently
  // picking one would bury an upstream fault in a plausible number.
  assert.throws(
    () => tallyBooleanStatements([like(OWNER_A, 3, true, "01"), like(OWNER_A, 3, false, "02")]),
    /immutable/,
  );
});

test("the same statement seen twice is not an equivocation", () => {
  const t = tallyBooleanStatements([like(OWNER_A, 3, true, "01"), like(OWNER_A, 3, true, "01")]);
  assert.equal(t.count, 1);
});

// ---------------------------------------------------------------------------
// Carried totals
// ---------------------------------------------------------------------------

test("the highest seq wins and its total is carried, never summed", () => {
  // The trap: summing 1 + 5 + 12 would report 18 rides for someone who rode 12.
  const t = tallyCarriedTotals([
    credit(OWNER_A, "aa", 0, 1, "01"),
    credit(OWNER_A, "aa", 1, 5, "02"),
    credit(OWNER_A, "aa", 2, 12, "03"),
  ]);
  assert.equal(t.total, 12);
  assert.equal(t.holders, 1);
});

test("a correction downward is honoured, because seq orders and total does not", () => {
  const t = tallyCarriedTotals([credit(OWNER_A, "aa", 5, 40, "01"), credit(OWNER_A, "aa", 6, 38, "02")]);
  assert.equal(t.total, 38);
});

test("the count keys on HOLDER, not on the feed it was relayed through", () => {
  // One rider, two devices, two feeds — ordinary, and must not read as two people.
  const t = tallyCarriedTotals([credit(OWNER_A, "aa", 3, 30, "01"), credit(OWNER_B, "aa", 4, 34, "02")]);
  assert.equal(t.holders, 1);
  assert.equal(t.total, 34);
});

test("totals sum ACROSS holders while carrying within each", () => {
  const t = tallyCarriedTotals([
    credit(OWNER_A, "aa", 1, 10, "01"),
    credit(OWNER_A, "aa", 2, 12, "02"),
    credit(OWNER_B, "bb", 0, 3, "03"),
  ]);
  assert.equal(t.holders, 2);
  assert.equal(t.total, 15, "12 + 3, not 10 + 12 + 3");
});

test("a tie at one seq resolves to the lower digest, deterministically", () => {
  const lower = credit(OWNER_A, "aa", 4, 100, "01");
  const higher = credit(OWNER_B, "aa", 4, 999, "0f");
  assert.equal(tallyCarriedTotals([lower, higher]).total, 100);
  assert.equal(tallyCarriedTotals([higher, lower]).total, 100, "and input order cannot change it");
});

test("an equivocation is flagged rather than smoothed away", () => {
  const t = tallyCarriedTotals([credit(OWNER_A, "aa", 4, 100, "01"), credit(OWNER_B, "aa", 4, 999, "0f")]);
  assert.deepEqual(t.equivocations, ["aa"]);
});

test("the same statement seen twice is not an equivocation", () => {
  const t = tallyCarriedTotals([credit(OWNER_A, "aa", 4, 100, "01"), credit(OWNER_A, "aa", 4, 100, "01")]);
  assert.deepEqual(t.equivocations, []);
  assert.equal(t.total, 100);
});

test("holder keys are compared case-insensitively", () => {
  const t = tallyCarriedTotals([credit(OWNER_A, "AA", 1, 5, "01"), credit(OWNER_A, "aa", 2, 9, "02")]);
  assert.equal(t.holders, 1);
  assert.equal(t.total, 9);
});

// ---------------------------------------------------------------------------
// Evidence manifest
// ---------------------------------------------------------------------------

test("a manifest recounts to its own headline number", () => {
  const tally = tallyBooleanStatements([like(OWNER_A, 0, true), like(OWNER_B, 0, false), like(OWNER_C, 0, true)]);
  const m = booleanEvidenceManifest({
    statementFormat: "woco.like.v1",
    subject: SUBJECT,
    participants: [OWNER_C, OWNER_A, OWNER_B],
    tally,
  });
  assert.equal(m.count, 2);
  assert.deepEqual(recountManifest(m), { consistent: true, recounted: 2 });
  assert.deepEqual(m.participants, [OWNER_A, OWNER_B, OWNER_C], "sorted, so manifests are comparable");
});

test("a manifest whose headline disagrees with its leaves is self-refuting", () => {
  const tally = tallyBooleanStatements([like(OWNER_A, 0, true)]);
  const m = booleanEvidenceManifest({ statementFormat: "woco.like.v1", subject: SUBJECT, participants: [OWNER_A], tally });
  const inflated = { ...m, count: 5000 };
  assert.deepEqual(recountManifest(inflated), { consistent: false, recounted: 1 });
});

test("a carried-total manifest carries the VALUES, since list length proves nothing", () => {
  // Commitment 4's "count = list length" spot-check does not hold once a total
  // is carried rather than summed — three leaves can justify any number at all
  // unless the numbers themselves are published.
  const tally = tallyCarriedTotals([credit(OWNER_A, "aa", 2, 47, "01"), credit(OWNER_B, "bb", 0, 3, "02")]);
  const m = carriedEvidenceManifest({
    statementFormat: "woco.credit.v1",
    subject: SUBJECT,
    participants: [OWNER_B, OWNER_A],
    tally,
  });
  assert.equal(m.count, 50);
  assert.equal(m.leaves.length, 2);
  assert.deepEqual(recountManifest(m), { consistent: true, recounted: 50 });
  assert.deepEqual(m.leaves.map((l) => l.total), [47, 3]);
});

test("a carried leaf carries the FEED version, not the holder's seq", () => {
  // The two are different numbers and the leaf needs the feed's: `seq` is the
  // holder's ordering and continues across the private→public topic migration,
  // while the version restarts at 0 on the new topic. Without this a reader
  // cannot derive the chunk address and has to walk versions from zero — the
  // absent-chunk probe the indexer is otherwise careful never to provoke.
  const tally = tallyCarriedTotals([credit(OWNER_A, "aa", 41, 41, "01", 2)]);
  assert.equal(tally.evidence[0]!.seq, 41);
  assert.equal(tally.evidence[0]!.version, 2);
});

test("participants are declared even when they contributed nothing", () => {
  // The input set is what makes two indexers comparable, and an omitted
  // participant is the one power a publishing indexer retains — so a reader
  // must be able to look for themselves in it.
  const tally = tallyBooleanStatements([like(OWNER_A, 0, true)]);
  const m = booleanEvidenceManifest({
    statementFormat: "woco.like.v1",
    subject: SUBJECT,
    participants: [OWNER_A, OWNER_B],
    tally,
  });
  assert.deepEqual(m.participants, [OWNER_A, OWNER_B]);
  assert.equal(m.leaves.length, 1, "B was read and had nothing to say");
});
