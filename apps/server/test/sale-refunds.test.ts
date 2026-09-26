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
  reconcileChargeEvent,
  readDisputes,
  refundedTotal,
  saleRefundEventsHealth,
  _resetSaleRefundStateForTest,
  type LatestCharge,
  type SaleRefundReads,
  type SaleRefundStore,
} from "../src/lib/stripe/sale-refunds.js";
import type { DisputeReading, TicketSale } from "../src/lib/stripe/ticket-sales.js";

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
  disputes?: Array<{ status: string }>;
  throwOn?: "latestCharge" | "refundsForCharge" | "retrievePlatformFee" | "disputesForCharge";
} = {}) {
  const calls: string[] = [];
  const t = (step: string) => {
    calls.push(step);
    if (o.throwOn === step) throw Object.assign(new Error("boom"), { name: "StripeConnectionError" });
  };
  const reads: SaleRefundReads = {
    async latestCharge() {
      t("latestCharge");
      return o.charge === undefined
        ? { id: "ch_1", amount: 2000, feeRequested: true, feeId: "fee_1", disputed: o.disputes !== undefined && o.disputes.length > 0 }
        : o.charge;
    },
    async refundsForCharge() {
      t("refundsForCharge");
      return o.refunds ?? [];
    },
    async retrievePlatformFee() {
      t("retrievePlatformFee");
      return o.fee === undefined ? { amount: 30, account: "acct_1" } : o.fee;
    },
    async disputesForCharge() {
      t("disputesForCharge");
      return o.disputes ?? [];
    },
  };
  return { reads, calls };
}

function fakeStore(sale: TicketSale | undefined, persisting = true) {
  const applied: Array<{ sessionId: string; refunded: number; charged: number }> = [];
  const disputeReadings: DisputeReading[] = [];
  const store: SaleRefundStore = {
    persisting: () => persisting,
    applyDisputeState: (_sessionId, reading) => {
      disputeReadings.push(reading);
      return { voided: reading.chargeback, unvoided: !reading.chargeback };
    },
    getSaleByPaymentIntent: (pi) => (sale && sale.paymentIntentId === pi ? sale : undefined),
    applyRefundState: (sessionId, refunded, charged) => {
      applied.push({ sessionId, refunded, charged });
      return { voided: refunded >= charged, unvoided: false, partialAlarm: false };
    },
  };
  return { store, applied, disputeReadings };
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
    const out = await reconcileChargeEvent(INPUT, reads, store);
    assert.equal(out.kind, "applied");
    assert.deepEqual(applied, [{ sessionId: "cs_1", refunded: 2000, charged: 2000 }]);
    assert.deepEqual(calls, ["latestCharge", "refundsForCharge"], "no fee lookup: the record already says ours");
  });

  test("order-free: charge.refunded and refund.failed in either order end at the same state", async () => {
    // Both events re-read the same current truth (the full refund FAILED), so
    // whichever arrives last, the applied total is the failed-out one.
    const now = [{ amount: 2000, status: "failed" }];
    const a = fakeStore(SALE);
    await reconcileChargeEvent(INPUT, fakeReads({ refunds: now }).reads, a.store);
    await reconcileChargeEvent(INPUT, fakeReads({ refunds: now }).reads, a.store);
    assert.deepEqual(a.applied.map((x) => x.refunded), [0, 0]);
  });

  test("a transport failure asks Stripe to retry and decides nothing", async () => {
    for (const step of ["latestCharge", "refundsForCharge"] as const) {
      const { store, applied } = fakeStore(SALE);
      const out = await reconcileChargeEvent(INPUT, fakeReads({ throwOn: step }).reads, store);
      assert.equal(out.kind, "retry", step);
      assert.equal(applied.length, 0, step);
    }
  });

  test("while the record cannot persist, a recorded sale is retried, never applied in memory", async () => {
    const { store, applied } = fakeStore(SALE, false);
    const out = await reconcileChargeEvent(INPUT, fakeReads({ refunds: [{ amount: 2000, status: "succeeded" }] }).reads, store);
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
        return { id: "ch_1", amount: 2000, feeRequested: true, feeId: "fee_1", disputed: false };
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
      async disputesForCharge() {
        return [];
      },
    };
    const { store, applied } = fakeStore(SALE);
    const a = reconcileChargeEvent(INPUT, reads, store);
    const b = reconcileChargeEvent(INPUT, reads, store);
    releaseFirst();
    await Promise.all([a, b]);
    assert.deepEqual(applied.map((x) => x.refunded), [500, 2000], "the newer total is the one left standing");
  });

  test("a tampered session's refund is applied but not counted as a ticket void", async () => {
    const { store } = fakeStore({ ...SALE, tampered: true });
    await reconcileChargeEvent(INPUT, fakeReads({ refunds: [{ amount: 2000, status: "succeeded" }] }).reads, store);
    assert.equal(saleRefundEventsHealth().voided, 0);
  });

  test("an event from another account than the sale's is not applied", async () => {
    const { store, applied } = fakeStore(SALE);
    const out = await reconcileChargeEvent({ paymentIntentId: "pi_1", account: "acct_other" }, fakeReads().reads, store);
    assert.equal(out.kind, "foreign");
    assert.equal(applied.length, 0);
  });
});

describe("no sale record", () => {
  test("no fee on the charge: an organiser's own sale — foreign, counted", async () => {
    const out = await reconcileChargeEvent(
      INPUT,
      fakeReads({ charge: { id: "ch_1", amount: 500, feeRequested: false, feeId: null, disputed: false } }).reads,
      fakeStore(undefined).store,
    );
    assert.equal(out.kind, "foreign");
    assert.equal(saleRefundEventsHealth().foreign, 1);
  });

  test("a fee requested but not created yet: retry (#666)", async () => {
    const out = await reconcileChargeEvent(
      INPUT,
      fakeReads({ charge: { id: "ch_1", amount: 500, feeRequested: true, feeId: null, disputed: false } }).reads,
      fakeStore(undefined).store,
    );
    assert.equal(out.kind, "retry");
  });

  test("a fee that is not this platform's: foreign", async () => {
    const out = await reconcileChargeEvent(INPUT, fakeReads({ fee: null }).reads, fakeStore(undefined).store);
    assert.equal(out.kind, "foreign");
  });

  test("OUR fee but no record yet: retry, and after an hour it alarms", async () => {
    const out = await reconcileChargeEvent(INPUT, fakeReads().reads, fakeStore(undefined).store);
    assert.equal(out.kind, "retry");
    assert.equal(out.kind === "retry" && out.awaitingRecord, true);
    const h = saleRefundEventsHealth();
    assert.equal(h.awaitingRecord, 1);
    assert.equal(h.ok, true, "a race is not an alarm yet");
    assert.equal(saleRefundEventsHealth(Date.now() + AWAITING_ALARM_MS).ok, false);
  });

  test("the awaiting entry clears once the record arrives and the event applies", async () => {
    await reconcileChargeEvent(INPUT, fakeReads().reads, fakeStore(undefined).store);
    await reconcileChargeEvent(INPUT, fakeReads().reads, fakeStore(SALE).store);
    assert.equal(saleRefundEventsHealth().awaitingRecord, 0);
  });

  test("a transport failure on the fee read is a retry, never foreign", async () => {
    const out = await reconcileChargeEvent(INPUT, fakeReads({ throwOn: "retrievePlatformFee" }).reads, fakeStore(undefined).store);
    assert.equal(out.kind, "retry");
    assert.equal(saleRefundEventsHealth().foreign, 0);
  });
});

describe("disputes", () => {
  test("readDisputes: a chargeback is needs_response / under_review / lost; an inquiry is warning_*", () => {
    const none = { chargeback: false, inquiry: false, needsResponse: false, any: false };
    assert.deepEqual(readDisputes([]), none);
    assert.deepEqual(readDisputes([{ status: "needs_response" }]), { chargeback: true, inquiry: false, needsResponse: true, any: true });
    assert.equal(readDisputes([{ status: "under_review" }]).chargeback, true);
    assert.equal(readDisputes([{ status: "lost" }]).chargeback, true);
    assert.deepEqual(readDisputes([{ status: "warning_needs_response" }]), { chargeback: false, inquiry: true, needsResponse: true, any: true });
    assert.equal(readDisputes([{ status: "warning_under_review" }]).inquiry, true);
    for (const closed of ["won", "warning_closed", "prevented", "some_future_status"]) {
      assert.equal(readDisputes([{ status: closed }]).chargeback, false, closed);
      assert.equal(readDisputes([{ status: closed }]).inquiry, false, closed);
    }
  });

  test("a dispute event reads the disputes even before the charge says disputed", async () => {
    const { reads, calls } = fakeReads({ charge: { id: "ch_1", amount: 2000, feeRequested: true, feeId: "fee_1", disputed: false } });
    const { store, disputeReadings } = fakeStore(SALE);
    await reconcileChargeEvent({ ...INPUT, dispute: true }, reads, store);
    assert.ok(calls.includes("disputesForCharge"));
    assert.equal(disputeReadings.length, 1);
  });

  test("a refund event on an undisputed charge does not read disputes and leaves their state alone", async () => {
    const { reads, calls } = fakeReads();
    const { store, disputeReadings } = fakeStore(SALE);
    const out = await reconcileChargeEvent(INPUT, reads, store);
    assert.equal(calls.includes("disputesForCharge"), false);
    assert.equal(disputeReadings.length, 0, "not read is not 'no disputes' — never cleared from a non-read");
    assert.equal(out.kind === "applied" && out.dispute, null);
  });

  test("a refund event on a DISPUTED charge recomputes the dispute state too", async () => {
    const { reads } = fakeReads({ disputes: [{ status: "lost" }] });
    const { store, disputeReadings } = fakeStore(SALE);
    await reconcileChargeEvent(INPUT, reads, store);
    assert.equal(disputeReadings[0]?.chargeback, true);
  });

  test("a dispute read failure is a retry, and nothing is applied", async () => {
    const { reads } = fakeReads({ disputes: [{ status: "needs_response" }], throwOn: "disputesForCharge" });
    const { store, applied, disputeReadings } = fakeStore(SALE);
    const out = await reconcileChargeEvent({ ...INPUT, dispute: true }, reads, store);
    assert.equal(out.kind, "retry");
    assert.equal(applied.length + disputeReadings.length, 0);
  });

  test("a dispute on an organiser's own sale (no fee) is foreign", async () => {
    const out = await reconcileChargeEvent(
      { ...INPUT, dispute: true },
      fakeReads({ charge: { id: "ch_1", amount: 500, feeRequested: false, feeId: null, disputed: true } }).reads,
      fakeStore(undefined).store,
    );
    assert.equal(out.kind, "foreign");
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
