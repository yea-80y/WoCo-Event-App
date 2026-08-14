/**
 * The subject registry is disposable, but the hash <-> id binding it asserts is
 * not: a catalogue entry keyed by a hash that does not derive from its own `id`
 * would render one coaster's name against another's count, and every signature
 * involved would still verify. So the properties pinned here are the ones whose
 * failure is silent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSubjectCatalogue,
  lookupSubject,
  subjectDisplayName,
  WOCO_SUBJECTS,
  WOCO_SUBJECT_DEFINITIONS,
  RITA_SUBJECT,
  type SubjectDefinition,
} from "../../src/credit/registry.js";
import { creditSubject } from "../../src/credit/types.js";
import type { Hex0x } from "../../src/types.js";

function def(over: Partial<SubjectDefinition> = {}): SubjectDefinition {
  return { id: "test-a", name: "Test", park: "Somewhere", timezone: "UTC", cadenceMinutes: 2, ...over };
}

test("the pilot subject is permanent — its hash derives from its recorded id", () => {
  // If this vector moves, every statement already written for Rita is orphaned.
  assert.equal(
    RITA_SUBJECT,
    "0xf1b7f5115cfaf052619cad0d34ae3a26425e8a6d84647120174bf33f261b201b",
  );
  assert.equal(RITA_SUBJECT, creditSubject("mstisnru-cjt0ipv"));
  assert.equal(lookupSubject(WOCO_SUBJECTS, RITA_SUBJECT)?.name, "Rita");
});

test("every bundled entry is keyed by a hash recomputed from its own id", () => {
  for (const d of WOCO_SUBJECT_DEFINITIONS) {
    assert.equal(lookupSubject(WOCO_SUBJECTS, creditSubject(d.id))?.id, d.id);
  }
});

test("a catalogue is keyed by the recomputed hash, not by anything supplied", () => {
  const c = buildSubjectCatalogue([def({ id: "alpha", name: "Alpha" }), def({ id: "beta", name: "Beta" })]);
  assert.equal(lookupSubject(c, creditSubject("alpha"))?.name, "Alpha");
  assert.equal(lookupSubject(c, creditSubject("beta"))?.name, "Beta");
});

test("two entries claiming one subject throw rather than silently merging", () => {
  assert.throws(
    () => buildSubjectCatalogue([def({ id: "same", name: "First" }), def({ id: "same", name: "Second" })]),
    /duplicate subject id/,
  );
});

test("a definition without an id, or with a nonsense cadence, is refused", () => {
  assert.throws(() => buildSubjectCatalogue([def({ id: "" })]), /no id/);
  assert.throws(() => buildSubjectCatalogue([def({ cadenceMinutes: -1 })]), /cadenceMinutes/);
  assert.throws(() => buildSubjectCatalogue([def({ cadenceMinutes: NaN })]), /cadenceMinutes/);
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
    (WOCO_SUBJECTS as Record<string, SubjectDefinition>)[RITA_SUBJECT] = def({ name: "Nemesis" });
  });
});
