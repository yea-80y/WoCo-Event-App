/**
 * The compliance invariants at the SEND point, not in the footer builder.
 *
 * marketing-footer.test.ts proves the block is built correctly; this proves it
 * is actually attached to every outgoing message, that suppression is applied
 * server-side whatever the caller passed, and that the RFC 8058 headers are
 * set. Those are wiring properties — a refactor can satisfy the unit tests and
 * still mail a non-compliant message.
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

process.env.EMAIL_HASH_SECRET = "test-secret-marketing-send";
process.env.PUBLIC_API_BASE = "https://api.example.com";
process.env.MARKETING_POSTAL_ADDRESS = "WoCo Network Ltd, Kemp House, 160 City Road, London";

const ORG = "0xAbCd000000000000000000000000000000000009";

let send: typeof import("../src/lib/email/marketing-send.js");
let store: typeof import("../src/lib/marketing/suppression-store.js");
let hashEmail: typeof import("../src/lib/event/claim-service.js")["hashEmail"];

before(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "woco-marketing-send-test-")));
  send = await import("../src/lib/email/marketing-send.js");
  store = await import("../src/lib/marketing/suppression-store.js");
  ({ hashEmail } = await import("../src/lib/event/claim-service.js"));
});

/** Recorder standing in for the ESP. */
function recorder() {
  const sent: OutboundEmail[] = [];
  return { sent, deps: { send: async (m: OutboundEmail) => void sent.push(m) } };
}

let n = 0;
const addr = () => `person${n++}@example.com`;

function batch(overrides: Partial<Parameters<typeof send.sendMarketingBatch>[0]> = {}) {
  return {
    organiserAddress: ORG,
    fromDisplayName: "The Fox & Hound",
    fromAddress: "news@mail.woco-net.com",
    subject: "Tickets are live",
    html: "<html><body><p>Doors at 8.</p></body></html>",
    recipients: [{ email: addr() }],
    ...overrides,
  };
}

beforeEach(() => {
  process.env.PUBLIC_API_BASE = "https://api.example.com";
  process.env.MARKETING_POSTAL_ADDRESS = "WoCo Network Ltd, Kemp House, 160 City Road, London";
});

test("every message carries the unsubscribe link, provenance and postal address", async () => {
  const r = recorder();
  const result = await send.sendMarketingBatch(batch(), r.deps);

  assert.equal(result.sent, 1);
  assert.equal(r.sent.length, 1);
  const msg = r.sent[0];

  assert.ok(msg.html?.includes("/u/mu1."), "unsubscribe link missing from HTML");
  assert.match(msg.html ?? "", /opted in to updates from/);
  assert.ok(msg.html?.includes("Kemp House"), "postal address missing from HTML");
  // The organiser's own content must survive alongside the footer.
  assert.ok(msg.html?.includes("Doors at 8."));
});

test("a text/plain alternative part is always sent, and it is compliant too", async () => {
  const r = recorder();
  await send.sendMarketingBatch(batch(), r.deps);
  const text = r.sent[0].text ?? "";

  assert.ok(text.length > 0, "no text part");
  assert.ok(!text.includes("<p>"), "text part still contains markup");
  assert.ok(text.includes("Doors at 8."));
  assert.ok(text.includes("/u/mu1."), "unsubscribe link missing from text part");
  assert.ok(text.includes("Kemp House"), "postal address missing from text part");
});

test("RFC 8058 one-click headers are set and match the body link", async () => {
  const r = recorder();
  await send.sendMarketingBatch(batch(), r.deps);
  const h = r.sent[0].headers ?? {};

  assert.equal(h["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  const listUnsub = h["List-Unsubscribe"] ?? "";
  assert.match(listUnsub, /^<https:\/\/api\.example\.com\/u\/mu1\..+>$/);
  // A header pointing somewhere other than the visible link would let one work
  // and the other rot.
  assert.ok(r.sent[0].html?.includes(listUnsub.slice(1, -1)));
});

test("suppressed recipients are dropped server-side regardless of the caller", async () => {
  const blocked = addr();
  const allowed = addr();
  store.suppressOrg(hashEmail(blocked), ORG, "unsub");

  const r = recorder();
  // The caller passes the suppressed address anyway — this is the guarantee.
  const result = await send.sendMarketingBatch(
    batch({ recipients: [{ email: blocked }, { email: allowed }] }),
    r.deps,
  );

  assert.equal(result.suppressed, 1);
  assert.equal(result.sent, 1);
  assert.deepEqual(r.sent.map((m) => m.to).flat(), [allowed]);
});

test("a globally suppressed address is dropped for every organiser", async () => {
  const bounced = addr();
  store.suppressGlobal(hashEmail(bounced), "bounce");

  const r = recorder();
  const result = await send.sendMarketingBatch(
    batch({ organiserAddress: "0x0000000000000000000000000000000000000fff", recipients: [{ email: bounced }] }),
    r.deps,
  );
  assert.equal(result.suppressed, 1);
  assert.equal(r.sent.length, 0);
});

test("a duplicated address in one batch is mailed once", async () => {
  const dupe = addr();
  const r = recorder();
  const result = await send.sendMarketingBatch(
    batch({ recipients: [{ email: dupe }, { email: dupe }, { email: dupe }] }),
    r.deps,
  );
  assert.equal(result.sent, 1);
  assert.equal(r.sent.length, 1);
});

test("each recipient gets their OWN unsubscribe token", async () => {
  const r = recorder();
  await send.sendMarketingBatch(batch({ recipients: [{ email: addr() }, { email: addr() }] }), r.deps);

  const tokens = r.sent.map((m) => /\/u\/(mu1\.[^"<\s]+)/.exec(m.html ?? "")?.[1]);
  assert.equal(tokens.length, 2);
  assert.ok(tokens[0] && tokens[1]);
  // A shared token would unsubscribe the wrong person.
  assert.notEqual(tokens[0], tokens[1]);
});

test("one failed recipient does not stop the rest of the batch", async () => {
  const bad = addr();
  const sent: string[] = [];
  const deps = {
    send: async (m: OutboundEmail) => {
      if (m.to.includes(bad)) throw new Error("ESP rejected");
      sent.push(...m.to);
    },
  };

  const result = await send.sendMarketingBatch(
    batch({ recipients: [{ email: bad }, { email: addr() }, { email: addr() }] }),
    deps,
  );

  assert.equal(result.sent, 2);
  assert.equal(result.failed, 1);
  assert.equal(sent.length, 2);
  assert.match(result.errors[0], /ESP rejected/);
});

test("the display name is escaped in the delivered message, not just the builder", async () => {
  const r = recorder();
  await send.sendMarketingBatch(batch({ fromDisplayName: "<div style=display:none>" }), r.deps);
  const html = r.sent[0].html ?? "";

  assert.ok(!html.includes("<div style=display:none>"), "hostile markup reached the wire");
  assert.ok(html.includes("/u/mu1."), "unsubscribe link still present");
});

test("nothing is sent at all when the send cannot be compliant", async () => {
  const r = recorder();

  process.env.MARKETING_POSTAL_ADDRESS = "";
  await assert.rejects(send.sendMarketingBatch(batch(), r.deps), /MARKETING_POSTAL_ADDRESS/);

  process.env.MARKETING_POSTAL_ADDRESS = "WoCo Network Ltd, London";
  process.env.PUBLIC_API_BASE = "";
  await assert.rejects(send.sendMarketingBatch(batch(), r.deps), /PUBLIC_API_BASE/);

  assert.equal(r.sent.length, 0, "a message escaped despite a failed compliance gate");
});
