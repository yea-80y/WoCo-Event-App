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
  uncertifiableLabel,
  type AttendeeCandidate,
} from "../src/lib/cert/holders.js";

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
// splitAttendees — the denominator is CLAIMS, never bindings
// ---------------------------------------------------------------------------
//
// SINCE #518 NOBODY IS CERTIFIABLE FROM PLATFORM DATA. The rows this joins
// against carried an ed25519 holder key that the claiming client declared and
// nothing ever verified (#345); it is gone, and the cert rail's secp256k1
// replacement does not exist yet. So `certifiable` is empty and every claim is
// un-certifiable.
//
// That makes the surviving property the ONLY one that matters here, and it is
// the one the rail keeps relearning: an attendee who cannot be awarded must be
// COUNTED AND SHOWN, never dropped. An empty certifiable list is a fine answer;
// a short un-certifiable list is a permanent, unrevocable mistake.
//
// The assertions that used to prove person-level dedupe and case-folding went
// with the key they deduped ON. They are not deleted quietly — see the PR body.

function bind(over: Partial<AttendeeCandidate> = {}): AttendeeCandidate {
  return { seriesId: "s1", edition: 1, route: "claim", ...over };
}
const claim = (edition: number, seriesId = "s1") => ({ seriesId, edition });

test("THE DENOMINATOR IS TICKETS SOLD, not bindings", () => {
  // The defect this replaced: counting bindings let a 100-ticket event with 10
  // bindings read as "6 of 10 attendees", at the moment a PERMANENT run is
  // confirmed. The organiser would reasonably believe everyone was covered.
  const claims = Array.from({ length: 100 }, (_, i) => claim(i + 1));
  const bindings = Array.from({ length: 10 }, (_, i) => bind({ edition: i + 1 }));
  const s = splitAttendees({ claims, bindings });
  assert.equal(s.totalClaims, 100, "the honest denominator is every ticket sold");
  assert.equal(s.withoutKey.length, 100, "all 100 must be visible, not just the bound 10");
});

test("nobody is certifiable while no holder identity exists", () => {
  // The honest-empty. A surface that showed a non-zero count here would be
  // offering to sign a permanent certificate over a key nobody holds.
  const s = splitAttendees({ claims: [claim(1), claim(2)], bindings: [bind({ edition: 1 })] });
  assert.deepEqual(s.certifiable, []);
  assert.equal(s.duplicateEditions, 0);
});

test("a stale holder key on a binding cannot resurrect certification", () => {
  // A binding written before #518 may still hold one on disk. It is not a type
  // error at runtime, and it must not become an award.
  const s = splitAttendees({
    claims: [claim(1)],
    bindings: [bind({ holderPubKey: A } as unknown as Partial<AttendeeCandidate>)],
  });
  assert.deepEqual(s.certifiable, []);
  assert.equal(s.withoutKey[0]!.reason, "no-key");
});

test("a ticket with NO binding is a first-class row, not an absence", () => {
  const s = splitAttendees({ claims: [claim(1), claim(2)], bindings: [bind({ edition: 1 })] });
  assert.equal(s.withoutKey.length, 2);
  assert.deepEqual(s.withoutKey.map((w) => w.edition), [1, 2]);
});

test("bound-but-keyless and never-linked are DIFFERENT reasons", () => {
  // Different causes, so different copy — one is an account without a badge
  // identity, the other is a ticket that never met an account at all. Both
  // survive #518 precisely because the organiser's next step differs.
  const s = splitAttendees({
    claims: [claim(1), claim(2)],
    bindings: [bind({ edition: 1 })], // bound, no key
  });
  assert.deepEqual(s.withoutKey.map((w) => w.reason).sort(), ["no-key", "not-linked"]);
  assert.notEqual(uncertifiableLabel("no-key"), uncertifiableLabel("not-linked"));
});

test("a binding for a series that sold nothing cannot inflate the count", () => {
  // Bindings are joined ONTO claims, so a stray binding has nothing to attach
  // to and is ignored rather than inventing an attendee.
  const s = splitAttendees({
    claims: [claim(1)],
    bindings: [bind({ edition: 1 }), bind({ seriesId: "other", edition: 9 })],
  });
  assert.equal(s.totalClaims, 1);
  assert.equal(s.withoutKey.length, 1);
});

test("editions are matched per SERIES — same number, different series, different ticket", () => {
  const s = splitAttendees({
    claims: [claim(1, "s1"), claim(1, "s2")],
    bindings: [bind({ seriesId: "s1", edition: 1 })],
  });
  assert.deepEqual(
    s.withoutKey.map((w) => [w.seriesId, w.reason]),
    [["s1", "no-key"], ["s2", "not-linked"]],
  );
});

test("EVERY claim is accounted for", () => {
  const claims = [claim(1), claim(2), claim(3), claim(4)];
  const s = splitAttendees({
    claims,
    bindings: [bind({ edition: 1 }), bind({ edition: 2 }), bind({ edition: 3 })],
  });
  assert.equal(
    s.certifiable.length + s.withoutKey.length + s.duplicateEditions,
    claims.length,
    "certifiable + un-certifiable + collapsed must equal tickets sold",
  );
});

test("an event with no claims splits cleanly", () => {
  const s = splitAttendees({ claims: [], bindings: [] });
  assert.deepEqual(s.certifiable, []);
  assert.deepEqual(s.withoutKey, []);
  assert.equal(s.totalClaims, 0);
});
