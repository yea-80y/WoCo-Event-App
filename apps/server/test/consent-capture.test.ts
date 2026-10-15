/**
 * Point-of-collection consent capture — the grant/refusal split and the narrow
 * lift that rescues a buyer from the decline dead-end (#80).
 *
 * Both stores write .data/ relative to process.cwd(), so this suite chdirs into
 * a temp dir BEFORE dynamically importing them — test writes never touch the
 * real .data.
 *
 * MUTATION (2026-10-15, each went red, then restored): log a wording mismatch
 * without counting it, drop the no-organiser guard, or leave the health line out
 * of index.ts, and "counted on /api/health" goes red; gate fulfilment's capture
 * on the organiser address again and fulfilment's "feed unreadable" goes red.
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

/** Consent mode's "Email me" box, as the order form reports it. */
const CONSENT_YES = { mode: "consent", ticked: true, version: 2, surface: "order-form" } as const;
const CONSENT_NO = { mode: "consent", ticked: false, version: 2, surface: "order-form" } as const;
/** Own-events mode: "Don't email me" left alone is the soft opt-in, ticked is a refusal. */
const SOFT_YES = { mode: "own-events", ticked: false, version: 2, surface: "pay-panel" } as const;
const SOFT_NO = { mode: "own-events", ticked: true, version: 2, surface: "embed" } as const;

/** Timestamps far enough apart that ordering is never ambiguous. */
const T1 = "2026-01-01T00:00:00.000Z";
const T2 = "2026-02-01T00:00:00.000Z";
const T0 = "2025-01-01T00:00:00.000Z";

let capture: typeof import("../src/lib/marketing/consent-capture.js");
let choiceMod: typeof import("../src/lib/marketing/checkout-choice.js");
const { listKeeps, marketingWording } = await import("@woco/shared");
type CaptureInput = Parameters<typeof capture.captureCheckoutConsent>[0];
/** The hash create-checkout carries for the wording it matched: the event's questions as given, none by default. */
function hashFor(i: CaptureInput): string | undefined {
  const w = marketingWording(i.choice.mode, i.choice.version, i.organiserName, listKeeps(i.orderFields));
  return w ? choiceMod.marketingWordingHash(w) : undefined;
}
/** A paid session as create-checkout left it: its hash travels with the choice. */
const cap = (i: CaptureInput) => capture.captureCheckoutConsent("wordingHash" in i ? i : { ...i, wordingHash: hashFor(i) });
let suppression: typeof import("../src/lib/marketing/suppression-store.js");
let consent: typeof import("../src/lib/marketing/consent-store.js");

before(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "woco-consent-test-")));
  capture = await import("../src/lib/marketing/consent-capture.js");
  choiceMod = await import("../src/lib/marketing/checkout-choice.js");
  suppression = await import("../src/lib/marketing/suppression-store.js");
  consent = await import("../src/lib/marketing/consent-store.js");
});

test("a refusal suppresses and writes no consent record", () => {
  const h = hash(1);
  cap({
    emailHash: h, organiserAddress: ORG, choice: CONSENT_NO, ts: T1, eventId: "evt-a",
  });
  assert.equal(suppression.isSuppressed(h, ORG), true);
  assert.equal(consent.getConsent(h, ORG), null);
});

test("a grant records Art. 7(1) evidence with the wording and version, on the consent basis", () => {
  const h = hash(2);
  cap({
    emailHash: h, organiserAddress: ORG, choice: CONSENT_YES, ts: T1, eventId: "evt-a",
  });
  const record = consent.getConsent(h, ORG);
  assert.ok(record);
  assert.equal(record.source, "checkout");
  assert.equal(record.eventId, "evt-a");
  assert.equal(record.version, 2);
  // Consent mode stores today's "Email me" wording - never the soft opt-in's.
  assert.equal(record.notice, "Email me about future events from this organiser. We'll keep your email for this. You can unsubscribe at any time.");
  assert.equal(record.control, undefined);
  assert.equal(record.basis, "consent");
  assert.equal(record.surface, "order-form");
  assert.equal(suppression.isSuppressed(h, ORG), false);
});

/** The bug in #80: decline at event A locked the buyer out of event B's opt-in. */
test("a later genuine opt-in lifts an earlier checkout decline", () => {
  const h = hash(3);
  cap({
    emailHash: h, organiserAddress: ORG, choice: CONSENT_NO, ts: T1, eventId: "evt-a",
  });
  assert.equal(suppression.isSuppressed(h, ORG), true);

  cap({
    emailHash: h, organiserAddress: ORG, choice: CONSENT_YES, ts: T2, eventId: "evt-b",
  });
  assert.equal(suppression.isSuppressed(h, ORG), false, "the affirmative choice must take effect");
  assert.ok(consent.getConsent(h, ORG));
  assert.deepEqual(suppression.suppressedSubset(ORG, [h]), []);
});

test("lifting is scoped to the organiser who was consented to", () => {
  const h = hash(4);
  cap({ emailHash: h, organiserAddress: ORG, choice: CONSENT_NO, ts: T1 });
  cap({ emailHash: h, organiserAddress: OTHER_ORG, choice: CONSENT_NO, ts: T1 });
  cap({ emailHash: h, organiserAddress: ORG, choice: CONSENT_YES, ts: T2 });

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
    cap({ emailHash: h, organiserAddress: ORG, choice: CONSENT_YES, ts: T2 });
    assert.equal(suppression.isSuppressed(h, ORG), true, `${source} must survive a later opt-in`);
  }
});

test("a global suppression is never lifted by a per-organiser opt-in", () => {
  const h = hash(5);
  suppression.suppressGlobal(h, "unsub_all");
  cap({ emailHash: h, organiserAddress: ORG, choice: CONSENT_YES, ts: T2 });
  assert.equal(suppression.isSuppressed(h, ORG), true);
  assert.equal(suppression.isSuppressed(h, OTHER_ORG), true);
});

test("an older consent cannot undo a newer decline", () => {
  const h = hash(6);
  cap({ emailHash: h, organiserAddress: ORG, choice: CONSENT_NO, ts: T1 });
  cap({ emailHash: h, organiserAddress: ORG, choice: CONSENT_YES, ts: T0 });
  assert.equal(suppression.isSuppressed(h, ORG), true);
});

/** After a lift, a fresh refusal is a new decision and must suppress again. */
test("declining again after a lift re-suppresses", () => {
  const h = hash(7);
  cap({ emailHash: h, organiserAddress: ORG, choice: CONSENT_NO, ts: T1 });
  cap({ emailHash: h, organiserAddress: ORG, choice: CONSENT_YES, ts: T2 });
  assert.equal(suppression.isSuppressed(h, ORG), false);

  cap({ emailHash: h, organiserAddress: ORG, choice: CONSENT_NO, ts: T2 });
  assert.equal(suppression.isSuppressed(h, ORG), true, "a new refusal must be enforceable");
});

test("lifting a decline keeps the mark on disk as the audit trail", () => {
  const h = hash(8);
  cap({ emailHash: h, organiserAddress: ORG, choice: CONSENT_NO, ts: T1 });
  cap({ emailHash: h, organiserAddress: ORG, choice: CONSENT_YES, ts: T2 });

  const raw = JSON.parse(
    readFileSync(join(process.cwd(), ".data", "marketing-suppression.json"), "utf-8"),
  ) as Record<string, { orgs: Record<string, { source: string; liftedAt?: string; liftedBy?: string }> }>;
  const mark = raw[h]?.orgs[ORG.toLowerCase()];
  assert.ok(mark, "the refusal record must not be deleted");
  assert.equal(mark.source, "declined");
  assert.equal(mark.liftedAt, T2);
  assert.equal(mark.liftedBy, "consent");
});

// ── The soft opt-in (own-events mode, 2026-10-14) ───────────────────────────

test("own-events, box left alone: a soft-opt-in record holding the sentence and the box the buyer saw", () => {
  const h = hash(200);
  cap({
    emailHash: h, organiserAddress: ORG, choice: SOFT_YES, organiserName: "Punk Pub Ltd", ts: T1, eventId: "evt-a",
  });
  const record = consent.getConsent(h, ORG);
  assert.ok(record);
  assert.equal(record.basis, "soft-opt-in");
  // Kept first-party: pacing and the attendee import read source "checkout".
  assert.equal(record.source, "checkout");
  assert.equal(record.notice, "We'll email you about similar events from Punk Pub Ltd, and keep your email for this. You can unsubscribe from any email.");
  assert.equal(record.control, "Don't email me about similar events");
  assert.equal(record.version, 2);
  assert.equal(record.surface, "pay-panel");
  assert.equal(record.eventId, "evt-a");
  assert.equal(suppression.isSuppressed(h, ORG), false);
});

test("own-events, 'Don't email me' ticked: a declined suppression and no record, as consent mode's no", () => {
  const h = hash(201);
  cap({ emailHash: h, organiserAddress: ORG, choice: SOFT_NO, organiserName: "Punk Pub Ltd", ts: T1 });
  assert.equal(suppression.isSuppressed(h, ORG), true);
  assert.deepEqual(suppression.suppressionSources(h, ORG), ["declined"]);
  assert.equal(consent.getConsent(h, ORG), null);
});

test("a soft opt-in never lifts an earlier decline - leaving a box alone is not an affirmative act", () => {
  const h = hash(202);
  cap({ emailHash: h, organiserAddress: ORG, choice: CONSENT_NO, ts: T1 });
  cap({ emailHash: h, organiserAddress: ORG, choice: SOFT_YES, organiserName: "P", ts: T2 });
  assert.equal(suppression.isSuppressed(h, ORG), true, "the decline still stands");
  assert.deepEqual(suppression.suppressedSubset(ORG, [h]), [h]);
});

test("a soft opt-in never lifts an unsubscribe, a bounce, a complaint, a manual mark or a global one", () => {
  const sources = ["unsub", "bounce", "complaint", "manual"] as const;
  for (const [i, source] of sources.entries()) {
    const h = hash(210 + i);
    suppression.suppressOrg(h, ORG, source);
    cap({ emailHash: h, organiserAddress: ORG, choice: SOFT_YES, organiserName: "P", ts: T2 });
    assert.equal(suppression.isSuppressed(h, ORG), true, `${source} must survive a soft opt-in`);
  }
  const g = hash(219);
  suppression.suppressGlobal(g, "unsub_all");
  cap({ emailHash: g, organiserAddress: ORG, choice: SOFT_YES, organiserName: "P", ts: T2 });
  assert.equal(suppression.isSuppressed(g, ORG), true);
});

test("a soft opt-in never overwrites a consent record: the stronger basis is kept", () => {
  const h = hash(220);
  cap({ emailHash: h, organiserAddress: ORG, choice: CONSENT_YES, ts: T1, eventId: "evt-a" });
  cap({ emailHash: h, organiserAddress: ORG, choice: SOFT_YES, organiserName: "P", ts: T2, eventId: "evt-b" });
  const record = consent.getConsent(h, ORG);
  assert.equal(record?.basis, "consent");
  assert.equal(record?.eventId, "evt-a");
  assert.equal(record?.ts, T1);
  // A record from before the basis field existed was consent, and is kept the same way.
  const legacy = hash(221);
  consent.recordConsent(legacy, ORG, { ts: T0, source: "checkout", notice: "old wording", version: 1 });
  cap({ emailHash: legacy, organiserAddress: ORG, choice: SOFT_YES, organiserName: "P", ts: T2 });
  assert.equal(consent.getConsent(legacy, ORG)?.notice, "old wording");
  assert.equal(consent.basisFor(legacy, ORG), "consent");
});

test("consent upgrades a soft opt-in, and a newer soft opt-in replaces an older one", () => {
  const h = hash(222);
  cap({ emailHash: h, organiserAddress: ORG, choice: SOFT_YES, organiserName: "P", ts: T0, eventId: "evt-a" });
  cap({ emailHash: h, organiserAddress: ORG, choice: SOFT_YES, organiserName: "P", ts: T1, eventId: "evt-b" });
  assert.equal(consent.getConsent(h, ORG)?.eventId, "evt-b");
  cap({ emailHash: h, organiserAddress: ORG, choice: CONSENT_YES, ts: T2, eventId: "evt-c" });
  assert.equal(consent.basisFor(h, ORG), "consent");
});

test("the basis is the one the buyer was shown, whatever the organiser's mode is later", () => {
  // Rule 6: no re-permissioning. The record carries its own basis; nothing here
  // reads the organiser's notice, so a switch of mode cannot rewrite it.
  const src = readFileSync(new URL("../src/lib/marketing/consent-capture.ts", import.meta.url), "utf-8");
  assert.doesNotMatch(src, /notice-gate|organiserNotice|noticeMarketingMode/);
});

test("the stored wording is the server's, rebuilt from the event's questions - never the page's text", () => {
  const fields = [
    { id: "n", type: "text" as const, label: "Full name", required: false },
    { id: "t", type: "text" as const, label: "Town", required: false },
    { id: "a", type: "text" as const, label: "Allergies", required: false, health: true },
  ];
  const h = hash(230);
  cap({ emailHash: h, organiserAddress: ORG, choice: CONSENT_YES, orderFields: fields, ts: T1 });
  assert.equal(
    consent.getConsent(h, ORG)?.notice,
    "Email me about future events from this organiser. We'll keep your email, name and your answers to: Town for this. You can unsubscribe at any time.",
  );
  const g = hash(231);
  cap({ emailHash: g, organiserAddress: ORG, choice: SOFT_YES, organiserName: "Punk Pub Ltd", orderFields: fields, ts: T1 });
  assert.equal(
    consent.getConsent(g, ORG)?.notice,
    "We'll email you about similar events from Punk Pub Ltd, and keep your email, name and your answers to: Town for this. You can unsubscribe from any email.",
  );

  const never = hash(232);
  cap({ emailHash: never, organiserAddress: ORG, choice: { ...SOFT_YES, version: 99 } as unknown as typeof SOFT_YES, organiserName: "P", ts: T1 });
  assert.equal(consent.getConsent(never, ORG), null, "a wording never shown records nothing");
  const src = readFileSync(new URL("../src/lib/marketing/consent-capture.ts", import.meta.url), "utf-8");
  assert.match(src, /marketingWording\(choice\.mode, choice\.version, organiserName, listKeeps\(orderFields\)\)/);
});

test("a yes is recorded only if the rebuilt wording hashes to what checkout matched - else nothing, and the buyer is not mailed", () => {
  const atCheckout = [{ id: "t", type: "text" as const, label: "Town", required: false }];
  const atPayment = [...atCheckout, { id: "p", type: "text" as const, label: "Postcode", required: false }];
  const checkoutHash = hashFor({ emailHash: "", organiserAddress: ORG, choice: CONSENT_YES, orderFields: atCheckout, ts: T1 });
  // The organiser added a question between checkout and payment.
  const h = hash(240);
  cap({ emailHash: h, organiserAddress: ORG, choice: CONSENT_YES, orderFields: atPayment, wordingHash: checkoutHash, ts: T1 });
  assert.equal(consent.getConsent(h, ORG), null);
  // No hash at all: a session from before the wording named what is kept.
  const g = hash(241);
  cap({ emailHash: g, organiserAddress: ORG, choice: SOFT_YES, organiserName: "P", wordingHash: undefined, ts: T1 });
  assert.equal(consent.getConsent(g, ORG), null);
  // The organiser renamed themselves since checkout: the own-events sentence differs.
  const k = hash(242);
  const named = hashFor({ emailHash: "", organiserAddress: ORG, choice: SOFT_YES, organiserName: "Old Name", ts: T1 });
  cap({ emailHash: k, organiserAddress: ORG, choice: SOFT_YES, organiserName: "New Name", wordingHash: named, ts: T1 });
  assert.equal(consent.getConsent(k, ORG), null);
  // A refusal needs no wording: it is enforced whatever the hash.
  const r = hash(243);
  cap({ emailHash: r, organiserAddress: ORG, choice: CONSENT_NO, wordingHash: "00", ts: T1 });
  assert.equal(suppression.isSuppressed(r, ORG), true);
  // The same questions, the same hash: recorded.
  const ok = hash(244);
  cap({ emailHash: ok, organiserAddress: ORG, choice: CONSENT_YES, orderFields: atCheckout, wordingHash: checkoutHash, ts: T1 });
  assert.ok(consent.getConsent(ok, ORG));
});

test("a yes fulfilment cannot record is counted on /api/health, never silently lost", async () => {
  const before = capture.droppedOptInsHealth().sinceBoot;
  const atCheckout = [{ id: "t", type: "text" as const, label: "Town", required: false }];
  const atPayment = [...atCheckout, { id: "p", type: "text" as const, label: "Postcode", required: false }];
  const checkoutHash = hashFor({ emailHash: "", organiserAddress: ORG, choice: CONSENT_YES, orderFields: atCheckout, ts: T1 });
  cap({ emailHash: hash(250), organiserAddress: ORG, choice: CONSENT_YES, orderFields: atPayment, wordingHash: checkoutHash, ts: T1 });
  const after = capture.droppedOptInsHealth();
  assert.equal(after.sinceBoot, before + 1, "a wording mismatch counts");
  assert.ok(after.lastAt && Number.isFinite(Date.parse(after.lastAt)));
  // The event could not be read at fulfilment: no organiser to record for.
  cap({ emailHash: hash(251), organiserAddress: "", choice: SOFT_YES, organiserName: "P", ts: T1 });
  assert.equal(capture.droppedOptInsHealth().sinceBoot, before + 2, "an unreadable event counts");
  assert.equal(suppression.isSuppressed(hash(251), ""), false);
  // Neither a recorded yes nor any no counts.
  cap({ emailHash: hash(252), organiserAddress: ORG, choice: CONSENT_YES, orderFields: atCheckout, wordingHash: checkoutHash, ts: T1 });
  cap({ emailHash: hash(253), organiserAddress: ORG, choice: CONSENT_NO, ts: T1 });
  cap({ emailHash: hash(254), organiserAddress: "", choice: CONSENT_NO, ts: T1 });
  assert.equal(capture.droppedOptInsHealth().sinceBoot, before + 2);
  assert.equal(suppression.isSuppressed(hash(254), ""), false, "nothing is written under no organiser");

  // Reported beside the consent store, and never pages: no `ok` in it.
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");
  assert.match(index, /\n\s*marketingConsent: consentStoreHealth\(\),\n(\s*\/\/.*\n)*\s*marketingOptInsDropped: droppedOptInsHealth\(\),/);
  const { alarmGate } = await import("../src/lib/health/alarm-gate.js");
  assert.equal(alarmGate({ marketingOptInsDropped: capture.droppedOptInsHealth() }, undefined).status, 200);
});
