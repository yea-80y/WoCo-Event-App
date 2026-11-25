/**
 * Each account's first paid sale, the launch-rate clock (first-sales.ts). A
 * cache of our Stripe fees: every way it can be wrong must read as a LATER first
 * sale or none (the launch rate), never an earlier one (an overcharge). The
 * store writes .data/ under process.cwd(), so the suite chdirs into a temp dir
 * BEFORE importing it.
 */

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fs: typeof import("../src/lib/stripe/first-sales.js");
let ledger: typeof import("../src/lib/stripe/payout-ledger.js");
let release: typeof import("../src/lib/stripe/payout-release.js");
let dataDir: string;
let file: string;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "woco-first-sales-test-"));
  process.chdir(dir);
  dataDir = join(dir, ".data");
  file = join(dataDir, "stripe-first-sales.json");
  fs = await import("../src/lib/stripe/first-sales.js");
  ledger = await import("../src/lib/stripe/payout-ledger.js");
  release = await import("../src/lib/stripe/payout-release.js");
});

beforeEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  fs.__resetForTests();
  ledger.__resetForTests();
});

const A = "acct_a";
const B = "acct_b";
const DAY = 86_400;
const NOW = new Date("2026-12-10T12:00:00.000Z");
const nowSec = Math.floor(NOW.getTime() / 1000);
const later = (days: number) => new Date(NOW.getTime() + days * DAY * 1000);

type Fee = import("../src/lib/stripe/first-sales.js").FeeStart;

function fee(id: string, account: string, daysAgo: number, over: Partial<Fee> = {}): Fee {
  return { feeId: `fee_${id}`, account, created: nowSec - daysAgo * DAY, amount: 30, amountRefunded: 0, livemode: true, ...over };
}

function fakeReads(fees: Fee[], opts: { fail?: boolean } = {}) {
  const listedSince: Array<number | null> = [];
  const reads: import("../src/lib/stripe/first-sales.js").FirstSaleReads = {
    async *listFees(gte) {
      listedSince.push(gte);
      if (opts.fail) throw new Error("stripe down");
      for (const f of fees) if (gte === null || f.created >= gte) yield f;
    },
  };
  return { reads, listedSince };
}

const firstSale = (account: string) => fs.firstSaleAtMs(account, true);

test("the earliest kept fee per account is its first sale; returned fees and the other mode never count", async () => {
  const { reads, listedSince } = fakeReads([
    fee("a3", A, 1),
    fee("a1", A, 20, { amountRefunded: 30 }), // failed mint: whole fee returned
    fee("a2", A, 10),
    fee("b1", B, 5, { amountRefunded: 10 }), // a buyer refund we kept most of the fee on: still a sale
    fee("t1", A, 40, { livemode: false }), // a test-mode fee: not this server's world
  ]);
  assert.equal(await fs.scanFirstSales(reads, true, NOW), true);
  assert.deepEqual(listedSince, [null], "a first scan reads the whole list");
  assert.equal(firstSale(A), (nowSec - 10 * DAY) * 1000);
  assert.equal(firstSale(B), (nowSec - 5 * DAY) * 1000);
  assert.equal(firstSale("acct_none"), null);
});

test("an incremental scan reads from the last one, less two days, and keeps the earlier date", async () => {
  await fs.scanFirstSales(fakeReads([fee("a1", A, 10)]).reads, true, NOW);
  const next = fakeReads([fee("a1", A, 10), fee("a2", A, 0)]);
  await fs.scanFirstSales(next.reads, true, later(1));
  assert.deepEqual(next.listedSince, [nowSec - 2 * DAY]);
  assert.equal(firstSale(A), (nowSec - 10 * DAY) * 1000);
});

for (const order of ["oldest first", "newest first"] as const) {
  test(`returned in full inside the window: not started until the next, full, scan (${order})`, async () => {
    const list = (fees: Fee[]) => (order === "newest first" ? [...fees].reverse() : fees);
    await fs.scanFirstSales(fakeReads(list([fee("a1", A, 1), fee("a2", A, 0.5)])).reads, true, NOW);
    assert.equal(firstSale(A), (nowSec - 1 * DAY) * 1000);
    await fs.scanFirstSales(fakeReads(list([fee("a1", A, 1, { amountRefunded: 30 }), fee("a2", A, 0.5)])).reads, true, later(0.04));
    // Only a full read can say what is earliest now, so nothing is adopted meanwhile.
    assert.equal(firstSale(A), null, "the launch rate, never a guess");
    const full = fakeReads(list([fee("a1", A, 1, { amountRefunded: 30 }), fee("a2", A, 0.5)]));
    await fs.scanFirstSales(full.reads, true, later(0.08));
    assert.deepEqual(full.listedSince, [null]);
    assert.equal(firstSale(A), (nowSec - 0.5 * DAY) * 1000);
  });
}

test("once a week the map is rebuilt from the whole list and replaced, not merged", async () => {
  await fs.scanFirstSales(fakeReads([fee("a1", A, 1)]).reads, true, NOW);
  const weekly = fakeReads([fee("a1", A, 1, { amountRefunded: 30 })]);
  await fs.scanFirstSales(weekly.reads, true, later(7));
  assert.deepEqual(weekly.listedSince, [null]);
  assert.equal(firstSale(A), null);
});

test("a failed read keeps the last complete scan and writes nothing", async () => {
  await fs.scanFirstSales(fakeReads([fee("a1", A, 1)]).reads, true, NOW);
  const before = readFileSync(file, "utf-8");
  assert.equal(await fs.scanFirstSales(fakeReads([], { fail: true }).reads, true, later(1)), false);
  assert.equal(readFileSync(file, "utf-8"), before);
  assert.equal(firstSale(A), (nowSec - 1 * DAY) * 1000);
  assert.match(fs.firstSalesHealth(false, later(1), true).lastError!, /stripe down/);
});

test("a key mode that cannot be judged reads nothing and keeps nothing", async () => {
  const r = fakeReads([fee("a1", A, 1)]);
  assert.equal(await fs.scanFirstSales(r.reads, null, NOW), false);
  assert.deepEqual(r.listedSince, []);
  assert.equal(fs.firstSaleAtMs(A, null), null);
  assert.equal(fs.currentLivemode("sk_live_x"), true);
  assert.equal(fs.currentLivemode("rk_test_x"), false);
  assert.equal(fs.currentLivemode(undefined), null);
});

test("a file from the other key mode, an unreadable one or the wrong shape reads as empty and is rebuilt in full", async () => {
  await fs.scanFirstSales(fakeReads([fee("a1", A, 1)]).reads, true, NOW);
  fs.__resetForTests();
  assert.equal(fs.firstSaleAtMs(A, false), null, "a live file is not a test server's");

  for (const body of ["{not json", JSON.stringify({ livemode: true, cursor: 1, accounts: {} })]) {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, body);
    fs.__resetForTests();
    assert.equal(firstSale(A), null);
    const r = fakeReads([fee("a1", A, 1)]);
    await fs.scanFirstSales(r.reads, true, NOW);
    assert.deepEqual(r.listedSince, [null]);
    assert.equal(firstSale(A), (nowSec - 1 * DAY) * 1000);
  }
});

test("the map survives a restart", async () => {
  await fs.scanFirstSales(fakeReads([fee("a1", A, 1)]).reads, true, NOW);
  fs.__resetForTests();
  assert.equal(firstSale(A), (nowSec - 1 * DAY) * 1000);
  const r = fakeReads([]);
  await fs.scanFirstSales(r.reads, true, later(1));
  assert.deepEqual(r.listedSince, [nowSec - 2 * DAY], "a restart does not force a full rebuild");
});

test("health: stale after a day without a scan, overdue after 8 days without a full one, only while the sweep runs", async () => {
  await fs.scanFirstSales(fakeReads([fee("a1", A, 1)]).reads, true, NOW);
  assert.equal(fs.firstSalesHealth(true, later(0.5), true).ok, true);
  const stale = fs.firstSalesHealth(true, later(1.1), true);
  assert.equal(stale.stale, true);
  assert.equal(stale.ok, false);
  assert.equal(fs.firstSalesHealth(false, later(1.1), true).ok, true, "no sweep, no alarm");
  // Incremental scans every day, but no full rebuild for 8 days.
  for (let d = 1; d <= 6; d++) await fs.scanFirstSales(fakeReads([]).reads, true, later(d));
  await fs.scanFirstSales(fakeReads([fee("a1", A, 1)]).reads, true, later(7)); // the weekly full
  for (let d = 8; d <= 13; d++) await fs.scanFirstSales(fakeReads([]).reads, true, later(d));
  assert.equal(fs.firstSalesHealth(true, later(13.1), true).fullOverdue, false);
  assert.equal(firstSale(A), (nowSec - 1 * DAY) * 1000);
  // Incremental scans alone for over 8 days (every full read failing) is overdue.
  assert.equal(fs.firstSalesHealth(true, later(15.1), true).fullOverdue, true);
});

test("health: a ledgered sale over a day old with no first sale on record is one the scan missed", async () => {
  const row = (sessionId: string, account: string, recordedAt: string, over = {}) =>
    ledger.recordHeld({
      sessionId,
      stripeAccountId: account,
      organiserAddress: "0x1111111111111111111111111111111111111111",
      kind: "event",
      eventId: "ev1",
      currency: "gbp",
      grossAmount: 2_000,
      applicationFeeId: `fee_${sessionId}`,
      recordedAt,
      releaseAfter: "2027-01-01T00:00:00.000Z",
      ...over,
    });
  // Before any scan there is no map to compare with: nothing is counted.
  row("s1", B, "2026-12-01T00:00:00.000Z");
  assert.equal(fs.firstSalesHealth(true, NOW, true).uncovered, 0);
  await fs.scanFirstSales(fakeReads([fee("a1", A, 1)]).reads, true, NOW);
  assert.equal(fs.firstSalesHealth(true, NOW, true).uncovered, 1);
  assert.equal(fs.firstSalesHealth(true, NOW, true).ok, false);
  // Young rows and rows that name no fee of ours are not counted.
  ledger.__resetForTests();
  rmSync(join(dataDir, "stripe-payout-ledger.json"), { force: true });
  row("s2", B, new Date(NOW.getTime() - 3_600_000).toISOString());
  row("s3", B, "2026-12-01T00:00:00.000Z", { applicationFeeId: undefined });
  row("s4", A, "2026-12-01T00:00:00.000Z");
  assert.equal(fs.firstSalesHealth(true, NOW, true).uncovered, 0);
});

test("the payout sweep runs the scan, and a scan that throws never stops the sweep", async () => {
  let calls = 0;
  const gateway: import("../src/lib/stripe/payout-release.js").PayoutGateway = {
    async resolveNet() { return null; },
    async balance() { return null; },
    async createPayout() { throw new Error("no payouts here"); },
    async findPayoutByIntent() { return { payoutId: null }; },
    async accountCountry() { return undefined; },
    async firstSales() { calls++; throw new Error("boom"); },
  };
  await release.runReleaseSweep(gateway, NOW);
  assert.equal(calls, 1);
});

test("the live mapper reads a fee's own amount, refund, mode and account", () => {
  const mapped = fs.feeStartFrom({
    id: "fee_1",
    account: "acct_x",
    created: 1_796_000_000,
    amount: 18,
    amount_refunded: 18,
    livemode: true,
  } as unknown as import("stripe").Stripe.ApplicationFee);
  assert.deepEqual(mapped, { feeId: "fee_1", account: "acct_x", created: 1_796_000_000, amount: 18, amountRefunded: 18, livemode: true });
});
