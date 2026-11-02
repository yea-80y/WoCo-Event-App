/**
 * #983 step 4: the organiser hears that a ticket for their event bounced.
 *
 * MUTATION: drop the 6-hour claim and "one notice per event" goes red; put the buyer's
 * address in the email and "names nobody" goes red; give the notice a session in its
 * context and "never reads as an undelivered ticket" goes red; let a marketing or
 * session-less row reach the listener and "only ticket rows" goes red.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmailFailure } from "../src/lib/email/failure-ledger.js";
import { buildUndeliveredNotice, createUndeliveredNotifier, NOTICE_EVERY_MS, type NoticeDeps } from "../src/lib/ticket-hold/organiser-notice.js";

process.chdir(mkdtempSync(join(tmpdir(), "woco-983-notice-")));
let ledger: typeof import("../src/lib/email/failure-ledger.js");
before(async () => {
  ledger = await import("../src/lib/email/failure-ledger.js");
  ledger._resetForTest();
});

const EVENT = "e0000000-0000-4000-8000-000000000983";
const row = (context: Record<string, string>): EmailFailure => ({
  id: "r", ts: "2026-10-24T12:00:00Z", kind: "transactional",
  recipients: [{ hash: "h", address: "typo@exampl.com" }], subject: "Your ticket", provider: "ses",
  error: "550", attempts: 1, retryable: false, context,
});
const flush = () => new Promise((r) => setTimeout(r, 0));

function rig(o: { address?: string | null; sendThrows?: boolean } = {}) {
  let now = Date.parse("2026-10-24T12:00:00Z");
  const sent: Array<{ msg: { to: string; subject: string; html: string; text: string }; context: Record<string, string> }> = [];
  const asked: Array<[string, string | undefined]> = [];
  const deps: NoticeDeps = {
    organiserEmail: async (eventId, siteId) => {
      asked.push([eventId, siteId]);
      return o.address === undefined ? "organiser@stripe.example" : o.address;
    },
    getEventTitle: async () => "Warehouse Party",
    send: async (msg, context) => {
      if (o.sendThrows) throw new Error("SES down for buyer typo@exampl.com");
      sent.push({ msg, context });
    },
    dashboardUrl: (id) => `https://app.example/#/event/${id}/dashboard`,
    now: () => now,
  };
  return { notify: createUndeliveredNotifier(deps), sent, asked, tick: (ms: number) => (now += ms) };
}

test("a bounced ticket tells the organiser, with or without a site", async () => {
  const r = rig();
  r.notify(row({ stripeSessionId: "cs_live_n1aaaaaaaaaa", eventId: EVENT, siteId: "site-1" }));
  r.notify(row({ stripeSessionId: "cs_live_n1baaaaaaaaa", eventId: "e0000000-0000-4000-8000-000000000985" }));
  await flush();
  assert.equal(r.sent.length, 2, "an event sold from the app is told too");
  assert.deepEqual(r.asked, [[EVENT, "site-1"], ["e0000000-0000-4000-8000-000000000985", undefined]], "the site is only a fallback, passed as given");
  assert.equal(r.sent[0]!.msg.to, "organiser@stripe.example");
  assert.equal(r.sent[0]!.msg.subject, "A ticket for Warehouse Party didn't arrive");
  assert.ok(r.sent[0]!.msg.html.includes(`https://app.example/#/event/${EVENT}/dashboard`));
});

test("the notice names nobody, and never reads as an undelivered ticket itself", async () => {
  const r = rig();
  r.notify(row({ stripeSessionId: "cs_live_n2aaaaaaaaaa", eventId: EVENT, siteId: "site-1" }));
  await flush();
  const { msg, context } = r.sent[0]!;
  for (const part of [msg.subject, msg.html, msg.text]) {
    assert.ok(!part.includes("typo@exampl.com") && !part.includes("cs_live_"), "no buyer, no order id");
  }
  assert.deepEqual(context, { kind: "undelivered-notice", eventId: EVENT });
});

test("one notice per event every 6 hours, however many tickets bounce; each event its own", async () => {
  const r = rig();
  for (let i = 0; i < 5; i++) r.notify(row({ stripeSessionId: `cs_live_burst${i}aaaaaaaa`, eventId: EVENT, siteId: "site-1" }));
  r.notify(row({ stripeSessionId: "cs_live_otheraaaaaaaa", eventId: "e0000000-0000-4000-8000-000000000984", siteId: "site-1" }));
  await flush();
  assert.equal(r.sent.length, 2);
  r.tick(NOTICE_EVERY_MS - 1);
  r.notify(row({ stripeSessionId: "cs_live_lateraaaaaaaa", eventId: EVENT, siteId: "site-1" }));
  await flush();
  assert.equal(r.sent.length, 2);
  r.tick(2);
  r.notify(row({ stripeSessionId: "cs_live_later2aaaaaaa", eventId: EVENT, siteId: "site-1" }));
  await flush();
  assert.equal(r.sent.length, 3);
});

test("no address for the organiser: the dashboard is the only place", async () => {
  const none = rig({ address: null });
  none.notify(row({ stripeSessionId: "cs_live_n3aaaaaaaaaa", eventId: EVENT }));
  const blank = rig({ address: "  " });
  blank.notify(row({ stripeSessionId: "cs_live_n4aaaaaaaaaa", eventId: EVENT, siteId: "site-1" }));
  await flush();
  assert.equal(none.sent.length + blank.sent.length, 0);
});

test("a send that fails is swallowed, and logs no address", async () => {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try {
    const r = rig({ sendThrows: true });
    assert.doesNotThrow(() => r.notify(row({ stripeSessionId: "cs_live_n5aaaaaaaaaa", eventId: EVENT, siteId: "site-1" })));
    await flush();
  } finally {
    console.error = orig;
  }
  assert.ok(lines.length > 0 && lines.every((l) => !l.includes("typo@exampl.com")));
});

test("an event with no title is still named sensibly", () => {
  assert.equal(buildUndeliveredNotice("", "u").subject, "A ticket for your event didn't arrive");
});

test("only ticket rows reach the listener: transactional, naming a sale and an event", () => {
  const heard: string[] = [];
  ledger.onTicketFailure((e) => heard.push(e.context?.stripeSessionId ?? "none"));
  ledger.onTicketFailure(() => {
    throw new Error("a broken listener");
  });
  const rec = (kind: "transactional" | "marketing", context: Record<string, string>) =>
    ledger.recordFailure({ kind, recipients: ["a@b.co"], recipientHashes: ["h"], subject: "s", provider: "ses", error: "e", attempts: 1, retryable: false, context });
  rec("transactional", { stripeSessionId: "cs_live_heard00000001", eventId: EVENT });
  rec("marketing", { stripeSessionId: "cs_live_heard00000002", eventId: EVENT });
  rec("transactional", { eventId: EVENT });
  rec("transactional", { kind: "undelivered-notice", eventId: EVENT });
  assert.deepEqual(heard, ["cs_live_heard00000001"], "and a throwing listener changes nothing");
  assert.equal(ledger.listFailures().length, 4, "every row still recorded");
});

test("a bounced organiser notice is counted, never the undelivered-ticket alarm", () => {
  ledger._resetForTest();
  const rec = (context: Record<string, string>) =>
    ledger.recordFailure({ kind: "transactional", recipients: ["org@x.co"], recipientHashes: ["h"], subject: "s", provider: "ses", error: "e", attempts: 1, retryable: false, context });
  rec({ kind: "undelivered-notice", eventId: EVENT });
  rec({ kind: "stripe-requirement-nudge" });
  let h = ledger.failureHealth();
  assert.equal(h.ok, true);
  assert.equal(h.unresolvedOrganiserNotices, 2);
  assert.equal(h.unresolvedTransactional, 0);
  rec({ stripeSessionId: "cs_live_real000000001", eventId: EVENT });
  h = ledger.failureHealth();
  assert.equal(h.ok, false, "a buyer's ticket still is");
  assert.equal(h.unresolvedTransactional, 1);
});
