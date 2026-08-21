/**
 * Holder-list assembly — where a silent drop would actually live.
 *
 * The run these feed is permanent and unrevocable, so the property under test
 * throughout is not "valid input works". It is that INVALID input is named
 * rather than discarded: an organiser who believes they awarded a badge to
 * someone who never received one has no way to discover that, and no way to
 * undo it if they do.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseHolderKeys,
  splitAttendees,
  holderRejectLabel,
  type AttendeeCandidate,
} from "../src/lib/pod-cert/holders.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

// ---------------------------------------------------------------------------
// parseHolderKeys
// ---------------------------------------------------------------------------

test("valid keys parse in order", () => {
  const r = parseHolderKeys(`${A}\n${B}`);
  assert.deepEqual(r.keys, [A, B]);
  assert.deepEqual(r.rejects, []);
});

test("blank lines and whitespace are tolerated, not reported", () => {
  const r = parseHolderKeys(`\n  ${A}  \n\n\t${B}\n  \n`);
  assert.deepEqual(r.keys, [A, B]);
  assert.deepEqual(r.rejects, [], "a blank line is not a mistake worth naming");
});

test("an 0x prefix is accepted and stripped", () => {
  // The schema says bare hex, but every other hex value in the product carries
  // a prefix, so a paste will contain them.
  const r = parseHolderKeys(`0x${A}\n0X${B}`);
  assert.deepEqual(r.keys, [A, B]);
});

test("mixed case is normalised — the schema is lowercase", () => {
  const r = parseHolderKeys(A.toUpperCase());
  assert.deepEqual(r.keys, [A]);
});

test("A BAD LINE IS NAMED, with its line number", () => {
  // The whole point. Dropping it would let the organiser confirm a count that
  // does not match what lands.
  const r = parseHolderKeys(`${A}\nnot-a-key\n${B}`);
  assert.deepEqual(r.keys, [A, B]);
  assert.equal(r.rejects.length, 1);
  assert.equal(r.rejects[0]!.line, 2, "the line number must match what the organiser sees");
  assert.equal(r.rejects[0]!.reason, "not-a-key");
});

test("line numbers count blank lines, so they match the textarea", () => {
  const r = parseHolderKeys(`\n\nbroken`);
  assert.equal(r.rejects[0]!.line, 3);
});

test("near-misses are rejected, not coerced", () => {
  for (const bad of ["a".repeat(63), "a".repeat(65), "g".repeat(64), "0x", "12345"]) {
    const r = parseHolderKeys(bad);
    assert.deepEqual(r.keys, [], `${bad.slice(0, 10)} must not be accepted`);
    assert.equal(r.rejects.length, 1);
  }
});

test("DUPLICATES ARE REPORTED, not quietly collapsed", () => {
  // planCertIssuance would dedupe anyway, so this changes no bytes — but a
  // list that silently means something other than what was typed is how a
  // confirmed count and a landed count come apart.
  const r = parseHolderKeys(`${A}\n${A}`);
  assert.deepEqual(r.keys, [A]);
  assert.equal(r.rejects.length, 1);
  assert.equal(r.rejects[0]!.reason, "duplicate");
  assert.equal(r.rejects[0]!.line, 2);
});

test("a duplicate differing only in case or prefix is still a duplicate", () => {
  const r = parseHolderKeys(`${A}\n0x${A.toUpperCase()}`);
  assert.deepEqual(r.keys, [A]);
  assert.equal(r.rejects[0]!.reason, "duplicate");
});

test("every non-blank line is accounted for — nothing vanishes", () => {
  const text = `${A}\nrubbish\n${A}\n${B}`;
  const r = parseHolderKeys(text);
  const nonBlank = text.split("\n").filter((l) => l.trim()).length;
  assert.equal(r.keys.length + r.rejects.length, nonBlank);
});

test("empty input is an empty list, not a throw", () => {
  assert.deepEqual(parseHolderKeys("").keys, []);
  assert.deepEqual(parseHolderKeys("   \n  ").rejects, []);
});

test("reject labels distinguish the two reasons", () => {
  assert.notEqual(holderRejectLabel("duplicate"), holderRejectLabel("not-a-key"));
});

// ---------------------------------------------------------------------------
// splitAttendees
// ---------------------------------------------------------------------------

function att(over: Partial<AttendeeCandidate> = {}): AttendeeCandidate {
  return { seriesId: "s1", edition: 1, route: "claim", ...over };
}

test("attendees WITHOUT a key are kept and counted, never dropped", () => {
  // The handover's explicit requirement, and the reason it exists: most
  // attendees have no POD key on file at all, so a picker that dropped them
  // would show an empty list indistinguishable from a broken one.
  const s = splitAttendees([att({ podPubKey: A }), att({ edition: 2 })]);
  assert.deepEqual(s.certifiable, [A]);
  assert.equal(s.withoutKey.length, 1);
  assert.equal(s.withoutKey[0]!.edition, 2);
});

test("THE UNIT IS THE PERSON — a multi-ticket buyer is one holder", () => {
  const s = splitAttendees([
    att({ edition: 1, podPubKey: A }),
    att({ edition: 2, podPubKey: A }),
    att({ edition: 3, podPubKey: B }),
  ]);
  assert.deepEqual(s.certifiable, [A, B]);
  assert.equal(s.duplicateEditions, 1, "reported, so the arithmetic is explicable");
});

test("a malformed key counts as WITHOUT a key, never passed through", () => {
  const s = splitAttendees([att({ podPubKey: "nonsense" })]);
  assert.deepEqual(s.certifiable, []);
  assert.equal(s.withoutKey.length, 1);
});

test("keys are normalised, so case never splits one person into two", () => {
  const s = splitAttendees([att({ podPubKey: A.toUpperCase() }), att({ edition: 2, podPubKey: A })]);
  assert.deepEqual(s.certifiable, [A]);
  assert.equal(s.duplicateEditions, 1);
});

test("every row is accounted for", () => {
  const rows = [att({ podPubKey: A }), att({ edition: 2, podPubKey: A }), att({ edition: 3 }), att({ edition: 4, podPubKey: C })];
  const s = splitAttendees(rows);
  assert.equal(
    s.certifiable.length + s.withoutKey.length + s.duplicateEditions,
    rows.length,
    "certifiable + keyless + collapsed must equal what came in",
  );
});

test("an empty attendee list splits cleanly", () => {
  const s = splitAttendees([]);
  assert.deepEqual(s.certifiable, []);
  assert.deepEqual(s.withoutKey, []);
  assert.equal(s.duplicateEditions, 0);
});
