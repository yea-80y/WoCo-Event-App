/**
 * Point-of-collection consent capture — the grant/refusal split and the narrow
 * lift that rescues a buyer from the decline dead-end (#80).
 *
 * Both stores write .data/ relative to process.cwd(), so this suite chdirs into
 * a temp dir BEFORE dynamically importing them — test writes never touch the
 * real .data.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EMAIL_HASH_SECRET = "test-secret-consent";

const ORG = "0xAbCd000000000000000000000000000000000001";
const OTHER_ORG = "0x0000000000000000000000000000000000000002";
const hash = (n: number) => n.toString(16).padStart(64, "0");

/** Timestamps far enough apart that ordering is never ambiguous. */
const T1 = "2026-01-01T00:00:00.000Z";
const T2 = "2026-02-01T00:00:00.000Z";
const T0 = "2025-01-01T00:00:00.000Z";

let capture: typeof import("../src/lib/marketing/consent-capture.js");
let suppression: typeof import("../src/lib/marketing/suppression-store.js");
let consent: typeof import("../src/lib/marketing/consent-store.js");

before(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "woco-consent-test-")));
  capture = await import("../src/lib/marketing/consent-capture.js");
  suppression = await import("../src/lib/marketing/suppression-store.js");
  consent = await import("../src/lib/marketing/consent-store.js");
});

test("a refusal suppresses and writes no consent record", () => {
  const h = hash(1);
  capture.captureCheckoutConsent({
    emailHash: h, organiserAddress: ORG, granted: false, ts: T1, eventId: "evt-a",
  });
  assert.equal(suppression.isSuppressed(h, ORG), true);
  assert.equal(consent.getConsent(h, ORG), null);
});

test("a grant records Art. 7(1) evidence with the wording and version", () => {
  const h = hash(2);
  capture.captureCheckoutConsent({
    emailHash: h, organiserAddress: ORG, granted: true, ts: T1, eventId: "evt-a",
  });
  const record = consent.getConsent(h, ORG);
  assert.ok(record);
  assert.equal(record.source, "checkout");
  assert.equal(record.eventId, "evt-a");
  assert.equal(record.version, 1);
  assert.match(record.notice, /unsubscribe at any time/);
  assert.equal(suppression.isSuppressed(h, ORG), false);
});

/** The bug in #80: decline at event A locked the buyer out of event B's opt-in. */
test("a later genuine opt-in lifts an earlier checkout decline", () => {
  const h = hash(3);
  capture.captureCheckoutConsent({
    emailHash: h, organiserAddress: ORG, granted: false, ts: T1, eventId: "evt-a",
  });
  assert.equal(suppression.isSuppressed(h, ORG), true);

  capture.captureCheckoutConsent({
    emailHash: h, organiserAddress: ORG, granted: true, ts: T2, eventId: "evt-b",
  });
  assert.equal(suppression.isSuppressed(h, ORG), false, "the affirmative choice must take effect");
  assert.ok(consent.getConsent(h, ORG));
  assert.deepEqual(suppression.suppressedSubset(ORG, [h]), []);
});

test("lifting is scoped to the organiser who was consented to", () => {
  const h = hash(4);
  capture.captureCheckoutConsent({ emailHash: h, organiserAddress: ORG, granted: false, ts: T1 });
  capture.captureCheckoutConsent({ emailHash: h, organiserAddress: OTHER_ORG, granted: false, ts: T1 });
  capture.captureCheckoutConsent({ emailHash: h, organiserAddress: ORG, granted: true, ts: T2 });

  assert.equal(suppression.isSuppressed(h, ORG), false);
  assert.equal(suppression.isSuppressed(h, OTHER_ORG), true, "other organisers keep their decline");
});

/**
 * The linchpin. An unsubscribe outranks a later checkbox — resubscribe is a
 * double-opt-in flow (#60), never a side effect of buying a ticket.
 */
test("an unsubscribe is NEVER lifted by a later checkout opt-in", () => {
  const sources = ["unsub", "bounce", "complaint", "manual"] as const;
  for (const [i, source] of sources.entries()) {
    const h = hash(100 + i);
    suppression.suppressOrg(h, ORG, source);
    capture.captureCheckoutConsent({ emailHash: h, organiserAddress: ORG, granted: true, ts: T2 });
    assert.equal(suppression.isSuppressed(h, ORG), true, `${source} must survive a later opt-in`);
  }
});

test("a global suppression is never lifted by a per-organiser opt-in", () => {
  const h = hash(5);
  suppression.suppressGlobal(h, "unsub_all");
  capture.captureCheckoutConsent({ emailHash: h, organiserAddress: ORG, granted: true, ts: T2 });
  assert.equal(suppression.isSuppressed(h, ORG), true);
  assert.equal(suppression.isSuppressed(h, OTHER_ORG), true);
});

test("an older consent cannot undo a newer decline", () => {
  const h = hash(6);
  capture.captureCheckoutConsent({ emailHash: h, organiserAddress: ORG, granted: false, ts: T1 });
  capture.captureCheckoutConsent({ emailHash: h, organiserAddress: ORG, granted: true, ts: T0 });
  assert.equal(suppression.isSuppressed(h, ORG), true);
});

/** After a lift, a fresh refusal is a new decision and must suppress again. */
test("declining again after a lift re-suppresses", () => {
  const h = hash(7);
  capture.captureCheckoutConsent({ emailHash: h, organiserAddress: ORG, granted: false, ts: T1 });
  capture.captureCheckoutConsent({ emailHash: h, organiserAddress: ORG, granted: true, ts: T2 });
  assert.equal(suppression.isSuppressed(h, ORG), false);

  capture.captureCheckoutConsent({ emailHash: h, organiserAddress: ORG, granted: false, ts: T2 });
  assert.equal(suppression.isSuppressed(h, ORG), true, "a new refusal must be enforceable");
});

test("lifting a decline keeps the mark on disk as the audit trail", () => {
  const h = hash(8);
  capture.captureCheckoutConsent({ emailHash: h, organiserAddress: ORG, granted: false, ts: T1 });
  capture.captureCheckoutConsent({ emailHash: h, organiserAddress: ORG, granted: true, ts: T2 });

  const raw = JSON.parse(
    readFileSync(join(process.cwd(), ".data", "marketing-suppression.json"), "utf-8"),
  ) as Record<string, { orgs: Record<string, { source: string; liftedAt?: string; liftedBy?: string }> }>;
  const mark = raw[h]?.orgs[ORG.toLowerCase()];
  assert.ok(mark, "the refusal record must not be deleted");
  assert.equal(mark.source, "declined");
  assert.equal(mark.liftedAt, T2);
  assert.equal(mark.liftedBy, "consent");
});
