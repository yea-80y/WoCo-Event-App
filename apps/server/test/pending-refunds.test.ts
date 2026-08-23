/**
 * Pending auto-refunds (#367): the durable record and the retry.
 *
 * Money path — the failure modes are paying a buyer twice (a partial refund
 * replayed after its idempotency key expired), never paying them (a row that
 * quietly vanishes or a retry that stops without alarming), and paying the
 * organiser for a sale that was refunded on retry. Each has a test.
 *
 * Driven through `RefundGateway`; no Stripe. The store writes .data/ under
 * process.cwd(), so the suite chdirs into a temp dir BEFORE importing it.
 */

import { test, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pr: typeof import("../src/lib/stripe/pending-refunds.js");
let storeFile: string;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "woco-pending-refunds-"));
  process.chdir(dir);
  storeFile = join(dir, ".data", "pending-refunds.json");
  pr = await import("../src/lib/stripe/pending-refunds.js");
});

beforeEach(() => {
  // Memory and file reset TOGETHER: the module reloads from disk on first use,
  // so clearing one without the other would leak a row between tests.
  pr.__resetForTests();
  rmSync(storeFile, { force: true });
});

// ---------------------------------------------------------------------------
// Fake gateway
// ---------------------------------------------------------------------------

interface FakeOpts {
  /** paymentIntentId → refund id already on Stripe carrying our session marker. */
  existing?: Record<string, string>;
  /** Listing fails (null = could not ask). */
  listFails?: boolean;
  /** createRefund throws with this code/message. */
  createError?: { code?: string; message: string };
}

function fakeGateway(o: FakeOpts = {}) {
  const created: Array<{ params: Record<string, unknown>; account: string | undefined; key: string }> = [];
  const voided: string[] = [];
  let seq = 0;
  const gateway: import("../src/lib/stripe/pending-refunds.js").RefundGateway = {
    async findRefundBySession(pi) {
      if (o.listFails) return null;
      return { refundId: o.existing?.[pi] ?? null };
    },
    async createRefund(params, account, key) {
      if (o.createError) {
        const err = Object.assign(new Error(o.createError.message), o.createError.code ? { code: o.createError.code } : {});
        throw err;
      }
      // Same key → same refund (Stripe's idempotency), which the retry relies on.
      const same = created.find((c) => c.key === key);
      if (same) return { id: `re_${created.indexOf(same) + 1}` };
      created.push({ params: params as unknown as Record<string, unknown>, account, key });
      return { id: `re_${++seq}` };
    },
    markPayoutVoid(sessionId) {
      voided.push(sessionId);
    },
  };
  return { gateway, created, voided };
}

function record(over: Partial<Parameters<typeof pr.recordPendingRefund>[0]> = {}) {
  return pr.recordPendingRefund({
    sessionId: "cs_1",
    paymentIntentId: "pi_1",
    connectedAccountId: "acct_1",
    reason: "execution reverted: Insufficient supply",
    metadata: { reason: "ticket-claim-failed", sessionId: "cs_1", quantityUnfilled: "2" },
    error: "ECONNRESET",
    ...over,
  });
}

// ---------------------------------------------------------------------------
// Record
// ---------------------------------------------------------------------------

describe("record", () => {
  test("a failed auto-refund is written to disk, listed, and alarms on health", () => {
    const e = record();
    assert.equal(e.status, "pending");
    assert.equal(e.attempts, 0);
    assert.equal(e.idempotencyKey, "woco-autorefund-cs_1");
    assert.ok(existsSync(storeFile), "durable — a restart must not lose a buyer's refund");
    const onDisk = JSON.parse(readFileSync(storeFile, "utf-8"));
    assert.equal(onDisk.cs_1.paymentIntentId, "pi_1");
    assert.deepEqual(pr.listPendingRefunds().map((x) => x.sessionId), ["cs_1"]);
    const h = pr.pendingRefundsHealth();
    assert.equal(h.pending, 1);
    assert.equal(h.abandoned, 0);
    assert.equal(h.oldestPendingAt, e.createdAt);
  });

  test("a second record for the same session updates the error, never the attempt count or key", () => {
    record();
    const e = record({ error: "timeout" });
    assert.equal(e.lastError, "timeout");
    assert.equal(e.attempts, 0);
    assert.equal(pr.listPendingRefunds().length, 1);
  });

  test("survives a reload from disk", () => {
    record();
    pr.__resetForTests(); // drops memory, keeps the file
    assert.equal(pr.listPendingRefunds().length, 1, "the row is worthless if a restart empties it");
    assert.equal(pr.pendingRefundsHealth().pending, 1);
  });

  test("partial amount is kept; full refund has no amount", () => {
    record({ amount: 2200 });
    assert.equal(pr.getPendingRefund("cs_1")?.amount, 2200);
    pr.__resetForTests();
    rmSync(storeFile, { force: true });
    record();
    assert.equal(pr.getPendingRefund("cs_1")?.amount, undefined);
  });
});

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

describe("retry", () => {
  test("a refund that already landed (lost response) is recognised, not repeated; full → payout voided", async () => {
    record();
    const f = fakeGateway({ existing: { pi_1: "re_landed" } });
    const out = await pr.retryPendingRefunds(f.gateway);
    assert.deepEqual(out, [{ sessionId: "cs_1", result: "done", refundId: "re_landed" }]);
    assert.equal(f.created.length, 0, "must NOT create a second refund");
    assert.deepEqual(f.voided, ["cs_1"]);
    assert.equal(pr.getPendingRefund("cs_1")?.status, "done");
    assert.equal(pr.pendingRefundsHealth().pending, 0);
  });

  test("not landed → created under the SAME idempotency key fulfilment used, with the exact params", async () => {
    record({ amount: 2200 });
    const f = fakeGateway();
    const out = await pr.retryPendingRefunds(f.gateway);
    assert.equal(out[0].result, "done");
    assert.equal(f.created.length, 1);
    assert.equal(f.created[0].key, "woco-autorefund-cs_1");
    assert.equal(f.created[0].account, "acct_1");
    assert.equal(f.created[0].params.payment_intent, "pi_1");
    assert.equal(f.created[0].params.amount, 2200);
    assert.equal(f.created[0].params.refund_application_fee, true, "#121 holds on retry too");
    assert.deepEqual(f.created[0].params.metadata, { reason: "ticket-claim-failed", sessionId: "cs_1", quantityUnfilled: "2" });
    assert.equal(f.voided.length, 0, "a PARTIAL refund leaves the payout entry held");
    assert.equal(pr.getPendingRefund("cs_1")?.refundId, "re_1");
  });

  test("full refund created on retry voids the payout entry", async () => {
    record();
    const f = fakeGateway();
    await pr.retryPendingRefunds(f.gateway);
    assert.deepEqual(f.voided, ["cs_1"]);
  });

  test("cannot ask Stripe whether it landed → skip this round, no create, no attempt counted", async () => {
    record();
    const f = fakeGateway({ listFails: true });
    const out = await pr.retryPendingRefunds(f.gateway);
    assert.deepEqual(out, [{ sessionId: "cs_1", result: "skipped-unverifiable" }]);
    assert.equal(f.created.length, 0, "creating blind past the idempotency horizon could refund a partial twice");
    assert.equal(pr.getPendingRefund("cs_1")?.attempts, 0);
    assert.equal(pr.getPendingRefund("cs_1")?.status, "pending");
  });

  test("create fails → still pending, attempt counted, error kept, alarm stays", async () => {
    record();
    const f = fakeGateway({ createError: { message: "stripe 503" } });
    const out = await pr.retryPendingRefunds(f.gateway);
    assert.equal(out[0].result, "failed");
    const e = pr.getPendingRefund("cs_1")!;
    assert.equal(e.status, "pending");
    assert.equal(e.attempts, 1);
    assert.equal(e.lastError, "stripe 503");
    assert.ok(e.lastAttemptAt);
    assert.equal(pr.pendingRefundsHealth().pending, 1);
  });

  test("after MAX_ATTEMPTS failures the row is abandoned — retries stop, the alarm does not", async () => {
    record();
    const f = fakeGateway({ createError: { message: "stripe 503" } });
    for (let i = 0; i < pr.MAX_ATTEMPTS; i++) await pr.retryPendingRefunds(f.gateway);
    const e = pr.getPendingRefund("cs_1")!;
    assert.equal(e.status, "abandoned");
    assert.equal(e.attempts, pr.MAX_ATTEMPTS);
    const h = pr.pendingRefundsHealth();
    assert.equal(h.pending, 0);
    assert.equal(h.abandoned, 1, "abandoned is still an alarm");
    // And a further sweep does nothing to it.
    const out = await pr.retryPendingRefunds(f.gateway);
    assert.deepEqual(out, []);
    assert.equal(pr.listPendingRefunds().length, 1, "still listed for the operator");
  });

  test("charge_already_refunded → settled: somebody (the dashboard) already made the buyer whole", async () => {
    record();
    const f = fakeGateway({ createError: { code: "charge_already_refunded", message: "already refunded" } });
    const out = await pr.retryPendingRefunds(f.gateway);
    assert.equal(out[0].result, "already-refunded");
    assert.equal(pr.getPendingRefund("cs_1")?.status, "done");
    assert.deepEqual(f.voided, ["cs_1"], "full refund → nothing to release");
  });

  test("a disputed charge is terminal: abandoned at once, no 48 pointless retries", async () => {
    record();
    const f = fakeGateway({ createError: { code: "charge_disputed", message: "charged back" } });
    const out = await pr.retryPendingRefunds(f.gateway);
    assert.equal(out[0].result, "abandoned");
    assert.equal(pr.getPendingRefund("cs_1")?.status, "abandoned");
    assert.equal(pr.pendingRefundsHealth().abandoned, 1);
  });

  test("operator resolve clears the alarm and records who", () => {
    record();
    assert.equal(pr.resolvePendingRefund("cs_1", "nabil"), true);
    assert.equal(pr.getPendingRefund("cs_1")?.status, "resolved");
    assert.equal(pr.getPendingRefund("cs_1")?.resolvedBy, "nabil");
    assert.equal(pr.pendingRefundsHealth().pending, 0);
    assert.equal(pr.resolvePendingRefund("cs_1", "nabil"), false, "already resolved");
    assert.equal(pr.resolvePendingRefund("cs_nope", "nabil"), false);
  });

  test("several entries: each is judged on its own", async () => {
    record({ sessionId: "cs_a", paymentIntentId: "pi_a" });
    record({ sessionId: "cs_b", paymentIntentId: "pi_b", amount: 500 });
    const f = fakeGateway({ existing: { pi_a: "re_a" } });
    const out = await pr.retryPendingRefunds(f.gateway);
    assert.deepEqual(out.map((o) => [o.sessionId, o.result]), [["cs_a", "done"], ["cs_b", "done"]]);
    assert.equal(f.created.length, 1, "only cs_b needed creating");
    assert.deepEqual(f.voided, ["cs_a"], "cs_b was partial");
  });
});

describe("job", () => {
  test("starting the job marks health running", () => {
    assert.equal(pr.pendingRefundsHealth().running, false);
    pr.startPendingRefundRetryJob(fakeGateway().gateway);
    assert.equal(pr.pendingRefundsHealth().running, true);
    pr.__resetForTests();
    assert.equal(pr.pendingRefundsHealth().running, false);
  });
});
