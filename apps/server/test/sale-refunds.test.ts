/**
 * Refund events -> ticket voids (#645 part C): which refunds are ours, and that
 * the result depends on Stripe's totals, never on the order events arrive in.
 *
 * Driven through `SaleRefundReads` and `SaleRefundStore` fakes; no Stripe, no disk.
 */

import { test, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import {
  AWAITING_ALARM_MS,
  alreadyApplied,
  noteApplied,
  reconcileRefundEvent,
  refundedTotal,
  saleRefundEventsHealth,
  _resetSaleRefundStateForTest,
  type LatestCharge,
  type SaleRefundReads,
  type SaleRefundStore,
} from "../src/lib/stripe/sale-refunds.js";
import type { TicketSale } from "../src/lib/stripe/ticket-sales.js";

beforeEach(() => _resetSaleRefundStateForTest());

const SALE: TicketSale = {
  sessionId: "cs_1",
  paymentIntentId: "pi_1",
  connectedAccountId: "acct_1",
  quantity: 2,
  amountTotal: 2000,
  currency: "gbp",
  recordedAt: "2026-09-26T00:00:00.000Z",
  slots: [0, 1],
};

interface Refund { amount: number; status: string | null }

function fakeReads(o: {
  charge?: LatestCharge | null;
  refunds?: Refund[];
  fee?: { amount: number; account: string } | null;
  throwOn?: "latestCharge" | "refundsForCharge" | "retrievePlatformFee";
} = {}) {
  const calls: string[] = [];
  const t = (step: string) => {
    calls.push(step);
    if (o.throwOn === step) throw Object.assign(new Error("boom"), { name: "StripeConnectionError" });
  };
  const reads: SaleRefundReads = {
    async latestCharge() {
      t("latestCharge");
      return o.charge === undefined ? { id: "ch_1", amount: 2000, feeRequested: true, feeId: "fee_1" } : o.charge;
    },
    async refundsForCharge() {
      t("refundsForCharge");
      return o.refunds ?? [];
    },
    async retrievePlatformFee() {
      t("retrievePlatformFee");
      return o.fee === undefined ? { amount: 30, account: "acct_1" } : o.fee;
    },
  };
  return { reads, calls };
}

function fakeStore(sale: TicketSale | undefined, persisting = true) {
  const applied: Array<{ sessionId: string; refunded: number; charged: number }> = [];
  const store: SaleRefundStore = {
    persisting: () => persisting,
    getSaleByPaymentIntent: (pi) => (sale && sale.paymentIntentId === pi ? sale : undefined),
    applyRefundState: (sessionId, refunded, charged) => {
      applied.push({ sessionId, refunded, charged });
      return { voided: refunded >= charged, unvoided: false, partialAlarm: false };
    },
  };
  return { store, applied };
}

const INPUT = { paymentIntentId: "pi_1", account: "acct_1" };

describe("refundedTotal", () => {
  test("counts pending and succeeded; failed, canceled and requires_action are not money back", () => {
    assert.equal(
      refundedTotal([
        { amount: 100, status: "succeeded" },
        { amount: 200, status: "pending" },
        { amount: 400, status: "failed" },
        { amount: 800, status: "canceled" },
        { amount: 1600, status: "requires_action" },
        { amount: 3200, status: null },
      ]),
      300,
    );
  });
});

describe("a recorded sale", () => {
  test("applies Stripe's CURRENT totals, read afresh — not the event's", async () => {
    const { reads, calls } = fakeReads({ refunds: [{ amount: 2000, status: "succeeded" }] });
    const { store, applied } = fakeStore(SALE);
    const out = await reconcileRefundEvent(INPUT, reads, store);
    assert.equal(out.kind, "applied");
    assert.deepEqual(applied, [{ sessionId: "cs_1", refunded: 2000, charged: 2000 }]);
    assert.deepEqual(calls, ["latestCharge", "refundsForCharge"], "no fee lookup: the record already says ours");
  });

  test("order-free: charge.refunded and refund.failed in either order end at the same state", async () => {
    // Both events re-read the same current truth (the full refund FAILED), so
    // whichever arrives last, the applied total is the failed-out one.
    const now = [{ amount: 2000, status: "failed" }];
    const a = fakeStore(SALE);
    await reconcileRefundEvent(INPUT, fakeReads({ refunds: now }).reads, a.store);
    await reconcileRefundEvent(INPUT, fakeReads({ refunds: now }).reads, a.store);
    assert.deepEqual(a.applied.map((x) => x.refunded), [0, 0]);
  });

  test("a transport failure asks Stripe to retry and decides nothing", async () => {
    for (const step of ["latestCharge", "refundsForCharge"] as const) {
      const { store, applied } = fakeStore(SALE);
      const out = await reconcileRefundEvent(INPUT, fakeReads({ throwOn: step }).reads, store);
      assert.equal(out.kind, "retry", step);
      assert.equal(applied.length, 0, step);
    }
  });

  test("while the record cannot persist, a recorded sale is retried, never applied in memory", async () => {
    const { store, applied } = fakeStore(SALE, false);
    const out = await reconcileRefundEvent(INPUT, fakeReads({ refunds: [{ amount: 2000, status: "succeeded" }] }).reads, store);
    assert.equal(out.kind, "retry");
    assert.equal(applied.length, 0);
  });

  test("two events on one payment intent apply in the order they READ, never older-over-newer", async () => {
    // The first delivery reads slowly and sees the older total (a partial
    // refund); the second reads fast and sees the newer one (refunded in full).
    // Run concurrently, the older total used to land last.
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => (releaseFirst = r));
    let call = 0;
    const reads: SaleRefundReads = {
      async latestCharge() {
        return { id: "ch_1", amount: 2000, feeRequested: true, feeId: "fee_1" };
      },
      async refundsForCharge() {
        const n = ++call;
        if (n === 1) {
          await firstGate;
          return [{ amount: 500, status: "succeeded" }];
        }
        return [{ amount: 500, status: "succeeded" }, { amount: 1500, status: "succeeded" }];
      },
      async retrievePlatformFee() {
        return { amount: 30, account: "acct_1" };
      },
    };
    const { store, applied } = fakeStore(SALE);
    const a = reconcileRefundEvent(INPUT, reads, store);
    const b = reconcileRefundEvent(INPUT, reads, store);
    releaseFirst();
    await Promise.all([a, b]);
    assert.deepEqual(applied.map((x) => x.refunded), [500, 2000], "the newer total is the one left standing");
  });

  test("a tampered session's refund is applied but not counted as a ticket void", async () => {
    const { store } = fakeStore({ ...SALE, tampered: true });
    await reconcileRefundEvent(INPUT, fakeReads({ refunds: [{ amount: 2000, status: "succeeded" }] }).reads, store);
    assert.equal(saleRefundEventsHealth().voided, 0);
  });

  test("an event from another account than the sale's is not applied", async () => {
    const { store, applied } = fakeStore(SALE);
    const out = await reconcileRefundEvent({ paymentIntentId: "pi_1", account: "acct_other" }, fakeReads().reads, store);
    assert.equal(out.kind, "foreign");
    assert.equal(applied.length, 0);
  });
});

describe("no sale record", () => {
  test("no fee on the charge: an organiser's own sale — foreign, counted", async () => {
    const out = await reconcileRefundEvent(
      INPUT,
      fakeReads({ charge: { id: "ch_1", amount: 500, feeRequested: false, feeId: null } }).reads,
      fakeStore(undefined).store,
    );
    assert.equal(out.kind, "foreign");
    assert.equal(saleRefundEventsHealth().foreign, 1);
  });

  test("a fee requested but not created yet: retry (#666)", async () => {
    const out = await reconcileRefundEvent(
      INPUT,
      fakeReads({ charge: { id: "ch_1", amount: 500, feeRequested: true, feeId: null } }).reads,
      fakeStore(undefined).store,
    );
    assert.equal(out.kind, "retry");
  });

  test("a fee that is not this platform's: foreign", async () => {
    const out = await reconcileRefundEvent(INPUT, fakeReads({ fee: null }).reads, fakeStore(undefined).store);
    assert.equal(out.kind, "foreign");
  });

  test("OUR fee but no record yet: retry, and after an hour it alarms", async () => {
    const out = await reconcileRefundEvent(INPUT, fakeReads().reads, fakeStore(undefined).store);
    assert.equal(out.kind, "retry");
    assert.equal(out.kind === "retry" && out.awaitingRecord, true);
    const h = saleRefundEventsHealth();
    assert.equal(h.awaitingRecord, 1);
    assert.equal(h.ok, true, "a race is not an alarm yet");
    assert.equal(saleRefundEventsHealth(Date.now() + AWAITING_ALARM_MS).ok, false);
  });

  test("the awaiting entry clears once the record arrives and the event applies", async () => {
    await reconcileRefundEvent(INPUT, fakeReads().reads, fakeStore(undefined).store);
    await reconcileRefundEvent(INPUT, fakeReads().reads, fakeStore(SALE).store);
    assert.equal(saleRefundEventsHealth().awaitingRecord, 0);
  });

  test("a transport failure on the fee read is a retry, never foreign", async () => {
    const out = await reconcileRefundEvent(INPUT, fakeReads({ throwOn: "retrievePlatformFee" }).reads, fakeStore(undefined).store);
    assert.equal(out.kind, "retry");
    assert.equal(saleRefundEventsHealth().foreign, 0);
  });
});

describe("event dedupe", () => {
  test("an id is only skipped once it has been applied", () => {
    assert.equal(alreadyApplied("evt_1"), false);
    noteApplied("evt_1");
    assert.equal(alreadyApplied("evt_1"), true);
    assert.equal(alreadyApplied("evt_1", Date.now() + 5 * 24 * 60 * 60_000), false, "forgotten past Stripe's retry horizon");
  });
});
