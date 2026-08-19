/**
 * The verification page's reading of an indexer's evidence.
 *
 * This is the reader's side of `SWARM_SOCIAL_PLAN` commitment 4, so what is
 * pinned here is whatever decides whether the page is honest:
 *
 *   - The headline is the RECOUNT, not the served number. A manifest whose
 *     declared count disagrees with its own leaves must show the leaves' number
 *     and say so.
 *   - A challenge count and a community count are DIFFERENT NUMBERS over the
 *     same evidence. `manifest.count` sums every rider's total for the coaster,
 *     so a page headlining it stops meaning "one rider's laps" the moment a
 *     second rider publishes — while looking exactly the same.
 *   - Parsing is all-or-nothing. A leaf whose `total` arrived as a string would
 *     make the recount CONCATENATE.
 *   - Only coasters the shipped catalogue names get this page's authority.
 *     Anyone can mint a subject and publish genuinely signed records against
 *     it; every number on such a page would be true and the coaster invented.
 *
 * Pure throughout — no fetch, no clock. Vocabulary: a credit is the coaster
 * ridden once ever; repeat rides are laps.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { RITA_SUBJECT, type CarriedEvidenceLeaf, type Hex0x } from "@woco/shared";
import {
  buildReport,
  parseEvidence,
  resolveCoaster,
  FEATURED_HOLDERS,
  type Evidence,
  challengeLabel,
} from "../src/lib/credits/verify-report.js";

const OTHER_SUBJECT = `0x${"cc".repeat(32)}` as Hex0x;
const RIDER = "aa".repeat(32);
const RIDER_2 = "bb".repeat(32);
const OWNER = `0x${"11".repeat(20)}` as Hex0x;
const OWNER_2 = `0x${"22".repeat(20)}` as Hex0x;
const DIGEST = `0x${"dd".repeat(32)}` as Hex0x;

const RITA = { name: "Rita", park: "Alton Towers", formerNames: [] as string[] };
const SOURCES = { indexer: "example.test", manifestUrl: "https://example.test/m" };

function leaf(over: Partial<CarriedEvidenceLeaf> = {}): CarriedEvidenceLeaf {
  return { holder: RIDER, feedOwner: OWNER, seq: 1, version: 0, digest: DIGEST, total: 109, ...over };
}

function served(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: "woco.evidence.v1",
    statementFormat: "woco.credit.v1",
    subject: RITA_SUBJECT,
    participants: [OWNER],
    leaves: [leaf()],
    count: 109,
    unreadable: [],
    equivocations: [],
    ageMs: 0,
    ...over,
  };
}

function evidenceOf(over: Record<string, unknown> = {}, subject: Hex0x = RITA_SUBJECT): Evidence {
  const parsed = parseEvidence(served(over), subject);
  assert.ok(parsed, "fixture should parse");
  return parsed;
}

const report = (over: Record<string, unknown> = {}, featuredHolder?: string) =>
  buildReport({ subject: RITA_SUBJECT, coaster: RITA, evidence: evidenceOf(over), sources: SOURCES, featuredHolder });

// ── The headline is the reader's own arithmetic ──────────────────────────────

test("the laps shown are the ones this browser added up", () => {
  const r = report({ count: 109, leaves: [leaf({ total: 100 }), leaf({ holder: RIDER_2, feedOwner: OWNER_2, total: 9 })] });

  assert.equal(r.laps, 109);
  assert.equal(r.reconciliation.recounted, 109);
  assert.equal(r.reconciliation.holds, true);
});

test("a manifest that does not add up to its own declared count is caught, and the leaves win", () => {
  const r = report({ count: 500, leaves: [leaf({ total: 3 })] });

  assert.equal(r.reconciliation.holds, false);
  assert.equal(r.reconciliation.declared, 500);
  assert.equal(r.laps, 3, "the number on screen is the one the published evidence supports");
});

// ── A challenge count is not a community count ───────────────────────────────

test("with no featured rider the headline is everyone's laps, added up", () => {
  const r = report({
    count: 112,
    participants: [OWNER, OWNER_2],
    leaves: [leaf({ total: 109 }), leaf({ holder: RIDER_2, feedOwner: OWNER_2, total: 3 })],
  });

  assert.equal(r.scope, "community");
  assert.equal(r.laps, 112);
  assert.equal(r.featured, null);
  assert.equal(r.riders, 2);
});

test("a featured rider's headline is THEIR laps, not the coaster's total", () => {
  // The divergence this exists for: one rider on 109, a fan on 3, and a page
  // headlining 112 under a challenge banner would be wrong in the way nobody
  // can see.
  const r = report(
    {
      count: 112,
      participants: [OWNER, OWNER_2],
      leaves: [leaf({ total: 109 }), leaf({ holder: RIDER_2, feedOwner: OWNER_2, total: 3 })],
    },
    RIDER,
  );

  assert.equal(r.scope, "rider");
  assert.equal(r.laps, 109);
  assert.equal(r.featured?.holder, RIDER);
  assert.equal(r.communityLaps, 112, "the community number is kept, as the secondary one");
});

test("a featured rider with no record yet falls back to the community count rather than showing nought", () => {
  const r = report({}, RIDER_2);
  assert.equal(r.scope, "community");
  assert.equal(r.featured, null);
  assert.equal(r.laps, 109);
});

test("no rider is featured by default — the registry is honestly empty", () => {
  // It stays empty until a rider's holder key is actually published. A key
  // invented to fill it would attribute a real number to a person on our
  // say-so.
  assert.deepEqual(Object.keys(FEATURED_HOLDERS), []);
  assert.equal(report().scope, "community");
});

// ── Laps, riders, credits: the vocabulary made arithmetic ────────────────────

test("riders are holders with at least one lap on the record", () => {
  // A record carrying a total of zero is schema-valid: someone with a logbook
  // but no lap does not hold the credit and must not be counted as if they did.
  const r = report({
    count: 7,
    participants: [OWNER, OWNER_2],
    leaves: [leaf({ total: 7 }), leaf({ holder: RIDER_2, feedOwner: OWNER_2, total: 0 })],
  });

  assert.equal(r.laps, 7);
  assert.equal(r.riders, 1);
  assert.equal(r.read.contributing, 2, "both were read — one simply has no laps yet");
});

// ── An incomplete read is never presented as a complete one ──────────────────

test("stores that could not be read are carried through as gaps", () => {
  const third = `0x${"33".repeat(20)}`;
  const r = report({ participants: [OWNER, OWNER_2, third], unreadable: [OWNER_2, third] });

  assert.deepEqual(r.read, { declared: 3, contributing: 1, unreadable: 2 });
});

test("equivocating riders are surfaced, not smoothed", () => {
  assert.deepEqual(report({ equivocations: [RIDER] }).equivocations, [RIDER]);
});

// ── Only coasters we can actually name ───────────────────────────────────────

test("the pilot subject resolves to its coaster and park", () => {
  const c = resolveCoaster(RITA_SUBJECT);
  assert.ok(c);
  assert.equal(c.name, "Rita");
  assert.equal(c.park, "Alton Towers");
});

test("a well-formed subject nobody has defined is refused, not rendered", () => {
  // The hostile-link case: real signed records against an invented coaster,
  // shown in this page's typeface with this page's authority.
  assert.equal(resolveCoaster(OTHER_SUBJECT), null);
});

test("a subject that is not a coaster id at all is refused", () => {
  for (const bad of ["", "0x123", RITA_SUBJECT.slice(2), `${RITA_SUBJECT}ff`, "not a hash"]) {
    assert.equal(resolveCoaster(bad), null);
  }
});

test("case and surrounding space in a link do not change which coaster it names", () => {
  const c = resolveCoaster(`  ${RITA_SUBJECT.toUpperCase()}  `);
  assert.equal(c?.subject, RITA_SUBJECT);
});

// ── Parsing refuses what it cannot account for ───────────────────────────────

test("a leaf total that is not a number is refused rather than concatenated", () => {
  // "1" + "9" would recount as "19" and render as a confident, wrong number.
  assert.equal(parseEvidence(served({ leaves: [{ ...leaf(), total: "109" }] }), RITA_SUBJECT), null);
});

test("a leaf without the feed version is refused", () => {
  // Without it the chunk address cannot be derived, so the working stops
  // pointing at anything and "go and read the record yourself" becomes untrue.
  const { version: _dropped, ...noVersion } = leaf();
  assert.equal(parseEvidence(served({ leaves: [noVersion] }), RITA_SUBJECT), null);
});

test("a logbook written before versioning does not sink the whole manifest", () => {
  // -1 is the pre-versioning sentinel, a legal value naming a fixed-identifier
  // entry. Refusing it would throw away every OTHER rider's laps over one whose
  // logbook predates a change they had no part in.
  const parsed = parseEvidence(served({ leaves: [leaf({ version: -1 })] }), RITA_SUBJECT);
  assert.ok(parsed);
  assert.equal(parsed.manifest.leaves[0]!.version, -1);
});

test("a manifest for a different subject is refused", () => {
  assert.equal(parseEvidence(served({ subject: OTHER_SUBJECT }), RITA_SUBJECT), null);
});

test("a manifest for a different statement type is refused", () => {
  assert.equal(parseEvidence(served({ statementFormat: "woco.like.v1" }), RITA_SUBJECT), null);
  assert.equal(parseEvidence(served({ format: "woco.evidence.v2" }), RITA_SUBJECT), null);
});

test("a malformed leaf refuses the WHOLE manifest, not just itself", () => {
  // Dropping the bad leaf and adding up the rest would publish a number over a
  // set the page silently edited.
  for (const bad of [
    { ...leaf(), holder: "not-a-key" },
    { ...leaf(), feedOwner: "0x123" },
    { ...leaf(), digest: "deadbeef" },
    { ...leaf(), seq: -1 },
    { ...leaf(), total: 1.5 },
    { ...leaf(), version: -2 },
    { ...leaf(), version: 1.5 },
    { ...leaf(), holder: undefined },
    null,
  ]) {
    assert.equal(parseEvidence(served({ leaves: [leaf(), bad] }), RITA_SUBJECT), null);
  }
});

test("an empty count is a real answer, not a parse failure", () => {
  const parsed = parseEvidence(served({ count: 0, participants: [], leaves: [] }), RITA_SUBJECT);
  assert.ok(parsed);
  assert.equal(parsed.manifest.leaves.length, 0);
  assert.deepEqual(parsed.unreadable, []);
});

test("qualifiers absent from an older answer read as nothing to report", () => {
  const older = served();
  delete older.unreadable;
  delete older.equivocations;
  delete older.ageMs;
  const parsed = parseEvidence(older, RITA_SUBJECT);
  assert.ok(parsed);
  assert.deepEqual(parsed.unreadable, []);
  assert.deepEqual(parsed.equivocations, []);
  assert.equal(parsed.ageMs, 0);
});

test("a qualifier list that is not a list of identities is refused", () => {
  assert.equal(parseEvidence(served({ unreadable: ["nope"] }), RITA_SUBJECT), null);
  assert.equal(parseEvidence(served({ equivocations: [42] }), RITA_SUBJECT), null);
});

// ---------------------------------------------------------------------------
// Challenge labels — the counter's kicker
// ---------------------------------------------------------------------------

test("challengeLabel names the pilot challenge for the Rita subject", () => {
  assert.equal(challengeLabel(RITA_SUBJECT), "Rita 100");
});

test("challengeLabel is case- and whitespace-insensitive", () => {
  // A hash pasted out of a log is neither.
  assert.equal(challengeLabel(`  ${RITA_SUBJECT.toUpperCase()}  `), "Rita 100");
});

test("challengeLabel returns null rather than inventing a generic kicker", () => {
  // A subject with no challenge renders with NO kicker: there is no honest
  // generic, and a made-up one sitting over a real number is the same borrowed
  // authority the catalogue gate exists to refuse.
  assert.equal(challengeLabel(`0x${"ab".repeat(32)}`), null);
});

test("challengeLabel does not dress the demo coaster up as a challenge", () => {
  assert.equal(
    challengeLabel("0xadd9035a868daff172c831004fe5e8b1b1dd7d5240a907c0830922e8abe6c7e2"),
    null,
  );
});
