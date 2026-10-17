/**
 * A present-but-unreadable suppression or consent file (#882). Before this, any
 * read or parse error loaded as an EMPTY store: every unsubscriber read as
 * subscribed, and the next write replaced the file, evidence and all.
 *
 * Both stores write .data/ relative to process.cwd(), so this suite chdirs into
 * a temp dir BEFORE importing them.
 */
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OutboundEmail } from "../src/lib/email/send.js";

process.env.EMAIL_HASH_SECRET = "test-secret-882";
process.env.PUBLIC_API_BASE = "https://api.example.com";
process.env.MARKETING_POSTAL_ADDRESS = "WoCo Network Ltd, Kemp House, 160 City Road, London";

const dir = mkdtempSync(join(tmpdir(), "woco-882-"));
const originalCwd = process.cwd();
process.chdir(dir);
mkdirSync(join(dir, ".data"));
after(() => {
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

const SUPPRESSION = join(dir, ".data", "marketing-suppression.json");
const CONSENT = join(dir, ".data", "marketing-consent.json");

const suppression = await import("../src/lib/marketing/suppression-store.js");
const consent = await import("../src/lib/marketing/consent-store.js");
const persist = await import("../src/lib/marketing/persist.js");
const sr = await import("../src/lib/marketing/subject-request.js");
const capture = await import("../src/lib/marketing/consent-capture.js");
const { marketingWordingHash } = await import("../src/lib/marketing/checkout-choice.js");
const { marketingWording } = await import("@woco/shared");
/** The hash create-checkout stamps for consent v2 with no questions. */
const YES_HASH = marketingWordingHash(marketingWording("consent", 2, undefined, { name: false, answers: [] })!);
const { sendMarketingBatch } = await import("../src/lib/email/marketing-send.js");
const { notifyRow } = await import("../src/lib/stripe/cancellation-notice.js");
const { alarmGate } = await import("../src/lib/health/alarm-gate.js");
const Unavailable = suppression.SuppressionStoreUnavailableError;

const ORG = "0x" + "aa".repeat(20);
const H = "a".repeat(64);
const H2 = "b".repeat(64);
const MARK = { ts: "2026-06-01T00:00:00.000Z", source: "unsub" };
const RECORD = { ts: "2020-01-01T00:00:00.000Z", source: "checkout" as const, notice: "Yes, send me news", version: 1 };

function reset(): void {
  rmSync(SUPPRESSION, { recursive: true, force: true });
  rmSync(CONSENT, { recursive: true, force: true });
  suppression.__resetSuppressionStoreForTest();
  consent.__resetConsentStoreForTest();
}
beforeEach(reset);

/** What the store told the operator while `fn` ran. */
function alarmsDuring(fn: () => void): string {
  const seen: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void seen.push(args.map(String).join(" "));
  try {
    fn();
  } finally {
    console.error = original;
  }
  return seen.join("\n");
}

// ── Suppression ───────────────────────────────────────────────────────────

for (const [label, contents] of [
  ["a file that is not JSON", `{"${H}": {"orgs": {`],
  ["a JSON array", "[]"],
  ["an entry of the wrong shape", JSON.stringify({ [H]: { global: MARK } })],
  ["a null entry", JSON.stringify({ [H]: null })],
] as const) {
  test(`suppression: ${label} fails closed and is never overwritten`, () => {
    writeFileSync(SUPPRESSION, contents);
    assert.deepEqual(suppression.suppressionStoreHealth(), { ok: false, unreadable: true });

    assert.equal(suppression.isSuppressed(H2, ORG), true);
    assert.equal(suppression.isGloballySuppressed(H2), true);
    assert.deepEqual(suppression.suppressedSubset(ORG, [H, H2]), [H, H2]);
    assert.throws(() => suppression.suppressionSources(H2, ORG), Unavailable);
    assert.throws(() => suppression.suppressedSince(H2, ORG), Unavailable);
    assert.throws(() => suppression.marksFor(H2), Unavailable);

    const before = persist.persistFailureCount();
    assert.equal(suppression.suppressOrg(H2, ORG, "unsub"), false);
    assert.equal(suppression.suppressGlobal(H2, "bounce"), false);
    assert.equal(persist.persistFailureCount(), before + 2, "each refused write counts as a failed one");
    assert.equal(suppression.suppressOrg(H2, ORG, "unsub"), false, "the mark left in memory is not reported kept");
    assert.equal(suppression.suppressGlobal(H2, "bounce"), false);
    assert.ok(persist.persistHealth().failing.some((f) => f.store === "suppression"));
    assert.equal(readFileSync(SUPPRESSION, "utf-8"), contents, "the operator's copy is untouched");
  });
}

test("suppression: a file that cannot be read at all fails closed too, and the alarm names why", () => {
  mkdirSync(SUPPRESSION);
  const alarm = alarmsDuring(() => assert.deepEqual(suppression.suppressionStoreHealth(), { ok: false, unreadable: true }));
  assert.match(alarm, /marketing-suppression\.json exists but could not be read \(EISDIR\)/);
  assert.equal(suppression.isSuppressed(H, ORG), true);
});

test("suppression: a missing file is an empty store that takes writes", () => {
  assert.deepEqual(suppression.suppressionStoreHealth(), { ok: true, unreadable: false });
  assert.equal(suppression.isSuppressed(H, ORG), false);
  assert.deepEqual(suppression.suppressionSources(H, ORG), []);
  assert.equal(suppression.suppressOrg(H, ORG, "unsub"), true);
  assert.equal(suppression.suppressOrg(H, ORG, "unsub"), true, "an existing mark on disk is reported kept");
  assert.equal(suppression.suppressGlobal(H, "unsub_all"), true);
  const onDisk = JSON.parse(readFileSync(SUPPRESSION, "utf-8"));
  assert.equal(onDisk[H].orgs[ORG].source, "unsub");
  assert.equal(onDisk[H].global.source, "unsub_all");
});

test("suppression: a valid file loads", () => {
  writeFileSync(SUPPRESSION, JSON.stringify({ [H]: { orgs: { [ORG]: MARK } } }));
  assert.deepEqual(suppression.suppressionStoreHealth(), { ok: true, unreadable: false });
  assert.equal(suppression.isSuppressed(H, ORG), true);
  assert.equal(suppression.isSuppressed(H2, ORG), false);
  assert.deepEqual(suppression.suppressionSources(H, ORG), ["unsub"]);
});

// ── Suppression unreadable, caller by caller ──────────────────────────────

test("suppression unreadable: marketing and service broadcasts mail nobody", async () => {
  writeFileSync(SUPPRESSION, "{ truncated");
  const sent: OutboundEmail[] = [];
  for (const serviceNotice of [false, true]) {
    await assert.rejects(
      sendMarketingBatch(
        {
          organiserAddress: ORG,
          fromDisplayName: "The Fox & Hound",
          fromAddress: "news@mail.woco-net.com",
          subject: "Tickets are live",
          html: "<p>Doors at 8.</p>",
          recipients: [{ email: "fan@example.com" }],
          ...(serviceNotice ? { serviceNotice: true as const } : {}),
        },
        { send: async (m: OutboundEmail) => void sent.push(m) },
      ),
      Unavailable,
    );
  }
  assert.equal(sent.length, 0);
});

test("suppression unreadable: a refund notice waits for the next pass, never marked undeliverable", async () => {
  writeFileSync(SUPPRESSION, "{ truncated");
  const sent: string[] = [];
  const notices: unknown[] = [];
  await assert.rejects(
    notifyRow(
      "ev-1",
      "Gig",
      { sessionId: "cs_1", paymentIntentId: "pi_1", account: "acct_1", status: "done", charged: 1000, attempts: 0, created: 0, updatedAt: "t" },
      {
        buyerEmail: async () => "buyer@example.com",
        hashEmail: (e) => e,
        suppressionSources: suppression.suppressionSources,
        organiserOf: () => ORG,
        send: async (to) => void sent.push(to),
        setNotice: (_e, _s, n) => void notices.push(n),
        now: () => new Date(),
      },
    ),
    Unavailable,
  );
  assert.deepEqual(sent, []);
  assert.deepEqual(notices, [], "no 'undeliverable' marker: the notice goes once the list is restored");
});

test("suppression unreadable: the consent sweep erases nothing", () => {
  writeFileSync(SUPPRESSION, "{ truncated");
  const file = JSON.stringify({ [ORG]: { [H]: RECORD } });
  writeFileSync(CONSENT, file);
  assert.throws(() => consent.sweepExpiredConsents(undefined, Date.parse("2030-01-01T00:00:00Z")), Unavailable);
  assert.ok(consent.getConsent(H, ORG));
  assert.equal(readFileSync(CONSENT, "utf-8"), file);
});

for (const org of [undefined, ORG]) {
  test(`suppression unreadable: an ${org ? "organiser-scoped" : "unscoped"} erasure erases nothing behind a mark it could not record`, () => {
    writeFileSync(SUPPRESSION, "{ truncated");
    const file = JSON.stringify({ [ORG]: { [H]: RECORD } });
    writeFileSync(CONSENT, file);
    const result = sr.eraseSubject(H, org);
    assert.equal(result.persisted, false);
    assert.equal(result.consentsErased, 0);
    assert.ok(consent.getConsent(H, ORG), "the consent record outlives a mark that did not land");
    assert.equal(readFileSync(CONSENT, "utf-8"), file);
    assert.equal(readFileSync(SUPPRESSION, "utf-8"), "{ truncated");
  });
}

// ── Consent ───────────────────────────────────────────────────────────────

for (const [label, contents] of [
  ["a file that is not JSON", `{"${ORG}": {`],
  ["a JSON array", "[]"],
  ["an organiser entry of the wrong shape", JSON.stringify({ [ORG]: [] })],
  ["a null record", JSON.stringify({ [ORG]: { [H]: null } })],
] as const) {
  test(`consent: ${label} reads as unknown and is never overwritten`, () => {
    writeFileSync(CONSENT, contents);
    assert.equal(consent.consentStoreReadable(), false);
    assert.deepEqual(consent.consentStoreHealth(), { ok: false, unreadable: true });

    assert.throws(() => consent.consentsForEmailHash(H), consent.ConsentStoreUnavailableError);

    const before = persist.persistFailureCount();
    consent.recordConsent(H2, ORG, RECORD);
    assert.equal(persist.persistFailureCount(), before + 1, "a refused write counts as a failed one");
    assert.equal(readFileSync(CONSENT, "utf-8"), contents, "the operator's copy is untouched");
  });
}

test("consent: a file that cannot be read at all is unreadable too, and the alarm names why", () => {
  mkdirSync(CONSENT);
  const alarm = alarmsDuring(() => assert.equal(consent.consentStoreReadable(), false));
  assert.match(alarm, /marketing-consent\.json exists but could not be read \(EISDIR\)/);
});

test("consent: a missing file is an empty store that takes writes", () => {
  assert.equal(consent.consentStoreReadable(), true);
  assert.deepEqual(consent.consentStoreHealth(), { ok: true, unreadable: false });
  consent.recordConsent(H, ORG, RECORD);
  assert.equal(JSON.parse(readFileSync(CONSENT, "utf-8"))[ORG][H].source, "checkout");
});

test("consent: a valid file loads", () => {
  writeFileSync(CONSENT, JSON.stringify({ [ORG]: { [H]: RECORD } }));
  assert.equal(consent.consentStoreReadable(), true);
  assert.deepEqual(consent.getConsent(H, ORG), RECORD);
});

test("consent unreadable: a checkout opt-in keeps an earlier decline - no lift without evidence on disk", () => {
  writeFileSync(CONSENT, "{not json");
  suppression.suppressOrg(H, ORG, "declined", "2026-05-01T00:00:00.000Z");
  const alarms = alarmsDuring(() =>
    capture.captureCheckoutConsent({
      emailHash: H,
      organiserAddress: ORG,
      choice: { mode: "consent", ticked: true, version: 2, surface: "order-form" },
      wordingHash: YES_HASH,
      ts: "2026-06-01T00:00:00.000Z",
    }),
  );
  assert.equal(suppression.isSuppressed(H, ORG), true, "the decline must stand");
  assert.match(alarms, /earlier decline kept/);
  assert.equal(readFileSync(CONSENT, "utf8"), "{not json", "never overwritten");
});

test("consent readable: the same opt-in lifts the decline", () => {
  suppression.suppressOrg(H, ORG, "declined", "2026-05-01T00:00:00.000Z");
  capture.captureCheckoutConsent({
    emailHash: H,
    organiserAddress: ORG,
    choice: { mode: "consent", ticked: true, version: 2, surface: "order-form" },
    wordingHash: YES_HASH,
    ts: "2026-06-01T00:00:00.000Z",
  });
  assert.equal(suppression.isSuppressed(H, ORG), false);
});

test("consent unreadable: an erasure still records the mark first, and is not reported done", () => {
  writeFileSync(CONSENT, "{ truncated");
  const result = sr.eraseSubject(H, ORG);
  assert.equal(result.persisted, false);
  assert.equal(JSON.parse(readFileSync(SUPPRESSION, "utf-8"))[H].orgs[ORG].source, "manual");
  assert.equal(readFileSync(CONSENT, "utf-8"), "{ truncated");
});

// ── Art. 15 access report ─────────────────────────────────────────────────

test("an access report refuses rather than say 'none' from an unreadable store", () => {
  writeFileSync(CONSENT, "{ truncated");
  assert.throws(() => sr.reportSubject(H), consent.ConsentStoreUnavailableError);
  assert.throws(() => sr.reportSubject(H, ORG), consent.ConsentStoreUnavailableError);

  reset();
  writeFileSync(SUPPRESSION, "{ truncated");
  assert.throws(() => sr.reportSubject(H), Unavailable);
});

test("an access report from readable stores is unchanged", () => {
  writeFileSync(CONSENT, JSON.stringify({ [ORG]: { [H]: RECORD } }));
  writeFileSync(SUPPRESSION, JSON.stringify({ [H]: { orgs: { [ORG]: MARK } } }));
  const report = sr.reportSubject(H);
  assert.deepEqual(report.consents, [{ org: ORG, record: RECORD }]);
  assert.deepEqual(report.marks, { orgs: { [ORG]: MARK } });
});

// ── /api/health ───────────────────────────────────────────────────────────

test("/api/health carries both stores, and either one unreadable turns /api/health/alarms red", () => {
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");
  const report = index.slice(index.indexOf("function healthReport()"), index.indexOf('app.get("/api/health"'));
  assert.match(report, /\n\s*marketingSuppression: suppressionStoreHealth\(\),/);
  assert.match(report, /\n\s*marketingConsent: consentStoreHealth\(\),/);

  const gate = () =>
    alarmGate(
      { marketingSuppression: suppression.suppressionStoreHealth(), marketingConsent: consent.consentStoreHealth() },
      undefined,
    );
  assert.equal(gate().status, 200);

  reset();
  writeFileSync(SUPPRESSION, "{ truncated");
  assert.equal(gate().status, 503);
  assert.deepEqual((gate().body as { red: string[] }).red, ["marketingSuppression"]);

  reset();
  writeFileSync(CONSENT, "{ truncated");
  assert.equal(gate().status, 503);
  assert.deepEqual((gate().body as { red: string[] }).red, ["marketingConsent"]);
});
