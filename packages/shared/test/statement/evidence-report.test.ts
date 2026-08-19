/**
 * The published-report envelope (#312).
 *
 * Two families of property, and they fail differently:
 *
 *   TOPIC — silently. A salt that ignored the statement format would put a
 *   coaster's laps and its likes at one address, where each publish overwrites
 *   the other and the feed reads as one number flickering between two counts.
 *   The vectors here are frozen the moment anything is published at them.
 *
 *   PARSING — loudly, if it is strict, and convincingly if it is not. A report
 *   is read exactly when the indexer cannot be asked anything, so a reader that
 *   accepts a shape it does not understand renders a number nobody computed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EVIDENCE_REPORT_FORMAT,
  evidenceReport,
  evidenceReportTopic,
  parseEvidenceReportV1,
  type EvidenceManifestV1,
  type Hex0x,
} from "../../src/index.js";

const SUBJECT = "0x3da9abaddbeee72a4bcb9de6930b557c1310b2d6d8d64e704309274d1af34147" as Hex0x;
const OTHER_SUBJECT = `0x${"cc".repeat(32)}` as Hex0x;
const OWNER = `0x${"11".repeat(20)}` as Hex0x;
const HOLDER = "aa".repeat(32);

/** A boolean leaf, kept deliberately minimal — the leaf parser is injected. */
interface Leaf {
  feedOwner: string;
  value: boolean;
}

function parseLeaf(v: unknown): Leaf | null {
  if (v === null || typeof v !== "object") return null;
  const l = v as Record<string, unknown>;
  if (typeof l.feedOwner !== "string" || typeof l.value !== "boolean") return null;
  return { feedOwner: l.feedOwner, value: l.value };
}

function manifest(over: Partial<EvidenceManifestV1<Leaf>> = {}): EvidenceManifestV1<Leaf> {
  return {
    format: "woco.evidence.v1",
    statementFormat: "woco.like.v1",
    subject: SUBJECT,
    participants: [OWNER],
    leaves: [{ feedOwner: OWNER, value: true }],
    count: 1,
    ...over,
  };
}

function report(): unknown {
  return JSON.parse(
    JSON.stringify(
      evidenceReport({ manifest: manifest(), unreadable: [], equivocations: [], publishedAt: 1_760_000_000_000 }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Topic
// ---------------------------------------------------------------------------

test("the topic is fixed — frozen vector", () => {
  // Freeze on first publication: a report already written lives at this address
  // and nowhere else. Fix the code, never the vector.
  //
  // MOVED ONCE, 2026-08-19, pre-launch: banding folded a uint64BE band into every
  // statement-topic HMAC message, band 0 included, so this address changed with
  // the scheme rather than through an edit to it. Reports written before that are
  // orphaned by design — there were no real ones. This is the last such move.
  assert.equal(
    evidenceReportTopic("woco.like.v1", SUBJECT),
    "woco/evidence-report/v1/f9106f3143e331894b1cc2f2f5aa2ab2d850adaf6b6514483a595142de0a402f",
  );
});

test("two statement formats over ONE subject get different topics", () => {
  // The failure this prevents is silent: one address for both counts means each
  // publish overwrites the other's.
  const like = evidenceReportTopic("woco.like.v1", SUBJECT);
  const credit = evidenceReportTopic("woco.credit.v1", SUBJECT);
  const follow = evidenceReportTopic("woco.follow.v1", SUBJECT);
  assert.notEqual(like, credit);
  assert.notEqual(like, follow);
  assert.notEqual(credit, follow);
});

test("two subjects under one format get different topics", () => {
  assert.notEqual(evidenceReportTopic("woco.like.v1", SUBJECT), evidenceReportTopic("woco.like.v1", OTHER_SUBJECT));
});

test("a subject that is not a lowercase bytes32 is refused, not hashed anyway", () => {
  // Uppercase hex would derive a DIFFERENT address for the same subject, so
  // accepting it would split one subject's reports across two feeds.
  assert.throws(() => evidenceReportTopic("woco.like.v1", SUBJECT.toUpperCase() as Hex0x));
  assert.throws(() => evidenceReportTopic("woco.like.v1", "0xdeadbeef" as Hex0x));
});

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

test("a built report survives JSON and parses back identically", () => {
  const parsed = parseEvidenceReportV1(report(), parseLeaf);
  assert.ok(parsed);
  assert.equal(parsed.format, EVIDENCE_REPORT_FORMAT);
  assert.equal(parsed.manifest.count, 1);
  assert.equal(parsed.manifest.subject, SUBJECT);
  assert.deepEqual(parsed.manifest.leaves, [{ feedOwner: OWNER, value: true }]);
  assert.equal(parsed.publishedAt, 1_760_000_000_000);
});

test("a report with nothing to report is a real answer, not a parse failure", () => {
  // Distinct from a refusal: an indexer that read every participant and found
  // no statements has computed a count, and it is 0.
  const empty = JSON.parse(
    JSON.stringify(
      evidenceReport({
        manifest: manifest({ participants: [], leaves: [], count: 0 }),
        unreadable: [],
        equivocations: [],
        publishedAt: 1,
      }),
    ),
  );
  const parsed = parseEvidenceReportV1(empty, parseLeaf);
  assert.ok(parsed);
  assert.equal(parsed.manifest.count, 0);
});

test("the qualifiers round-trip", () => {
  // They travel with the report because a reader who has to ask twice whether a
  // count is complete will publish a floor as a total.
  const withGaps = JSON.parse(
    JSON.stringify(
      evidenceReport({ manifest: manifest(), unreadable: [OWNER], equivocations: [HOLDER], publishedAt: 5 }),
    ),
  );
  const parsed = parseEvidenceReportV1(withGaps, parseLeaf);
  assert.ok(parsed);
  assert.deepEqual(parsed.unreadable, [OWNER]);
  assert.deepEqual(parsed.equivocations, [HOLDER]);
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test("an extra key at the top level refuses the whole report", () => {
  // Closed by key set, which is also what makes the paging marker
  // unrepresentable — a report is not a place to smuggle a field.
  const o = report() as Record<string, unknown>;
  assert.equal(parseEvidenceReportV1({ ...o, signature: "0xdead" }, parseLeaf), null);
  assert.equal(parseEvidenceReportV1({ ...o, _woco_mc: true }, parseLeaf), null);
});

test("an extra key inside the manifest refuses the whole report", () => {
  const o = report() as Record<string, unknown>;
  const m = { ...(o.manifest as Record<string, unknown>), ageMs: 12 };
  // Named ageMs on purpose: it is the field someone WILL try to move inside,
  // and doing so would break the byte-identity the manifest promises.
  assert.equal(parseEvidenceReportV1({ ...o, manifest: m }, parseLeaf), null);
});

test("a missing key refuses the report", () => {
  for (const drop of ["format", "manifest", "unreadable", "equivocations", "publishedAt"]) {
    const o = report() as Record<string, unknown>;
    delete o[drop];
    assert.equal(parseEvidenceReportV1(o, parseLeaf), null, `dropped ${drop}`);
  }
});

test("one unparseable leaf refuses the whole report, not just itself", () => {
  // All-or-nothing: a recount over the leaves that happened to parse is a
  // number with no stated meaning, and it would look exactly like a good one.
  const o = report() as Record<string, unknown>;
  const m = { ...(o.manifest as Record<string, unknown>), leaves: [{ feedOwner: OWNER, value: "true" }] };
  assert.equal(parseEvidenceReportV1({ ...o, manifest: m }, parseLeaf), null);
});

test("a wrong format id refuses the report", () => {
  const o = report() as Record<string, unknown>;
  assert.equal(parseEvidenceReportV1({ ...o, format: "woco.evidence.v1" }, parseLeaf), null);
  const m = { ...(o.manifest as Record<string, unknown>), format: "woco.evidence-report.v1" };
  assert.equal(parseEvidenceReportV1({ ...o, manifest: m }, parseLeaf), null);
});

test("a publishedAt that is not a whole non-negative number refuses the report", () => {
  const o = report() as Record<string, unknown>;
  for (const bad of ["1760000000000", -1, 1.5, null, Number.MAX_SAFE_INTEGER + 2]) {
    assert.equal(parseEvidenceReportV1({ ...o, publishedAt: bad }, parseLeaf), null, `publishedAt ${bad}`);
  }
});

test("qualifier lists must hold the identifiers they claim to", () => {
  const o = report() as Record<string, unknown>;
  // An unreadable entry is a FEED OWNER address; an equivocation names a HOLDER
  // key. Swapping them would render one identity under the other's heading.
  assert.equal(parseEvidenceReportV1({ ...o, unreadable: [HOLDER] }, parseLeaf), null);
  assert.equal(parseEvidenceReportV1({ ...o, equivocations: [OWNER] }, parseLeaf), null);
  assert.equal(parseEvidenceReportV1({ ...o, unreadable: OWNER }, parseLeaf), null);
});

test("a manifest subject that is not a lowercase bytes32 refuses the report", () => {
  const o = report() as Record<string, unknown>;
  const m = { ...(o.manifest as Record<string, unknown>), subject: SUBJECT.toUpperCase() };
  assert.equal(parseEvidenceReportV1({ ...o, manifest: m }, parseLeaf), null);
});

test("a count that is not a whole number refuses the report", () => {
  const o = report() as Record<string, unknown>;
  for (const bad of ["1", -1, 1.5]) {
    const m = { ...(o.manifest as Record<string, unknown>), count: bad };
    assert.equal(parseEvidenceReportV1({ ...o, manifest: m }, parseLeaf), null, `count ${bad}`);
  }
});

test("a report that is not an object at all is refused", () => {
  for (const bad of [null, "{}", 42, [], undefined]) {
    assert.equal(parseEvidenceReportV1(bad, parseLeaf), null, `${String(bad)}`);
  }
});
