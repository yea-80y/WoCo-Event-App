/**
 * The subject registry is disposable, but two things it asserts are not.
 *
 * The hash <-> id binding: an entry keyed by a hash that does not derive from
 * its own `id` would render one coaster's name against another's count, and
 * every signature involved would still verify.
 *
 * And the naming history: a re-theme must never rewrite what a rider's
 * collection says they rode. "I rode it when it was X" is a large part of what
 * this hobby values, so an era is ADDED and the old name survives.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSubjectCatalogue,
  lookupSubject,
  subjectDisplayName,
  currentEra,
  eraOn,
  formerNames,
  WOCO_SUBJECTS,
  WOCO_SUBJECT_DEFINITIONS,
  RITA_SUBJECT,
  type SubjectDefinition,
} from "../../src/credit/registry.js";
import { creditSubject } from "../../src/credit/types.js";
import type { Hex0x } from "../../src/types.js";

function def(over: Partial<SubjectDefinition> = {}): SubjectDefinition {
  return {
    id: "test-a",
    eras: [{ name: "Test", park: "Somewhere" }],
    timezone: "UTC",
    cadenceMinutes: 2,
    ...over,
  };
}

/** A coaster re-themed mid-2027 — the case this model exists for. */
const rethemed = def({
  id: "rethemed",
  eras: [
    { name: "Rita", park: "Alton Towers" },
    { name: "Toxicator", park: "Alton Towers", from: "2027-03-20" },
  ],
});

test("the pilot subject is permanent — its hash derives from its recorded id", () => {
  // If this vector moves, every statement already written for Rita is orphaned.
  assert.equal(
    RITA_SUBJECT,
    "0xf1b7f5115cfaf052619cad0d34ae3a26425e8a6d84647120174bf33f261b201b",
  );
  assert.equal(RITA_SUBJECT, creditSubject("mstisnru-cjt0ipv"));
  assert.equal(subjectDisplayName(WOCO_SUBJECTS, RITA_SUBJECT), "Rita");
});

test("every bundled entry is keyed by a hash recomputed from its own id", () => {
  for (const d of WOCO_SUBJECT_DEFINITIONS) {
    assert.equal(lookupSubject(WOCO_SUBJECTS, creditSubject(d.id))?.id, d.id);
  }
});

test("a rename adds an era and the subject does NOT change", () => {
  // The count must stay continuous across a re-theme: it is the same track and
  // the same credit, so splitting the subject would split the rider's total.
  assert.equal(creditSubject(rethemed.id), creditSubject("rethemed"));
  assert.equal(currentEra(rethemed).name, "Toxicator");
  assert.deepEqual(formerNames(rethemed), ["Rita"]);
});

test("laps are attributable to the era they were ridden in, from the signed date", () => {
  // No schema needed — `session.date` is already on every statement.
  assert.equal(eraOn(rethemed, "2026-09-12").name, "Rita");
  assert.equal(eraOn(rethemed, "2027-03-19").name, "Rita");
  assert.equal(eraOn(rethemed, "2027-03-20").name, "Toxicator", "the era starts ON its from-date");
  assert.equal(eraOn(rethemed, "2028-01-01").name, "Toxicator");
});

test("a date before every known era resolves to the first, not to nothing", () => {
  // The registry not knowing how far back a name goes is not evidence the
  // coaster was nameless.
  assert.equal(eraOn(rethemed, "1999-01-01").name, "Rita");
});

test("a coaster with one name has no former names", () => {
  assert.deepEqual(formerNames(def()), []);
});

test("relocation is carried per era, because the park changes with it", () => {
  const moved = def({
    id: "moved",
    eras: [
      { name: "Boomerang", park: "Old Park" },
      { name: "Boomerang", park: "New Park", from: "2027-01-01" },
    ],
  });
  assert.equal(eraOn(moved, "2026-06-01").park, "Old Park");
  assert.equal(eraOn(moved, "2027-06-01").park, "New Park");
  // Same name throughout, so nothing is reported as a FORMER name.
  assert.deepEqual(formerNames(moved), []);
});

test("a new credit links to what it replaced instead of merging counts", () => {
  const old = creditSubject("rethemed");
  const retracked = def({ id: "retracked", supersedes: old });
  const c = buildSubjectCatalogue([rethemed, retracked]);
  assert.equal(lookupSubject(c, creditSubject("retracked"))?.supersedes, old);
  // Separate subjects, so separate counts — which is the point of it being a
  // new credit rather than a rename.
  assert.notEqual(creditSubject("retracked"), old);
});

test("a catalogue is keyed by the recomputed hash, not by anything supplied", () => {
  const c = buildSubjectCatalogue([def({ id: "alpha" }), def({ id: "beta" })]);
  assert.equal(lookupSubject(c, creditSubject("alpha"))?.id, "alpha");
  assert.equal(lookupSubject(c, creditSubject("beta"))?.id, "beta");
});

test("two entries claiming one subject throw rather than silently merging", () => {
  assert.throws(() => buildSubjectCatalogue([def({ id: "same" }), def({ id: "same" })]), /duplicate subject id/);
});

test("malformed definitions are refused", () => {
  assert.throws(() => buildSubjectCatalogue([def({ id: "" })]), /no id/);
  assert.throws(() => buildSubjectCatalogue([def({ eras: [] })]), /no eras/);
  assert.throws(() => buildSubjectCatalogue([def({ cadenceMinutes: -1 })]), /cadenceMinutes/);
  assert.throws(() => buildSubjectCatalogue([def({ cadenceMinutes: NaN })]), /cadenceMinutes/);
});

test("dating the first era is refused — it is the silent-rename mistake", () => {
  // Editing era 0 instead of appending era 1 is exactly how the old name gets
  // erased, so the shape that implies it is rejected outright.
  assert.throws(
    () => buildSubjectCatalogue([def({ eras: [{ name: "New", park: "P", from: "2027-01-01" }] })]),
    /add an era rather than dating the first/,
  );
});

test("later eras need a start date, in order", () => {
  assert.throws(
    () => buildSubjectCatalogue([def({ eras: [{ name: "A", park: "P" }, { name: "B", park: "P" }] })]),
    /era 1 has no `from`/,
  );
  assert.throws(
    () => buildSubjectCatalogue([
      def({ eras: [
        { name: "A", park: "P" },
        { name: "B", park: "P", from: "2027-06-01" },
        { name: "C", park: "P", from: "2027-01-01" },
      ] }),
    ]),
    /out of order/,
  );
});

test("an unknown subject renders as unknown, never blank and never guessed", () => {
  const unknown = `0x${"99".repeat(32)}` as Hex0x;
  assert.equal(lookupSubject(WOCO_SUBJECTS, unknown), null);
  const shown = subjectDisplayName(WOCO_SUBJECTS, unknown);
  assert.match(shown, /^Unknown coaster \(0x999999/);
  assert.notEqual(shown.trim(), "");
});

test("the catalogue is frozen, so a caller cannot edit shipped meanings in place", () => {
  assert.throws(() => {
    (WOCO_SUBJECTS as Record<string, SubjectDefinition>)[RITA_SUBJECT] = def();
  });
});

// ---------------------------------------------------------------------------
// The demo coaster
// ---------------------------------------------------------------------------
//
// It exists so a live demo never needs a false tap on Rita — signing a lap
// nobody rode, on the honesty product, on a permanent log. What keeps it safe
// is that it labels itself in the two fields every surface renders, so the
// label travels into its own screenshot with no flag for anyone to forget.
// These pin that property rather than the entry's existence.

const DEMO_SUBJECT = "0xadd9035a868daff172c831004fe5e8b1b1dd7d5240a907c0830922e8abe6c7e2" as Hex0x;

test("the demo subject resolves, so the refusal to fake Rita has somewhere to go", () => {
  assert.notEqual(lookupSubject(WOCO_SUBJECTS, DEMO_SUBJECT), null);
});

test("the demo coaster says it is not real in the fields every surface shows", () => {
  const def = lookupSubject(WOCO_SUBJECTS, DEMO_SUBJECT)!;
  const era = currentEra(def);
  // Name AND park, because different surfaces lead with different ones: the
  // collecting card heads with the name, the public counter's headline pairs
  // both. Either one alone could be cropped out of a screenshot.
  assert.match(era.name, /demo/i);
  assert.match(era.park, /not a real ride/i);
});

test("the demo coaster does not arm the double-tap guard", () => {
  // Demos tap in quick succession, and the guard only arms above zero.
  assert.equal(lookupSubject(WOCO_SUBJECTS, DEMO_SUBJECT)!.cadenceMinutes, 0);
});

test("the demo entry did not disturb Rita's subject, which is a permanent hash", () => {
  // An id here is a hash input riders sign against; editing one after anything
  // has been written for it silently makes a different coaster.
  assert.equal(RITA_SUBJECT, "0xf1b7f5115cfaf052619cad0d34ae3a26425e8a6d84647120174bf33f261b201b");
  assert.equal(currentEra(lookupSubject(WOCO_SUBJECTS, RITA_SUBJECT)!).name, "Rita");
});
