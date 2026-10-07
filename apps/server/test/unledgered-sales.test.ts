/**
 * #805 — WoCo sales (our fee on the charge) with no payout-ledger row.
 *
 * Each one is money the release sweep would otherwise pay out as surplus, before
 * the event, while its buyer may have no ticket. The stores write .data/ under
 * process.cwd(), so the suite chdirs into a temp dir BEFORE importing them.
 */

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let unledgered: typeof import("../src/lib/stripe/unledgered-sales.js");
let ledger: typeof import("../src/lib/stripe/payout-ledger.js");
let sales: typeof import("../src/lib/stripe/ticket-sales.js");
let release: typeof import("../src/lib/stripe/payout-release.js");
let dataDir: string;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "woco-unledgered-test-"));
  process.chdir(dir);
  dataDir = join(dir, ".data");
  unledgered = await import("../src/lib/stripe/unledgered-sales.js");
  ledger = await import("../src/lib/stripe/payout-ledger.js");
  sales = await import("../src/lib/stripe/ticket-sales.js");
  release = await import("../src/lib/stripe/payout-release.js");
});

beforeEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  unledgered.__resetForTests();
  ledger.__resetForTests();
  sales.__resetForTests();
});

const ACCT = "acct_org_1";
const NOW = new Date("2026-10-07T12:00:00.000Z");
const nowSec = Math.floor(NOW.getTime() / 1000);
const DAY = 86_400;

type Fee = import("../src/lib/stripe/unledgered-sales.js").FeeCharge;

function fee(id: string, over: Partial<Fee> = {}): Fee {
  return {
    feeId: `fee_${id}`,
    account: ACCT,
    created: nowSec - 2 * 3600,
    chargeId: `ch_${id}`,
    paymentIntentId: `pi_${id}`,
    amount: 2_200,
    amountRefunded: 0,
    currency: "gbp",
    ...over,
  };
}

function fakeReads(fees: Fee[], opts: { failList?: boolean } = {}) {
  const listedSince: Array<number | null> = [];
  const byId: string[] = [];
  const reads: import("../src/lib/stripe/unledgered-sales.js").UnledgeredReads = {
    async *listFees(gte) {
      listedSince.push(gte);
      if (opts.failList) throw new Error("stripe down");
      for (const f of fees) if (gte === null || f.created >= gte) yield f;
    },
    async getFee(feeId) {
      byId.push(feeId);
      return fees.find((f) => f.feeId === feeId) ?? null;
    },
  };
  return { reads, listedSince, byId };
}

function ledgerRow(id: string) {
  ledger.recordHeld({
    sessionId: `cs_${id}`,
    stripeAccountId: ACCT,
    organiserAddress: "0xabc0000000000000000000000000000000000001",
    kind: "event",
    eventId: "ev1",
    currency: "gbp",
    grossAmount: 2_200,
    paymentIntentId: `pi_${id}`,
    releaseAfter: "2026-12-01T00:00:00.000Z",
  });
}

function stub(id: string, over: Partial<import("../src/lib/stripe/ticket-sales.js").SaleStubInput> = {}) {
  sales.recordSaleStub({
    sessionId: `cs_${id}`,
    paymentIntentId: `pi_${id}`,
    connectedAccountId: ACCT,
    quantity: 1,
    amountTotal: 2_200,
    currency: "gbp",
    ...over,
  });
}

const scan = (fees: Fee[], at: Date = NOW) =>
  unledgered.scanUnledgeredSales(fakeReads(fees).reads, unledgered.liveAccountedFor(), at);

test("our fee with no ledger row is open; a ledgered sale is not", async () => {
  ledgerRow("ok");
  const result = await scan([fee("ok"), fee("missed")]);
  assert.deepEqual([...result!], [[ACCT, 1]]);
  assert.deepEqual(unledgered.listOpenUnledgeredSales().map((s) => s.chargeId), ["ch_missed"]);
});

test("a released or voided ledger row still accounts for the sale", async () => {
  ledgerRow("paid");
  ledger.markManyReleased(["cs_paid"], "po_1");
  ledgerRow("void");
  ledger.markVoid("cs_void", "test");
  assert.equal((await scan([fee("paid"), fee("void")]))!.size, 0);
});

test("a sale inside the grace hour is not counted yet: the webhook is still recording it", async () => {
  const result = await scan([fee("fresh", { created: nowSec - 600 })]);
  assert.equal(result!.size, 0);
});

test("refunded in full is not open; a partial refund still is", async () => {
  const result = await scan([fee("full", { amountRefunded: 2_200 }), fee("part", { amountRefunded: 1_000 })]);
  assert.deepEqual(unledgered.listOpenUnledgeredSales().map((s) => s.chargeId), ["ch_part"]);
  assert.equal(result!.get(ACCT), 1);
});

test("a crash after consume (a sale stub, no ledger row) is open; a tampered or fully auto-refunded stub is not", async () => {
  stub("crashed");
  stub("tampered", { tampered: true, autoRefunded: 2_200 });
  stub("refunded");
  sales.recordAutoRefund("cs_refunded", 2_200);
  stub("partly");
  sales.recordAutoRefund("cs_partly", 1_100);
  await scan([fee("crashed"), fee("tampered"), fee("refunded"), fee("partly")]);
  assert.deepEqual(
    unledgered.listOpenUnledgeredSales().map((s) => s.chargeId).sort(),
    ["ch_crashed", "ch_partly"],
  );
});

test("a stub whose ledger row has no payment intent is matched through the session", async () => {
  stub("old");
  ledger.recordHeld({
    sessionId: "cs_old",
    stripeAccountId: ACCT,
    organiserAddress: "0xabc0000000000000000000000000000000000001",
    kind: "event",
    currency: "gbp",
    grossAmount: 2_200,
    releaseAfter: "2026-12-01T00:00:00.000Z",
  });
  assert.equal((await scan([fee("old")]))!.size, 0);
});

test("a charge with no payment intent cannot be matched, so it is open", async () => {
  assert.equal((await scan([fee("nopi", { paymentIntentId: null })]))!.get(ACCT), 1);
});

test("a failed listing returns null and keeps the open set it had", async () => {
  await scan([fee("missed")]);
  const failed = fakeReads([], { failList: true });
  assert.equal(await unledgered.scanUnledgeredSales(failed.reads, unledgered.liveAccountedFor(), NOW), null);
  assert.equal(unledgered.unledgeredSalesHealth().open, 1);
  assert.match(unledgered.unledgeredSalesHealth().lastError!, /stripe down/);
});

test("the next scan reads from the cursor minus two days; an older open sale is re-read by id until it is ledgered", async () => {
  const old = fee("old", { created: nowSec - 10 * DAY });
  const first = fakeReads([old]);
  await unledgered.scanUnledgeredSales(first.reads, unledgered.liveAccountedFor(), NOW);
  assert.deepEqual(first.listedSince, [null], "the first scan is a full one");

  const later = new Date(NOW.getTime() + 3600_000);
  const second = fakeReads([old]);
  await unledgered.scanUnledgeredSales(second.reads, unledgered.liveAccountedFor(), later);
  assert.deepEqual(second.listedSince, [nowSec - 2 * DAY]);
  assert.deepEqual(second.byId, ["fee_old"], "outside the window, so read by id");
  assert.equal(unledgered.unledgeredSalesHealth().open, 1);

  ledgerRow("old"); // a late fulfilment
  await unledgered.scanUnledgeredSales(fakeReads([old]).reads, unledgered.liveAccountedFor(), later);
  assert.equal(unledgered.unledgeredSalesHealth().open, 0);
});

test("the open set and the cursor survive a restart", async () => {
  await scan([fee("missed")]);
  unledgered.__resetForTests();
  assert.equal(unledgered.unledgeredSalesHealth().open, 1);
  const again = fakeReads([fee("missed")]);
  await unledgered.scanUnledgeredSales(again.reads, unledgered.liveAccountedFor(), NOW);
  assert.deepEqual(again.listedSince, [nowSec - 2 * DAY]);
});

test("an operator resolves an open sale: it stops counting, also after a rescan and a restart", async () => {
  await scan([fee("disputed")]);
  assert.equal(unledgered.resolveUnledgeredSale("ch_nope", "ops:test", "x"), null);
  const resolved = unledgered.resolveUnledgeredSale("ch_disputed", "ops:test", "chargeback lost, buyer whole");
  assert.equal(resolved?.account, ACCT);
  unledgered.__resetForTests();
  assert.equal((await scan([fee("disputed")]))!.size, 0);
});

test("payout health pages while a sale is open", async () => {
  assert.equal(release.payoutSweepHealth().unledgeredSales, 0);
  await scan([fee("missed")]);
  const h = release.payoutSweepHealth();
  assert.equal(h.unledgeredSales, 1);
  assert.equal(h.ok, false);
});

test("the live mapper reads an expanded fee, and refuses one whose charge is only an id", () => {
  const expanded = {
    id: "fee_1",
    account: "acct_x",
    created: 1_791_309_415,
    charge: { id: "ch_1", payment_intent: "pi_1", amount: 2_200, amount_refunded: 0, currency: "gbp" },
  };
  assert.deepEqual(unledgered.feeChargeFrom(expanded as never), {
    feeId: "fee_1",
    account: "acct_x",
    created: 1_791_309_415,
    chargeId: "ch_1",
    paymentIntentId: "pi_1",
    amount: 2_200,
    amountRefunded: 0,
    currency: "gbp",
  });
  assert.throws(() => unledgered.feeChargeFrom({ ...expanded, charge: "ch_1" } as never), /not expanded/);
});
