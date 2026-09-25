/**
 * The ticket-sale record (#645 part C): what a refund voids, and when.
 *
 * The failure modes are a refunded ticket that still opens the door, a valid
 * ticket voided (the buyer paid and is turned away), fulfilment's own partial
 * refund mistaken for the organiser's, and a record file that cannot be read
 * being overwritten with a partial map. Each has a test.
 *
 * The store writes .data/ under process.cwd(), so the suite chdirs into a temp
 * dir BEFORE importing it.
 */

import { test, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let ts: typeof import("../src/lib/stripe/ticket-sales.js");
let storeFile: string;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "woco-ticket-sales-"));
  process.chdir(dir);
  mkdirSync(join(dir, ".data"), { recursive: true });
  storeFile = join(dir, ".data", "ticket-sales.json");
  ts = await import("../src/lib/stripe/ticket-sales.js");
});

beforeEach(() => {
  ts.__resetForTests();
  rmSync(storeFile, { force: true });
});

const EV = "0x" + "ab".repeat(32);
const OTHER_EV = "0x" + "cd".repeat(32);
const CONTRACT = "42161:0x" + "c1".repeat(20);

function stub(over: Partial<Parameters<typeof ts.recordSaleStub>[0]> = {}) {
  return ts.recordSaleStub({
    sessionId: "cs_1",
    paymentIntentId: "pi_1",
    connectedAccountId: "acct_1",
    eventId: "ev-1",
    seriesId: "se-1",
    quantity: 3,
    amountTotal: 3000,
    currency: "GBP",
    ...over,
  });
}

describe("recording", () => {
  test("a stub is idempotent and never resets slots fulfilment appended", () => {
    stub();
    ts.recordSaleSlots("cs_1", EV, CONTRACT, [4, 5]);
    stub({ quantity: 9 });
    const sale = ts.getSale("cs_1")!;
    assert.deepEqual(sale.slots, [4, 5]);
    assert.equal(sale.quantity, 3);
    assert.equal(sale.currency, "gbp");
    assert.equal(ts.getSaleByPaymentIntent("pi_1")?.sessionId, "cs_1");
  });

  test("slots accumulate per chunk, lowercase the event id, and refuse a chunk on another event", () => {
    stub();
    assert.equal(ts.recordSaleSlots("cs_1", EV.toUpperCase().replace("0X", "0x"), CONTRACT, [0, 1]), true);
    assert.equal(ts.recordSaleSlots("cs_1", EV, CONTRACT, [2]), true);
    assert.equal(ts.recordSaleSlots("cs_1", OTHER_EV, CONTRACT, [7]), false);
    const sale = ts.getSale("cs_1")!;
    assert.equal(sale.onChainEventId, EV);
    assert.deepEqual(sale.slots, [0, 1, 2]);
  });

  test("slots for a sale with no record are refused, not invented", () => {
    assert.equal(ts.recordSaleSlots("cs_missing", EV, CONTRACT, [0]), false);
    assert.equal(ts.getSale("cs_missing"), undefined);
  });

  test("autoRefunded only ever grows", () => {
    stub();
    ts.recordAutoRefund("cs_1", 1000);
    ts.recordAutoRefund("cs_1", 500);
    assert.equal(ts.getSale("cs_1")!.autoRefunded, 1000);
  });

  test("it persists and reloads, payment-intent index included", () => {
    stub();
    ts.recordSaleSlots("cs_1", EV, CONTRACT, [3]);
    ts.__resetForTests();
    assert.deepEqual(ts.getSaleByPaymentIntent("pi_1")?.slots, [3]);
    assert.ok(JSON.parse(readFileSync(storeFile, "utf-8")).cs_1);
  });
});

describe("applyRefundState", () => {
  test("a FULL refund voids every slot; a failed one lifts the void again", () => {
    stub();
    ts.recordSaleSlots("cs_1", EV, CONTRACT, [0, 1, 2]);
    const v = ts.applyRefundState("cs_1", 3000, 3000)!;
    assert.deepEqual(v, { voided: true, unvoided: false, partialAlarm: false });
    assert.deepEqual(ts.voidedSlots(EV), [0, 1, 2]);

    const again = ts.applyRefundState("cs_1", 3000, 3000)!;
    assert.equal(again.voided, false, "re-applying the same totals changes nothing");

    const lifted = ts.applyRefundState("cs_1", 0, 3000)!;
    assert.deepEqual(lifted, { voided: false, unvoided: true, partialAlarm: false });
    assert.deepEqual(ts.voidedSlots(EV), []);
    assert.equal(ts.getSale("cs_1")!.voids, undefined);
  });

  test("our own partial refund of the unfilled part is not the organiser's", () => {
    stub();
    ts.recordSaleSlots("cs_1", EV, CONTRACT, [0, 1]);
    ts.recordAutoRefund("cs_1", 1000);
    const r = ts.applyRefundState("cs_1", 1000, 3000)!;
    assert.deepEqual(r, { voided: false, unvoided: false, partialAlarm: false });
    assert.equal(ts.ticketSalesHealth().ok, true);
  });

  test("a partial refund above our own voids NOTHING, flags the sale and alarms", () => {
    stub();
    ts.recordSaleSlots("cs_1", EV, CONTRACT, [0, 1, 2]);
    const r = ts.applyRefundState("cs_1", 1000, 3000)!;
    assert.deepEqual(r, { voided: false, unvoided: false, partialAlarm: true });
    assert.deepEqual(ts.voidedSlots(EV), []);
    const h = ts.ticketSalesHealth();
    assert.equal(h.ok, false);
    assert.equal(h.partialRefunds, 1);
    assert.equal(ts.listFlaggedSales().length, 1);
  });

  test("acknowledging clears the alarm for that amount only; a larger one alarms again", () => {
    stub();
    ts.applyRefundState("cs_1", 1000, 3000);
    assert.equal(ts.acknowledgePartialRefund("cs_1", "ops"), true);
    assert.equal(ts.ticketSalesHealth().ok, true);
    ts.applyRefundState("cs_1", 1000, 3000);
    assert.equal(ts.ticketSalesHealth().ok, true, "the same amount stays acknowledged");
    ts.applyRefundState("cs_1", 2000, 3000);
    assert.equal(ts.ticketSalesHealth().ok, false, "a larger partial refund alarms again");
  });

  test("a partial refund that later completes becomes a void and drops the flag", () => {
    stub();
    ts.recordSaleSlots("cs_1", EV, CONTRACT, [0]);
    ts.applyRefundState("cs_1", 1000, 3000);
    const r = ts.applyRefundState("cs_1", 3000, 3000)!;
    assert.equal(r.voided, true);
    assert.equal(r.partialAlarm, false);
    assert.equal(ts.getSale("cs_1")!.partialRefund, undefined);
    assert.equal(ts.ticketSalesHealth().ok, true);
  });

  test("acknowledging a sale with no partial refund is refused", () => {
    stub();
    assert.equal(ts.acknowledgePartialRefund("cs_1", "ops"), false);
    assert.equal(ts.acknowledgePartialRefund("cs_none", "ops"), false);
  });

  test("an unknown session is not invented", () => {
    assert.equal(ts.applyRefundState("cs_none", 1, 1), null);
  });
});

describe("voidedSlots", () => {
  test("only void sales, only this event, narrowed by contract when both sides know it", () => {
    stub();
    ts.recordSaleSlots("cs_1", EV, CONTRACT, [0, 1]);
    stub({ sessionId: "cs_2", paymentIntentId: "pi_2" });
    ts.recordSaleSlots("cs_2", EV, CONTRACT, [2]);
    stub({ sessionId: "cs_3", paymentIntentId: "pi_3" });
    ts.recordSaleSlots("cs_3", OTHER_EV, CONTRACT, [0]);
    ts.applyRefundState("cs_1", 3000, 3000);
    ts.applyRefundState("cs_3", 3000, 3000);

    assert.deepEqual(ts.voidedSlots(EV), [0, 1], "cs_2 is paid for; cs_3 is another event");
    assert.deepEqual(ts.voidedSlots(EV.toUpperCase().replace("0X", "0x")), [0, 1]);
    assert.deepEqual(ts.voidedSlots(EV, CONTRACT), [0, 1]);
    assert.deepEqual(ts.voidedSlots(EV, "421614:0x" + "c2".repeat(20)), [], "a successor contract's slots are not these");
  });
});

describe("slotRefundStates (organiser orders view)", () => {
  test("refunded in full marks each slot refunded; a partial marks the order's slots partial", () => {
    stub();
    ts.recordSaleSlots("cs_1", EV, CONTRACT, [0, 1]);
    stub({ sessionId: "cs_2", paymentIntentId: "pi_2" });
    ts.recordSaleSlots("cs_2", EV, CONTRACT, [2, 3]);
    stub({ sessionId: "cs_3", paymentIntentId: "pi_3" });
    ts.recordSaleSlots("cs_3", EV, CONTRACT, [4]);
    ts.applyRefundState("cs_1", 3000, 3000);
    ts.applyRefundState("cs_2", 1000, 3000);

    const states = ts.slotRefundStates(EV, CONTRACT);
    assert.deepEqual(
      [...states.entries()].sort(([a], [b]) => a - b),
      [[0, "refunded"], [1, "refunded"], [2, "partial"], [3, "partial"]],
      "slot 4 was never refunded and carries no state",
    );
    assert.equal(ts.slotRefundStates(EV, "421614:0x" + "c2".repeat(20)).size, 0, "another contract's slots are not these");
    assert.equal(ts.slotRefundStates(OTHER_EV).size, 0);
  });
});

describe("a record file that cannot be read", () => {
  for (const [name, contents] of [
    ["truncated JSON", `{"cs_1": {"sessionId": "cs_1", "slo`],
    ["JSON null", "null"],
    ["a JSON array", "[]"],
  ] as const) {
    test(`${name}: never overwritten, alarmed, and new sales still work in memory`, () => {
      writeFileSync(storeFile, contents);
      stub();
      ts.recordSaleSlots("cs_1", EV, CONTRACT, [0]);
      ts.applyRefundState("cs_1", 3000, 3000);
      assert.equal(readFileSync(storeFile, "utf-8"), contents, "the unreadable file is left exactly as it was");
      assert.deepEqual(ts.voidedSlots(EV), [0], "this process still voids what it recorded since boot");
      const h = ts.ticketSalesHealth();
      assert.equal(h.fileUnreadable, true);
      assert.equal(h.ok, false);
    });
  }

  test("an ABSENT file is an ordinary first boot", () => {
    stub();
    assert.equal(ts.ticketSalesHealth().fileUnreadable, false);
    assert.equal(ts.ticketSalesHealth().ok, true);
    assert.ok(JSON.parse(readFileSync(storeFile, "utf-8")).cs_1);
  });
});
