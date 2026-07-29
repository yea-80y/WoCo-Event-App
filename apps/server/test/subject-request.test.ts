/**
 * Art. 15 / Art. 17 servicing over the marketing stores (#83).
 *
 * The properties that matter legally, pinned:
 *   - a suppression mark is never erased (Art. 17(3)(b))
 *   - a suppression mark exists BEFORE anything is erased
 *   - an organiser-scoped request does not destroy other controllers' evidence
 *   - after erasure the subject is genuinely unsendable, including through a
 *     re-upload of the organiser's contact list
 *
 * All stores write .data/ relative to process.cwd(), so this suite chdirs into
 * a temp dir BEFORE importing them.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EMAIL_HASH_SECRET = "test-secret-subject-request";

const ORG = "0xAAaa000000000000000000000000000000000001";
const OTHER_ORG = "0xBBbb000000000000000000000000000000000002";
const hash = (n: number) => n.toString(16).padStart(64, "0");
const TS = "2026-06-01T00:00:00.000Z";

let sr: typeof import("../src/lib/marketing/subject-request.js");
let capture: typeof import("../src/lib/marketing/consent-capture.js");
let lists: typeof import("../src/lib/marketing/list-store.js");
let suppression: typeof import("../src/lib/marketing/suppression-store.js");
let consent: typeof import("../src/lib/marketing/consent-store.js");

before(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "woco-subject-request-test-")));
  sr = await import("../src/lib/marketing/subject-request.js");
  capture = await import("../src/lib/marketing/consent-capture.js");
  lists = await import("../src/lib/marketing/list-store.js");
  suppression = await import("../src/lib/marketing/suppression-store.js");
  consent = await import("../src/lib/marketing/consent-store.js");
});

/** Put one subject into all three stores for `org`. */
function seed(h: string, org: string, others: string[] = []): void {
  capture.captureCheckoutConsent({ emailHash: h, organiserAddress: org, granted: true, ts: TS, eventId: "evt-1" });
  lists.putList(org, { swarmRef: "ref", count: others.length + 1, updatedAt: TS, emailHashes: [h, ...others] });
}

// ── Art. 15 ───────────────────────────────────────────────────────────────

test("the report surfaces consent, list membership and marks together", () => {
  const h = hash(1);
  seed(h, ORG, [hash(99)]);
  suppression.suppressOrg(h, OTHER_ORG, "unsub", TS);

  const report = sr.reportSubject(h);
  assert.equal(report.consents.length, 1);
  assert.equal(report.consents[0].org, ORG.toLowerCase());
  assert.deepEqual(report.lists, [ORG.toLowerCase()]);
  assert.ok(report.marks?.orgs[OTHER_ORG.toLowerCase()]);
});

test("an unknown address reports nothing rather than throwing", () => {
  const report = sr.reportSubject(hash(2));
  assert.deepEqual(report.consents, []);
  assert.deepEqual(report.lists, []);
  assert.equal(report.marks, null);
});

test("a scoped report shows only the named controller", () => {
  const h = hash(3);
  seed(h, ORG);
  seed(h, OTHER_ORG);
  const report = sr.reportSubject(h, OTHER_ORG);
  assert.deepEqual(report.consents.map((c) => c.org), [OTHER_ORG.toLowerCase()]);
  assert.deepEqual(report.lists, [OTHER_ORG.toLowerCase()]);
});

// ── Art. 17 ───────────────────────────────────────────────────────────────

test("erasure drops the consent record and the list membership", () => {
  const h = hash(10);
  seed(h, ORG, [hash(98)]);

  const result = sr.eraseSubject(h);
  assert.equal(result.consentsErased, 1);
  assert.deepEqual(result.listsRemovedFrom, [ORG.toLowerCase()]);
  assert.equal(consent.getConsent(h, ORG), null);
  assert.deepEqual(lists.listsContaining(h), []);
});

/** Removing the member must not corrupt the rest of the organiser's list. */
test("erasure leaves the other members of the list intact", () => {
  const h = hash(11);
  const keep = hash(97);
  seed(h, ORG, [keep]);

  sr.eraseSubject(h);
  const entry = lists.getList(ORG);
  assert.deepEqual(entry?.emailHashes, [keep]);
  assert.equal(entry?.count, 1, "the count must follow the index, not drift from it");
});

/**
 * The Art. 17(3)(b) carve-out. Erasing the objection record is what would let
 * the organiser's next CSV re-upload put the person straight back.
 */
test("erasure records a suppression mark and never removes one", () => {
  const h = hash(12);
  seed(h, ORG);
  suppression.suppressOrg(h, OTHER_ORG, "complaint", TS);

  sr.eraseSubject(h);
  assert.equal(suppression.isSuppressed(h, ORG), true);
  assert.equal(suppression.isSuppressed(h, OTHER_ORG), true, "the pre-existing complaint mark survives");
  assert.ok(sr.reportSubject(h).marks?.global, "an unscoped erasure suppresses globally");
});

test("after erasure a re-upload of the same list cannot make the subject sendable", () => {
  const h = hash(13);
  seed(h, ORG);
  sr.eraseSubject(h);

  // The organiser still holds the sealed blob and re-imports it verbatim.
  lists.putList(ORG, { swarmRef: "ref2", count: 1, updatedAt: TS, emailHashes: [h] });
  assert.deepEqual(lists.listsContaining(h), [ORG.toLowerCase()], "the index is back…");
  assert.equal(suppression.isSuppressed(h, ORG), true, "…but the suppression mark still bars the send");
});

test("a scoped erasure does not destroy another controller's lawful-basis evidence", () => {
  const h = hash(14);
  seed(h, ORG);
  seed(h, OTHER_ORG);

  const result = sr.eraseSubject(h, ORG);
  assert.equal(result.suppression, "organiser");
  assert.equal(result.consentsErased, 1);
  assert.equal(consent.getConsent(h, ORG), null);
  assert.ok(consent.getConsent(h, OTHER_ORG), "the untouched controller keeps its Art. 7(1) evidence");
  assert.equal(suppression.isSuppressed(h, ORG), true);
  assert.equal(suppression.isSuppressed(h, OTHER_ORG), false, "and may still lawfully mail them");
  assert.deepEqual(lists.listsContaining(h), [OTHER_ORG.toLowerCase()]);
});

test("erasing an address we hold nothing for still records the objection", () => {
  const h = hash(15);
  const result = sr.eraseSubject(h);
  assert.equal(result.consentsErased, 0);
  assert.deepEqual(result.listsRemovedFrom, []);
  assert.equal(suppression.isSuppressed(h, ORG), true, "a request from a stranger is still an objection");
});

test("erasure is idempotent — running it twice changes nothing further", () => {
  const h = hash(16);
  seed(h, ORG);
  const first = sr.eraseSubject(h);
  const second = sr.eraseSubject(h);
  assert.equal(first.consentsErased, 1);
  assert.equal(second.consentsErased, 0);
  assert.deepEqual(second.listsRemovedFrom, []);
  assert.equal(suppression.isSuppressed(h, ORG), true);
});
