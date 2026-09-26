/**
 * Cancel an event and refund everyone (#644): the store, the refund pass and
 * the cancel core.
 *
 * Money path. The failure modes are a buyer never refunded (silently), a buyer
 * refunded twice or more than they paid, a refund made under the wrong fee
 * policy, a cancelled event that sells again, and a cancellation forgotten by a
 * restart. Each has a test. Stripe is a fake; the store writes .data under a
 * temp cwd chdir'd into BEFORE the import.
 */

import { test, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let store: typeof import("../src/lib/event/cancellations.js");
let job: typeof import("../src/lib/stripe/cancellation-refunds.js");
let core: typeof import("../src/lib/event/cancel-event.js");
let storeFile: string;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "woco-cancellations-"));
  process.chdir(dir);
  mkdirSync(join(dir, ".data"), { recursive: true });
  storeFile = join(dir, ".data", "event-cancellations.json");
  store = await import("../src/lib/event/cancellations.js");
  job = await import("../src/lib/stripe/cancellation-refunds.js");
  core = await import("../src/lib/event/cancel-event.js");
});

beforeEach(() => {
  store.__resetForTests();
  job._resetCancellationJobForTest();
  rmSync(storeFile, { force: true });
});

const EV = "ev-cancel-1";

// ---------------------------------------------------------------------------
// Fake Stripe
// ---------------------------------------------------------------------------

interface FakeCharge {
  amount: number;
  refunds: Array<{ amount: number; status: string; pendingReason?: string | null }>;
  disputes?: Array<{ status: string }>;
}

function fakeDeps(o: {
  sales: Array<{ sessionId: string; paymentIntentId: string; account: string }>;
  charges: Record<string, FakeCharge>;
  /** What a created refund comes back as. Default succeeded. */
  createdStatus?: { status: string; pendingReason?: string | null };
  /** Make createRefund reject with this code. */
  createError?: string;
  readError?: boolean;
}) {
  const created: Array<{ params: Record<string, unknown>; account: string; key: string }> = [];
  const reconciled: string[] = [];
  const deps: import("../src/lib/stripe/cancellation-refunds.js").CancellationRefundDeps = {
    saleSessionsFor: (eventId) => (eventId === EV ? o.sales : []),
    async latestCharge(pi) {
      if (o.readError) throw Object.assign(new Error("stripe down"), { name: "StripeConnectionError" });
      const ch = o.charges[pi];
      return ch ? { id: `ch_${pi}`, amount: ch.amount, currency: "gbp", disputed: (ch.disputes ?? []).length > 0 } : null;
    },
    async refundsForCharge(chargeId) {
      return o.charges[chargeId.slice(3)]!.refunds;
    },
    async disputesForCharge(chargeId) {
      return o.charges[chargeId.slice(3)]!.disputes ?? [];
    },
    async createRefund(params, account, key) {
      if (o.createError) throw Object.assign(new Error(o.createError), { code: o.createError });
      created.push({ params: params as unknown as Record<string, unknown>, account, key });
      const r = o.createdStatus ?? { status: "succeeded" };
      o.charges[params.paymentIntentId]!.refunds.push({ amount: params.amount, status: r.status, pendingReason: r.pendingReason ?? null });
      return { id: `re_${created.length}`, status: r.status, pendingReason: r.pendingReason ?? null };
    },
    async reconcile(pi) {
      reconciled.push(pi);
    },
  };
  return { deps, created, reconciled };
}

const SALE = { sessionId: "cs_1", paymentIntentId: "pi_1", account: "acct_1" };

function cancel(feeReturned = false) {
  const r = store.recordCancellation({ eventId: EV, by: "organiser:0xabc", feeReturned });
  assert.ok(r, "cancellation persisted");
  return r!;
}

const row = (sessionId = "cs_1") => store.getCancellation(EV)!.refunds[sessionId]!;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

describe("store", () => {
  test("a cancellation is idempotent and keeps the fee policy captured first", () => {
    const first = store.recordCancellation({ eventId: EV, by: "organiser:0xabc", feeReturned: false })!;
    const second = store.recordCancellation({ eventId: EV, by: "ops:someone", feeReturned: true })!;
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(store.getCancellation(EV)!.feeReturned, false);
    assert.equal(store.getCancellation(EV)!.by, "organiser:0xabc");
    assert.equal(store.cancellationGate(EV), "cancelled");
    assert.equal(store.cancellationGate("ev-other"), "open");
  });

  test("it survives a restart", () => {
    cancel();
    store.addRefundRow(EV, SALE);
    store.__resetForTests();
    assert.equal(store.cancellationGate(EV), "cancelled");
    assert.equal(row().status, "pending");
  });

  test("the API overlay: the server's record wins over the feed", () => {
    assert.equal(store.withCancellation({ eventId: EV }).cancelledAt, undefined);
    cancel();
    const c = store.getCancellation(EV)!;
    assert.equal(store.withCancellation({ eventId: EV }).cancelledAt, c.cancelledAt);
    assert.equal(store.withCancellation({ eventId: EV, cancelledAt: "tampered" }).cancelledAt, c.cancelledAt);
  });

  for (const [name, contents] of [
    ["truncated JSON", `{"ev": {"eventId": "ev", "canc`],
    ["JSON null", "null"],
    ["a JSON array", "[]"],
  ] as const) {
    test(`${name}: never overwritten, every sale refused, nothing recorded, alarmed`, () => {
      writeFileSync(storeFile, contents);
      assert.equal(store.cancellationGate("any-event"), "unknown");
      assert.equal(store.recordCancellation({ eventId: EV, by: "x", feeReturned: false }), null);
      assert.equal(readFileSync(storeFile, "utf-8"), contents);
      const h = store.cancellationsStoreHealth();
      assert.equal(h.fileUnreadable, true);
      assert.equal(h.ok, false);
    });
  }

  test("a cancellation whose write fails is refused and leaves the event on sale — never cancelled in memory only", () => {
    mkdirSync(`${storeFile}.tmp`);
    try {
      assert.equal(store.recordCancellation({ eventId: EV, by: "x", feeReturned: false }), null);
      assert.equal(store.cancellationGate(EV), "open");
      assert.equal(store.getCancellation(EV), undefined);
    } finally {
      rmSync(`${storeFile}.tmp`, { recursive: true, force: true });
    }
    assert.ok(store.recordCancellation({ eventId: EV, by: "x", feeReturned: false }), "a retry once the disk is back succeeds");
  });

  test("settled is derived: one open row un-settles the event, disputed counts as settled", () => {
    cancel();
    assert.equal(store.isCancellationSettled(EV), true, "no sales");
    store.addRefundRow(EV, SALE);
    assert.equal(store.isCancellationSettled(EV), false);
    store.updateRefundRow(EV, "cs_1", { status: "done" });
    assert.equal(store.isCancellationSettled(EV), true);
    store.addRefundRow(EV, { ...SALE, sessionId: "cs_late", paymentIntentId: "pi_late" });
    assert.equal(store.isCancellationSettled(EV), false, "a late sale un-settles it");
    store.updateRefundRow(EV, "cs_late", { status: "disputed" });
    assert.equal(store.isCancellationSettled(EV), true);
    store.updateRefundRow(EV, "cs_late", { status: "abandoned" });
    assert.equal(store.isCancellationSettled(EV), false, "abandoned holds until an operator resolves it");
    assert.equal(store.resolveRefundRow(EV, "cs_late", "ops"), "resolved");
    assert.equal(store.isCancellationSettled(EV), true);
  });
});

// ---------------------------------------------------------------------------
// Refund pass
// ---------------------------------------------------------------------------

describe("refund pass", () => {
  test("an unrefunded sale is refunded in full, once, under the cancellation's fee policy, and voided", async () => {
    cancel(false);
    const f = fakeDeps({ sales: [SALE], charges: { pi_1: { amount: 2200, refunds: [] } } });
    await job.runCancellationPass(f.deps);
    assert.equal(f.created.length, 1);
    assert.deepEqual(f.created[0]!.params, { paymentIntentId: "pi_1", amount: 2200, feeReturned: false, eventId: EV, sessionId: "cs_1" });
    assert.equal(f.created[0]!.account, "acct_1");
    assert.equal(f.created[0]!.key, job.cancellationIdempotencyKey("cs_1", 2200, 0));
    assert.equal(row().status, "done");
    assert.deepEqual(f.reconciled, ["pi_1"], "tickets voided without waiting for the webhook");

    await job.runCancellationPass(f.deps);
    assert.equal(f.created.length, 1, "a done sale is never refunded again");
  });

  test("the fee policy captured at cancellation is what every refund carries", async () => {
    cancel(true);
    const f = fakeDeps({ sales: [SALE], charges: { pi_1: { amount: 2200, refunds: [] } } });
    await job.runCancellationPass(f.deps);
    assert.equal(f.created[0]!.params.feeReturned, true);
  });

  test("only the remainder is refunded after a partial refund — never more than was paid", async () => {
    cancel();
    const f = fakeDeps({ sales: [SALE], charges: { pi_1: { amount: 2200, refunds: [{ amount: 500, status: "succeeded" }] } } });
    await job.runCancellationPass(f.deps);
    assert.equal(f.created[0]!.params.amount, 1700);
  });

  test("an already fully refunded sale is done with no refund created", async () => {
    cancel();
    const f = fakeDeps({ sales: [SALE], charges: { pi_1: { amount: 2200, refunds: [{ amount: 2200, status: "succeeded" }] } } });
    await job.runCancellationPass(f.deps);
    assert.equal(f.created.length, 0);
    assert.equal(row().status, "done");
    assert.deepEqual(f.reconciled, ["pi_1"], "refunded some other way: its tickets are voided all the same");
  });

  test("a refund held for insufficient funds is waiting-for-funds (alarmed), not re-created", async () => {
    cancel();
    const f = fakeDeps({ sales: [SALE], charges: { pi_1: { amount: 2200, refunds: [] } }, createdStatus: { status: "pending", pendingReason: "insufficient_funds" } });
    await job.runCancellationPass(f.deps);
    assert.equal(row().status, "pending-funds");
    await job.runCancellationPass(f.deps);
    assert.equal(f.created.length, 1, "in flight counts: no second refund");
    assert.equal(store.cancellationsStoreHealth().waitingForFunds, 1);
    assert.equal(store.cancellationsStoreHealth().ok, false);
    assert.equal(f.reconciled.length, 0, "not voided until the money has actually gone back");
  });

  test("requires_action counts as in flight: no over-refund beside it", async () => {
    cancel();
    const f = fakeDeps({ sales: [SALE], charges: { pi_1: { amount: 2200, refunds: [{ amount: 2200, status: "requires_action" }] } } });
    await job.runCancellationPass(f.deps);
    assert.equal(f.created.length, 0);
    assert.equal(row().status, "requires-action");
  });

  test("a refund that FAILED is re-created under a new key, and abandoned after MAX_CREATES", async () => {
    cancel();
    const charge: FakeCharge = { amount: 2200, refunds: [] };
    const f = fakeDeps({ sales: [SALE], charges: { pi_1: charge }, createdStatus: { status: "succeeded" } });
    await job.runCancellationPass(f.deps);
    charge.refunds[0]!.status = "failed";
    await job.runCancellationPass(f.deps);
    assert.equal(f.created.length, 1, "a done row is not re-read on every pass");
    // The refund.failed webhook reopens it (routes/stripe.ts).
    assert.equal(store.reopenRefundRow(EV, "cs_1"), true);
    await job.runCancellationPass(f.deps);
    assert.equal(f.created.length, 2);
    assert.notEqual(f.created[1]!.key, f.created[0]!.key, "a replayed key would return the failed refund");
    assert.equal(f.created[1]!.key, job.cancellationIdempotencyKey("cs_1", 2200, 1));

    for (let i = 0; i < job.MAX_CREATES + 1; i++) {
      charge.refunds.at(-1)!.status = "failed";
      store.reopenRefundRow(EV, "cs_1");
      await job.runCancellationPass(f.deps);
    }
    assert.equal(row().status, "abandoned");
    assert.equal(f.created.length, job.MAX_CREATES, "never more than MAX_CREATES refunds for one sale");
    assert.equal(store.cancellationsStoreHealth().abandoned, 1);
  });

  test("a done refund is re-read once a day for 35 days, so a late failure is re-refunded without any webhook", async () => {
    cancel();
    const charge: FakeCharge = { amount: 2200, refunds: [] };
    const f = fakeDeps({ sales: [SALE], charges: { pi_1: charge } });
    const t0 = new Date("2026-10-01T00:00:00Z");
    await job.runCancellationPass(f.deps, t0);
    charge.refunds[0]!.status = "failed";
    await job.runCancellationPass(f.deps, new Date(t0.getTime() + 60 * 60_000));
    assert.equal(f.created.length, 1, "not within the day");
    await job.runCancellationPass(f.deps, new Date(t0.getTime() + store.DONE_RECHECK_EVERY_MS + 1));
    assert.equal(f.created.length, 2, "the daily re-read found the failure");
    const late = new Date(t0.getTime() + store.DONE_RECHECK_WINDOW_MS + 5 * store.DONE_RECHECK_EVERY_MS);
    charge.refunds.at(-1)!.status = "failed";
    await job.runCancellationPass(f.deps, late);
    assert.equal(f.created.length, 2, "past the window a done row is left alone");
  });

  test("an open chargeback is left to the dispute and re-checked; a lost one is done; a won one is refunded", async () => {
    cancel();
    const charge: FakeCharge = { amount: 2200, refunds: [], disputes: [{ status: "needs_response" }] };
    const f = fakeDeps({ sales: [SALE], charges: { pi_1: charge } });
    await job.runCancellationPass(f.deps);
    assert.equal(row().status, "disputed");
    assert.equal(f.created.length, 0);

    charge.disputes = [{ status: "lost" }];
    await job.runCancellationPass(f.deps);
    assert.equal(row().status, "done", "the bank already returned the money");
    assert.equal(f.created.length, 0);

    store.updateRefundRow(EV, "cs_1", { status: "pending" });
    charge.disputes = [{ status: "won" }];
    await job.runCancellationPass(f.deps);
    assert.equal(f.created.length, 1, "won: the money is back with the organiser, so the buyer is refunded");
  });

  test("an inquiry (warning_*) is refunded — the refund closes it", async () => {
    cancel();
    const f = fakeDeps({ sales: [SALE], charges: { pi_1: { amount: 2200, refunds: [], disputes: [{ status: "warning_needs_response" }] } } });
    await job.runCancellationPass(f.deps);
    assert.equal(f.created.length, 1);
  });

  test("a dispute error from Stripe on create is `disputed`, never abandoned", async () => {
    cancel();
    const f = fakeDeps({ sales: [SALE], charges: { pi_1: { amount: 2200, refunds: [] } }, createError: "charge_disputed" });
    for (let i = 0; i < job.MAX_ATTEMPTS + 2; i++) await job.runCancellationPass(f.deps);
    assert.equal(row().status, "disputed");
  });

  test("charge_already_refunded is not an attempt: the next pass re-reads", async () => {
    cancel();
    const f = fakeDeps({ sales: [SALE], charges: { pi_1: { amount: 2200, refunds: [] } }, createError: "charge_already_refunded" });
    await job.runCancellationPass(f.deps);
    assert.equal(row().status, "pending");
    assert.equal(row().attempts, 0);
  });

  test("other create errors retry, then abandon after MAX_ATTEMPTS (alarmed)", async () => {
    cancel();
    const f = fakeDeps({ sales: [SALE], charges: { pi_1: { amount: 2200, refunds: [] } }, createError: "api_error" });
    await job.runCancellationPass(f.deps);
    assert.equal(row().status, "failed");
    for (let i = 1; i < job.MAX_ATTEMPTS; i++) await job.runCancellationPass(f.deps);
    assert.equal(row().status, "abandoned");
    assert.equal(store.cancellationsStoreHealth().ok, false);
  });

  test("a Stripe read that fails decides nothing and is not an attempt", async () => {
    cancel();
    const f = fakeDeps({ sales: [SALE], charges: { pi_1: { amount: 2200, refunds: [] } }, readError: true });
    await job.runCancellationPass(f.deps);
    assert.equal(row().status, "pending");
    assert.equal(row().attempts, 0);
    assert.equal(f.created.length, 0);
  });

  test("a sale that appears AFTER the cancellation is picked up by the next pass", async () => {
    cancel();
    const sales = [SALE];
    const f = fakeDeps({ sales, charges: { pi_1: { amount: 2200, refunds: [] }, pi_late: { amount: 1100, refunds: [] } } });
    await job.runCancellationPass(f.deps);
    sales.push({ sessionId: "cs_late", paymentIntentId: "pi_late", account: "acct_1" });
    await job.runCancellationPass(f.deps);
    assert.equal(row("cs_late").status, "done");
    assert.deepEqual(f.created.map((c) => c.params.amount), [2200, 1100]);
  });

  test("passes never overlap: a kick during a pass runs one more pass after it", async () => {
    cancel();
    let calls = 0;
    const f = fakeDeps({ sales: [SALE], charges: { pi_1: { amount: 2200, refunds: [] } } });
    const slow = { ...f.deps, saleSessionsFor: (e: string) => { calls++; return f.deps.saleSessionsFor(e); } };
    const a = job.kickCancellationRefunds(slow);
    const b = job.kickCancellationRefunds(slow);
    await Promise.all([a, b]);
    assert.equal(calls, 2, "the second kick became one follow-up pass, not a concurrent one");
    assert.equal(f.created.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Cancel core
// ---------------------------------------------------------------------------

describe("cancelEvent", () => {
  function coreDeps() {
    const calls: string[] = [];
    const deps: import("../src/lib/event/cancel-event.js").CancelEventDeps = {
      unlist: (id) => {
        calls.push(`unlist:${id}:${store.cancellationGate(id)}`);
      },
      invalidateCaches: (id) => {
        calls.push(`invalidate:${id}`);
      },
      kickRefunds: () => {
        calls.push("kick");
      },
      expireOpenSessions: async (id, acct) => {
        calls.push(`expire:${id}:${acct}`);
        return 0;
      },
    };
    return { deps, calls };
  }

  test("the cancellation is persisted BEFORE anything else happens", () => {
    const { deps, calls } = coreDeps();
    const r = core.cancelEvent({ eventId: EV, by: "organiser:0xabc", organiserAccount: "acct_1" }, deps);
    assert.equal(r.ok, true);
    assert.equal(calls[0], `unlist:${EV}:cancelled`, "already cancelled when the follow-ups run");
    assert.deepEqual(calls.slice(1), [`invalidate:${EV}`, "kick", `expire:${EV}:acct_1`]);
    assert.equal(store.getCancellation(EV)!.feeReturned, false, "the shared switch is off");
  });

  test("nothing happens when the cancellation cannot be saved", () => {
    writeFileSync(storeFile, "null");
    const { deps, calls } = coreDeps();
    const r = core.cancelEvent({ eventId: EV, by: "x", organiserAccount: "acct_1" }, deps);
    assert.deepEqual(r, { ok: false, reason: "not-persisted" });
    assert.deepEqual(calls, []);
  });

  test("pressing again repeats the follow-ups (repairable after a crash) without a second record", () => {
    const { deps, calls } = coreDeps();
    core.cancelEvent({ eventId: EV, by: "organiser:0xabc" }, deps);
    const again = core.cancelEvent({ eventId: EV, by: "organiser:0xabc" }, deps);
    assert.equal(again.ok && again.created, false);
    assert.equal(calls.filter((c) => c === "kick").length, 2);
  });

  test("a follow-up that throws does not undo or block the cancellation", () => {
    const { deps } = coreDeps();
    deps.unlist = () => {
      throw new Error("listing store down");
    };
    const r = core.cancelEvent({ eventId: EV, by: "x" }, deps);
    assert.equal(r.ok, true);
    assert.equal(store.cancellationGate(EV), "cancelled");
  });
});

describe("site listings (events-full)", () => {
  test("a cancelled event leaves both the index and the events of every site's listing", async () => {
    cancel();
    const { withoutCancelled } = await import("../src/routes/sites.js");
    const ev = (eventId: string) => ({ eventId }) as never;
    const out = withoutCancelled({
      index: { siteId: "s", events: [{ eventId: EV }, { eventId: "ev_open" }], updatedAt: 0, schemaVersion: 1 } as never,
      events: [ev(EV), ev("ev_open")],
    });
    assert.deepEqual(out.index.events.map((e: { eventId: string }) => e.eventId), ["ev_open"]);
    assert.deepEqual(out.events.map((e: { eventId: string }) => e.eventId), ["ev_open"]);
  });
});
