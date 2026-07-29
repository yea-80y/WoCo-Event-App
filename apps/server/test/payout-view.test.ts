/**
 * The organiser-facing payouts response (issue #93).
 *
 * This is the only place the platform tells an organiser where their money is,
 * so the failure modes are all "shows the wrong number about real money":
 *
 *   - a held amount presented as final, when a refund can still change it
 *   - a converted charge counted in a currency the account has no balance in
 *   - an early ceiling-forced release (PAYOUTS §3.1) rendered as a normal one
 *   - a summary tile that doesn't equal the rows beneath it
 *
 * The release mechanics themselves are covered by payout-release.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPayoutsResponse } from "../src/lib/stripe/payout-view.js";
import type { PayoutLedgerEntry } from "../src/lib/stripe/payout-ledger.js";

const ORG = "0xabcd000000000000000000000000000000000001";

function entry(over: Partial<PayoutLedgerEntry> = {}): PayoutLedgerEntry {
  return {
    sessionId: "cs_1",
    stripeAccountId: "acct_1",
    organiserAddress: ORG,
    kind: "event",
    eventId: "evt_a",
    currency: "gbp",
    grossAmount: 2500,
    netAmount: 2300,
    recordedAt: "2026-07-20T10:00:00.000Z",
    releaseAfter: "2026-08-10T10:00:00.000Z",
    status: "held",
    ...over,
  };
}

test("held money is never presented as final — a refund can still change it", () => {
  const res = buildPayoutsResponse([entry({ status: "held", netAmount: 2300 })]);
  assert.equal(res.entries[0].netIsFinal, false);
  assert.equal(res.entries[0].netAmount, 2300);
});

test("a released entry with a resolved net is final", () => {
  const res = buildPayoutsResponse([
    entry({ status: "released", netAmount: 2300, payoutId: "po_1", releasedAt: "2026-08-12T00:00:00.000Z" }),
  ]);
  assert.equal(res.entries[0].netIsFinal, true);
  assert.equal(res.entries[0].payoutId, "po_1");
});

test("a released entry whose net never resolved is NOT claimed as final", () => {
  const res = buildPayoutsResponse([entry({ status: "released", netAmount: undefined })]);
  assert.equal(res.entries[0].netIsFinal, false);
  assert.equal(res.entries[0].netAmount, null);
});

test("held totals key on the currency the funds actually settled in", () => {
  // Stripe converted a USD charge into the account's GBP balance: paying out of
  // a "usd" pot would poll a balance that does not exist.
  const res = buildPayoutsResponse([
    entry({ sessionId: "a", currency: "usd", settlementCurrency: "gbp", netAmount: 1800 }),
    entry({ sessionId: "b", currency: "gbp", netAmount: 2300 }),
  ]);
  assert.deepEqual(res.heldByCurrency, { gbp: 4100 });
  assert.equal(res.entries.find((e) => e.sessionId === "a")!.settlementCurrency, "gbp");
});

test("currencies are never added together", () => {
  const res = buildPayoutsResponse([
    entry({ sessionId: "a", currency: "gbp", netAmount: 1000 }),
    entry({ sessionId: "b", currency: "eur", netAmount: 2000 }),
  ]);
  assert.deepEqual(res.heldByCurrency, { gbp: 1000, eur: 2000 });
});

test("gross stands in for an unresolved net so held money is never shown as zero", () => {
  const res = buildPayoutsResponse([entry({ netAmount: undefined, grossAmount: 2500 })]);
  assert.deepEqual(res.heldByCurrency, { gbp: 2500 });
});

test("released and void entries are listed but held totals exclude them", () => {
  const res = buildPayoutsResponse([
    entry({ sessionId: "h", status: "held", netAmount: 1000 }),
    entry({ sessionId: "r", status: "released", netAmount: 2000 }),
    entry({ sessionId: "v", status: "void", netAmount: 4000, voidReason: "full refund" }),
  ]);
  assert.deepEqual(res.heldByCurrency, { gbp: 1000 });
  assert.equal(res.entries.length, 3);
  assert.equal(res.entries.find((e) => e.sessionId === "v")!.voidReason, "full refund");
});

test("the summary tile equals the sum of the held rows it stands for", () => {
  const entries = [
    entry({ sessionId: "a", netAmount: 1 }),
    entry({ sessionId: "b", netAmount: 2 }),
    entry({ sessionId: "c", netAmount: 3, status: "released" }),
  ];
  const res = buildPayoutsResponse(entries);
  const rowSum = res.entries
    .filter((e) => e.status === "held")
    .reduce((n, e) => n + (e.netAmount ?? e.grossAmount), 0);
  assert.equal(res.heldByCurrency.gbp, rowSum);
});

test("next release is the soonest held date, ignoring released and void entries", () => {
  const res = buildPayoutsResponse([
    entry({ sessionId: "late", releaseAfter: "2026-09-01T00:00:00.000Z" }),
    entry({ sessionId: "soon", releaseAfter: "2026-08-03T00:00:00.000Z" }),
    entry({ sessionId: "sooner-but-paid", releaseAfter: "2026-07-01T00:00:00.000Z", status: "released" }),
  ]);
  assert.equal(res.nextReleaseAt, "2026-08-03T00:00:00.000Z");
});

test("nothing held — no next release date, and an empty totals map", () => {
  const res = buildPayoutsResponse([entry({ status: "released" })]);
  assert.equal(res.nextReleaseAt, null);
  assert.deepEqual(res.heldByCurrency, {});

  const empty = buildPayoutsResponse([]);
  assert.equal(empty.nextReleaseAt, null);
  assert.deepEqual(empty.heldByCurrency, {});
  assert.deepEqual(empty.entries, []);
  assert.equal(empty.schedule, "manual");
});

test("a ceiling-forced release stays flagged — the exposed tail must be visible", () => {
  const res = buildPayoutsResponse([
    entry({ status: "released", forcedByCeiling: true, payoutId: "po_x" }),
    entry({ sessionId: "b", status: "released", payoutId: "po_y" }),
  ]);
  assert.equal(res.entries[0].forcedByCeiling, true);
  assert.equal(res.entries[1].forcedByCeiling, false);
});

test("shop orders carry their shopId so they can group under the shop", () => {
  const res = buildPayoutsResponse([
    entry({ kind: "shop", eventId: undefined, shopId: "shop_1", orderId: "ord_1" }),
  ]);
  assert.equal(res.entries[0].kind, "shop");
  assert.equal(res.entries[0].shopId, "shop_1");
  assert.equal(res.entries[0].eventId, undefined);
});
