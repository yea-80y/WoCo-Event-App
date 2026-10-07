/**
 * WoCo's own email to every buyer of a cancelled event (#798). Owner decision
 * 2026-10-07: every buyer is told, erased or not. Once per sale; never from a
 * pass that learned nothing; never past a bounce or a complaint; never able to
 * stop a refund.
 */

import { test, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CancelNotice, CancelRefundRow } from "../src/lib/event/cancellations.js";
import type { CancellationNoticeDeps } from "../src/lib/stripe/cancellation-notice.js";
import type { SuppressSource } from "../src/lib/marketing/suppression-store.js";

let store: typeof import("../src/lib/event/cancellations.js");
let job: typeof import("../src/lib/stripe/cancellation-refunds.js");
let notice: typeof import("../src/lib/stripe/cancellation-notice.js");
let crossing: typeof import("../src/lib/email/service-notice-crossing.js");
let storeFile: string;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "woco-cancel-notice-"));
  process.chdir(dir);
  mkdirSync(join(dir, ".data"), { recursive: true });
  storeFile = join(dir, ".data", "event-cancellations.json");
  store = await import("../src/lib/event/cancellations.js");
  job = await import("../src/lib/stripe/cancellation-refunds.js");
  notice = await import("../src/lib/stripe/cancellation-notice.js");
  crossing = await import("../src/lib/email/service-notice-crossing.js");
});

beforeEach(() => {
  store.__resetForTests();
  job._resetCancellationJobForTest();
  rmSync(storeFile, { force: true });
});

const EV = "ev-notice-1";

function row(over: Partial<CancelRefundRow> = {}): CancelRefundRow {
  return { sessionId: "cs_1", paymentIntentId: "pi_1", account: "acct_1", status: "pending", attempts: 0, created: 0, updatedAt: "t", ...over };
}

function fakeNoticeDeps(o: { email?: string | null; readThrows?: boolean; sources?: SuppressSource[]; sendThrows?: boolean } = {}) {
  const sent: Array<{ to: string; subject: string; text: string; context: Record<string, string> }> = [];
  const notices = new Map<string, CancelNotice>();
  const deps: CancellationNoticeDeps = {
    async buyerEmail() {
      if (o.readThrows) throw new Error("stripe down");
      return o.email === undefined ? "buyer@example.com" : o.email;
    },
    hashEmail: (e) => `h(${e})`,
    suppressionSources: () => o.sources ?? [],
    organiserOf: () => "0xorg",
    async send(to, message, context) {
      if (o.sendThrows) throw new Error("ses down");
      sent.push({ to, subject: message.subject, text: message.text, context });
    },
    setNotice: (eventId, sessionId, n) => {
      notices.set(sessionId, n);
      store.setRefundNotice(eventId, sessionId, n);
    },
    now: () => new Date("2026-10-07T01:00:00Z"),
  };
  return { deps, sent, notices };
}

describe("which notice a row is owed", () => {
  test("a pass that has not read the charge yet is owed nothing", () => {
    assert.equal(notice.noticeDue(row({ status: "pending" })), null);
  });
  test("money moving is 'issued'; money stuck is 'delayed'; an operator's resolution is nothing", () => {
    for (const status of ["done", "pending", "requires-action"] as const) {
      assert.equal(notice.noticeDue(row({ status, charged: 1000 })), "issued", status);
    }
    for (const status of ["pending-funds", "failed", "abandoned", "disputed"] as const) {
      assert.equal(notice.noticeDue(row({ status, charged: 1000 })), "delayed", status);
    }
    assert.equal(notice.noticeDue(row({ status: "resolved", charged: 1000 })), null);
  });
  test("delayed then done is owed 'issued' once more; after 'issued', unreachable or 3 failures, nothing", () => {
    assert.equal(notice.noticeDue(row({ status: "pending-funds", charged: 1, notice: { delayedAt: "t" } })), null);
    assert.equal(notice.noticeDue(row({ status: "done", charged: 1, notice: { delayedAt: "t" } })), "issued");
    assert.equal(notice.noticeDue(row({ status: "done", charged: 1, notice: { issuedAt: "t" } })), null);
    assert.equal(notice.noticeDue(row({ status: "done", charged: 1, notice: { unreachable: "no-address" } })), null);
    assert.equal(notice.noticeDue(row({ status: "done", charged: 1, notice: { failures: notice.MAX_NOTICE_FAILURES } })), null);
  });
});

describe("re-opened rows (Fable sign-off)", () => {
  test("a re-opened row whose next read failed is NOT told its refund is on its way", () => {
    // reopenRefundRow keeps `charged` from the old read; a failed read leaves lastError.
    assert.equal(notice.noticeDue(row({ status: "pending", charged: 1000, lastError: "stripe down", notice: { delayedAt: "t" } })), null);
    assert.equal(notice.noticeDue(row({ status: "pending", charged: 1000, lastError: "charge_already_refunded" })), null);
    // Once a read settles it, lastError is cleared and the notice is owed.
    assert.equal(notice.noticeDue(row({ status: "pending", charged: 1000, notice: { delayedAt: "t" } })), "issued");
  });
  test("a success clears earlier failures, so the next notice has its full retries", async () => {
    const f = fakeNoticeDeps();
    await notice.notifyRow(EV, "Gig", row({ status: "pending-funds", charged: 1, notice: { failures: 2 } }), f.deps);
    assert.deepEqual(Object.keys(f.notices.get("cs_1") ?? {}), ["delayedAt"]);
  });
});

describe("the message", () => {
  test("names the event and the amount, and carries no promotion", () => {
    const m = notice.buildCancellationNotice({ variant: "issued", title: "Hackathon", status: "done", amount: notice.formatAmount(1250, "gbp") });
    assert.match(m.subject, /^Hackathon is cancelled - your refund is on its way$/);
    assert.match(m.text, /£12\.50/);
    assert.doesNotMatch(m.text + m.html, /https?:\/\//, "no links: a service message, not marketing");
    const d = notice.buildCancellationNotice({ variant: "delayed", title: undefined, status: "pending-funds", amount: null });
    assert.match(d.subject, /being arranged/);
    assert.match(d.text, /email you again/);
  });
  test("the title is escaped in the html", () => {
    const m = notice.buildCancellationNotice({ variant: "issued", title: "<b>x</b>", status: "done", amount: null });
    assert.doesNotMatch(m.html, /<b>x<\/b>/);
  });
});

describe("the title, the only organiser text that crosses unsubscribes and erasure", () => {
  test("keeps plain words; drops links, domains and addresses; is capped", () => {
    assert.equal(notice.plainTitle("Hackathon 2026"), "Hackathon 2026");
    assert.equal(notice.plainTitle("Gig v2.0 at O2 Arena"), "Gig v2.0 at O2 Arena");
    assert.equal(notice.plainTitle("BUY NOW at https://spam.example/x !!"), "BUY NOW at !!");
    assert.equal(notice.plainTitle("tickets at evil.com/deal"), "tickets at");
    assert.equal(notice.plainTitle("mail a@b.co"), "mail");
    assert.equal(notice.plainTitle("www.x.io"), undefined, "nothing left: the generic wording is used");
    assert.ok(notice.plainTitle("x".repeat(200))!.length <= 80);
    // Unicode lookalikes a mail client would still linkify (Fable + security review).
    for (const t of [
      "deals example\uFF0Ecom",
      "deals example\u3002com",
      "deals example\uFF61com",
      "deals example\u2024com",
      "deals tickets\uFF20woco.co",
      "deals Gig\u200B.com",
      "deals \u043f\u0440\u0438\u043c\u0435\u0440.\u0440\u0444",
      "deals xn--e1afmkfd.xn--p1ai",
      "deals EXAMPLE.COM/x",
    ]) {
      assert.equal(notice.plainTitle(t), "deals", JSON.stringify(t));
    }
    const m = notice.buildCancellationNotice({ variant: "issued", title: "Promo at deals.example.com", status: "done", amount: null });
    assert.doesNotMatch(m.subject + m.text + m.html, /deals\.example/);
  });
});

describe("the crossing rule", () => {
  test("crosses every consent mark AND manual (erasure); refused by bounce, complaint, or an unknown source", () => {
    assert.equal(crossing.mayDeliverRefundNotice([]), true);
    assert.equal(crossing.mayDeliverRefundNotice(["unsub", "unsub_all", "declined", "manual"]), true);
    assert.equal(crossing.mayDeliverRefundNotice(["manual", "bounce"]), false);
    assert.equal(crossing.mayDeliverRefundNotice(["complaint"]), false);
    assert.equal(crossing.mayDeliverRefundNotice(["new-kind" as SuppressSource]), false);
    // The organiser path is unchanged: it never crosses `manual`.
    assert.equal(crossing.mayCrossSuppression(["manual"]), false);
  });
});

describe("notifyRow", () => {
  test("an erased buyer (manual mark) is told", async () => {
    const f = fakeNoticeDeps({ sources: ["manual"] });
    assert.equal(await notice.notifyRow(EV, "Gig", row({ status: "done", charged: 2000, refunded: 2000, currency: "gbp" }), f.deps), "sent");
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0]!.to, "buyer@example.com");
    assert.equal(f.sent[0]!.context.kind, "cancellation-notice");
    assert.equal(f.notices.get("cs_1")?.issuedAt, "2026-10-07T01:00:00.000Z");
  });
  test("a failed Stripe read changes nothing; no address is final; a bounce is final and sends nothing", async () => {
    const r = row({ status: "done", charged: 1 });
    const read = fakeNoticeDeps({ readThrows: true });
    assert.equal(await notice.notifyRow(EV, "Gig", r, read.deps), "deferred");
    assert.equal(read.notices.size, 0);
    const none = fakeNoticeDeps({ email: null });
    assert.equal(await notice.notifyRow(EV, "Gig", r, none.deps), "unreachable");
    assert.equal(none.notices.get("cs_1")?.unreachable, "no-address");
    const bounced = fakeNoticeDeps({ sources: ["bounce"] });
    assert.equal(await notice.notifyRow(EV, "Gig", r, bounced.deps), "unreachable");
    assert.equal(bounced.sent.length, 0);
    assert.equal(bounced.notices.get("cs_1")?.unreachable, "undeliverable");
  });
  test("a rejected send counts a failure and is NOT marked sent", async () => {
    const f = fakeNoticeDeps({ sendThrows: true });
    assert.equal(await notice.notifyRow(EV, "Gig", row({ status: "done", charged: 1 }), f.deps), "failed");
    assert.deepEqual(f.notices.get("cs_1"), { failures: 1 });
  });
});

describe("inside the refund pass", () => {
  function refundDeps(charges: Record<string, { amount: number; refunds: Array<{ amount: number; status: string }> }>, createError?: string) {
    return {
      saleSessionsFor: (eventId: string) => (eventId === EV ? Object.keys(charges).map((pi, i) => ({ sessionId: `cs_${i}`, paymentIntentId: pi, account: "acct_1" })) : []),
      async latestCharge(pi: string) {
        return { id: `ch_${pi}`, amount: charges[pi]!.amount, currency: "gbp", disputed: false };
      },
      async refundsForCharge(chargeId: string) {
        return charges[chargeId.slice(3)]!.refunds;
      },
      async disputesForCharge() {
        return [];
      },
      async createRefund(params: { paymentIntentId: string; amount: number }) {
        if (createError) throw Object.assign(new Error(createError), { code: createError });
        charges[params.paymentIntentId]!.refunds.push({ amount: params.amount, status: "succeeded" });
        return { id: "re_1", status: "succeeded" };
      },
      async reconcile() {},
    };
  }

  test("every sale is told exactly once across repeated passes, with the cancelled title", async () => {
    store.recordCancellation({ eventId: EV, by: "organiser:0xorg", feeReturned: false, title: "Final Stripe Tests" });
    const f = fakeNoticeDeps();
    const deps = { ...refundDeps({ pi_a: { amount: 1500, refunds: [] }, pi_b: { amount: 3000, refunds: [] } }), notice: f.deps };
    await job.runCancellationPass(deps as never, new Date("2026-10-07T01:00:00Z"));
    await job.runCancellationPass(deps as never, new Date("2026-10-08T02:00:00Z"));
    assert.equal(f.sent.length, 2);
    assert.ok(f.sent.every((s) => /^Final Stripe Tests is cancelled - your refund is on its way$/.test(s.subject)));
    assert.equal(store.cancellationProgress(EV)?.notified, 2);
  });

  test("an abandoned sale (never processed again) is still told its refund is delayed", async () => {
    store.recordCancellation({ eventId: EV, by: "ops:test", feeReturned: false });
    const f = fakeNoticeDeps();
    const deps = { ...refundDeps({ pi_x: { amount: 1000, refunds: [] } }, "card_declined"), notice: f.deps };
    for (let i = 0; i < job.MAX_ATTEMPTS + 2; i++) await job.runCancellationPass(deps as never, new Date(Date.parse("2026-10-07T00:00:00Z") + i * 3_600_000));
    assert.equal(store.getCancellation(EV)?.refunds.cs_0?.status, "abandoned");
    assert.equal(f.sent.length, 1, "one 'delayed' notice, not one per failed attempt");
    assert.match(f.sent[0]!.subject, /being arranged/);
  });

  test("a notice that throws cannot stop a refund", async () => {
    store.recordCancellation({ eventId: EV, by: "ops:test", feeReturned: false });
    const f = fakeNoticeDeps();
    f.deps.setNotice = () => {
      throw new Error("disk full");
    };
    const charges = { pi_y: { amount: 800, refunds: [] as Array<{ amount: number; status: string }> } };
    const deps = { ...refundDeps(charges), notice: f.deps };
    await job.runCancellationPass(deps as never, new Date("2026-10-07T01:00:00Z")); // must not reject
    assert.equal(charges.pi_y.refunds.length, 1, "the refund was created before any notice ran");
  });
});
