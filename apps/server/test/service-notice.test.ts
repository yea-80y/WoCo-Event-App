/**
 * Service notices are the ONLY messages that reach an address the suppression
 * store says not to mail (#60 item 1). Everything about that is load-bearing,
 * so it is pinned at the send point rather than in the rule in isolation: a
 * refactor can satisfy `mayCrossSuppression` and still mail a complainant.
 *
 * The suppression store writes .data/ relative to process.cwd(), so this suite
 * chdirs into a temp dir BEFORE importing it.
 */

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OutboundEmail } from "../src/lib/email/send.js";
import { mayCrossSuppression } from "../src/lib/email/service-notice-crossing.js";
import type { SuppressSource } from "../src/lib/marketing/suppression-store.js";
import { buildServiceNoticeHtml } from "../src/lib/email/service-notice-email.js";
import { serviceNoticeSubject } from "@woco/shared";

process.env.EMAIL_HASH_SECRET = "test-secret-service-notice";
process.env.PUBLIC_API_BASE = "https://api.example.com";
process.env.MARKETING_POSTAL_ADDRESS = "WoCo Network Ltd, Kemp House, 160 City Road, London";

const ORG = "0xAbCd00000000000000000000000000000000006E";

let send: typeof import("../src/lib/email/marketing-send.js");
let store: typeof import("../src/lib/marketing/suppression-store.js");
let hashEmail: typeof import("../src/lib/event/claim-service.js")["hashEmail"];

before(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "woco-service-notice-test-")));
  send = await import("../src/lib/email/marketing-send.js");
  store = await import("../src/lib/marketing/suppression-store.js");
  ({ hashEmail } = await import("../src/lib/event/claim-service.js"));
});

function recorder() {
  const sent: OutboundEmail[] = [];
  return { sent, deps: { send: async (m: OutboundEmail) => void sent.push(m) } };
}

let n = 0;
const addr = () => `holder${n++}@example.com`;

function batch(overrides: Record<string, unknown> = {}) {
  return {
    organiserAddress: ORG,
    fromDisplayName: "The Fox & Hound",
    fromAddress: "news@mail.woco-net.com",
    subject: "Cancelled: Basement Sessions",
    html: "<html><body><p>We are very sorry.</p></body></html>",
    recipients: [{ email: addr() }],
    ...overrides,
  } as Parameters<typeof send.sendMarketingBatch>[0];
}

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

test("consent marks may be crossed; deliverability marks and `manual` may not", () => {
  for (const s of ["unsub", "unsub_all", "declined"] as SuppressSource[]) {
    assert.equal(mayCrossSuppression([s]), true, `${s} is a consent fact`);
  }
  for (const s of ["bounce", "complaint", "manual"] as SuppressSource[]) {
    assert.equal(mayCrossSuppression([s]), false, `${s} must never be crossed`);
  }
});

test("ANY non-crossable mark blocks, even alongside a crossable one", () => {
  assert.equal(mayCrossSuppression(["unsub", "complaint"] as SuppressSource[]), false);
  assert.equal(mayCrossSuppression(["unsub_all", "bounce"] as SuppressSource[]), false);
  assert.equal(mayCrossSuppression(["declined", "manual"] as SuppressSource[]), false);
});

test("an unclassified source fails CLOSED — a future SuppressSource is not crossable by default", () => {
  assert.equal(mayCrossSuppression(["something_new" as SuppressSource]), false);
});

test("no marks at all is not a crossing", () => {
  assert.equal(mayCrossSuppression([]), false, "nothing to cross means the caller should not report one");
});

// ---------------------------------------------------------------------------
// At the send point
// ---------------------------------------------------------------------------

test("an unsubscribed ticket-holder DOES receive a service notice, and it is counted", async () => {
  const email = addr();
  store.suppressOrg(hashEmail(email), ORG, "unsub", new Date().toISOString());
  const rec = recorder();

  const res = await send.sendMarketingBatch(
    batch({ recipients: [{ email }], serviceNotice: true }),
    rec.deps,
  );

  assert.equal(res.sent, 1, "the whole point: a cancellation reaches someone who unsubscribed");
  assert.equal(res.crossed, 1, "and the crossing is recorded, not folded into `sent`");
  assert.equal(res.suppressed, 0);
  assert.equal(rec.sent.length, 1);
});

test("the SAME address and mark is suppressed for an ordinary broadcast", async () => {
  const email = addr();
  store.suppressOrg(hashEmail(email), ORG, "unsub", new Date().toISOString());
  const rec = recorder();

  const res = await send.sendMarketingBatch(batch({ recipients: [{ email }] }), rec.deps);

  assert.equal(res.sent, 0);
  assert.equal(res.suppressed, 1);
  assert.equal(res.crossed, 0);
  assert.equal(rec.sent.length, 0, "marketing must never cross a suppression");
});

test("a hard bounce is NOT crossed by a service notice — undeliverable, and it burns the shared domain", async () => {
  const email = addr();
  store.suppressGlobal(hashEmail(email), "bounce");
  const rec = recorder();

  const res = await send.sendMarketingBatch(
    batch({ recipients: [{ email }], serviceNotice: true }),
    rec.deps,
  );

  assert.equal(res.sent, 0);
  assert.equal(res.suppressed, 1);
  assert.equal(res.crossed, 0);
  assert.equal(rec.sent.length, 0);
});

test("a complainant is NOT crossed by a service notice", async () => {
  const email = addr();
  store.suppressGlobal(hashEmail(email), "complaint");
  const rec = recorder();
  const res = await send.sendMarketingBatch(
    batch({ recipients: [{ email }], serviceNotice: true }),
    rec.deps,
  );
  assert.equal(res.sent, 0);
  assert.equal(res.suppressed, 1);
});

test("a global unsub_all IS crossed — the checkbox says 'all MARKETING email', and this is not marketing", async () => {
  const email = addr();
  store.suppressGlobal(hashEmail(email), "unsub_all");
  const rec = recorder();
  const res = await send.sendMarketingBatch(
    batch({ recipients: [{ email }], serviceNotice: true }),
    rec.deps,
  );
  assert.equal(res.sent, 1);
  assert.equal(res.crossed, 1);
});

test("an org unsub PLUS a global bounce is refused — the strictest mark wins", async () => {
  const email = addr();
  store.suppressOrg(hashEmail(email), ORG, "unsub", new Date().toISOString());
  store.suppressGlobal(hashEmail(email), "bounce");
  const rec = recorder();
  const res = await send.sendMarketingBatch(
    batch({ recipients: [{ email }], serviceNotice: true }),
    rec.deps,
  );
  assert.equal(res.sent, 0, "one crossable mark must not launder a non-crossable one");
  assert.equal(res.suppressed, 1);
});

test("an unsuppressed recipient is not counted as a crossing", async () => {
  const rec = recorder();
  const res = await send.sendMarketingBatch(batch({ serviceNotice: true }), rec.deps);
  assert.equal(res.sent, 1);
  assert.equal(res.crossed, 0, "crossed must count crossings, not service-notice sends");
});

test("a service notice still carries the unsubscribe link and postal address", async () => {
  const email = addr();
  store.suppressOrg(hashEmail(email), ORG, "unsub", new Date().toISOString());
  const rec = recorder();
  await send.sendMarketingBatch(batch({ recipients: [{ email }], serviceNotice: true }), rec.deps);

  const msg = rec.sent[0]!;
  assert.match(msg.html!, /\/u\//, "unsubscribe link missing");
  assert.ok(msg.html!.includes("Kemp House"), "postal address missing");
  assert.ok(msg.headers?.["List-Unsubscribe"], "RFC 8058 header missing");
});

// ---------------------------------------------------------------------------
// What the platform composes
// ---------------------------------------------------------------------------

test("the subject is composed by the platform from the category, not by the organiser", () => {
  assert.equal(serviceNoticeSubject("cancelled", "Basement Sessions 04"), "Cancelled: Basement Sessions 04");
  assert.equal(serviceNoticeSubject("rescheduled", "Basement Sessions 04"), "New date: Basement Sessions 04");
  assert.equal(serviceNoticeSubject("venue_changed", "Basement Sessions 04"), "New venue: Basement Sessions 04");
});

test("the body carries the platform's disclosure, above the organiser's note", () => {
  const html = buildServiceNoticeHtml({
    type: "cancelled",
    eventTitle: "Basement Sessions 04",
    heading: "Cancelled: Basement Sessions 04",
    note: "Refunds are automatic.",
  });
  assert.match(html, /you hold a ticket for Basement Sessions 04/);
  assert.match(html, /service notice about your booking, not marketing/);
  assert.ok(
    html.indexOf("service notice about your booking") < html.indexOf("Refunds are automatic"),
    "the disclosure must precede the organiser's words, not trail them",
  );
});

test("the organiser's note is escaped — they supply prose, never markup", () => {
  const html = buildServiceNoticeHtml({
    type: "cancelled",
    eventTitle: "T",
    heading: "Cancelled: T",
    note: "<style>.disclosure{display:none}</style>Buy my other tickets",
  });
  assert.ok(!html.includes("<style>"), "raw markup survived — the disclosure could be hidden");
  assert.match(html, /&lt;style&gt;/);
});

test("an event title with markup cannot break the notice either", () => {
  const html = buildServiceNoticeHtml({
    type: "cancelled",
    eventTitle: '<img src=x onerror="alert(1)">',
    heading: "Cancelled: x",
    note: "Sorry.",
  });
  assert.ok(!html.includes("<img"), "raw markup survived from the event title");
});

test("the notice ends at a single final </body>, where the compliance footer inserts", () => {
  const html = buildServiceNoticeHtml({ type: "cancelled", eventTitle: "T", heading: "H", note: "N" });
  assert.ok(html.trimEnd().endsWith("</body></html>"));
  assert.equal(html.match(/<\/body>/g)?.length, 1);
});
