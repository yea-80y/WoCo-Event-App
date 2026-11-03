/**
 * The Stripe side of referral earnings (#12, earnings-live.ts): which Stripe
 * fields become which facts. The real field names live here, so a mix-up (the
 * charge's refunds for the fee's) is caught here, not in the derivation tests.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { PayoutLedgerEntry } from "../src/lib/stripe/payout-ledger.js";

// Constructs the SDK client only; every call on it below is mocked.
process.env.STRIPE_SECRET_KEY = "sk_test_referral_earnings_never_sent";

const { liveEarningsReads } = await import("../src/lib/campaign/earnings-live.js");
const { getStripe } = await import("../src/lib/stripe/client.js");

const ACCT = "acct_referee";

function entry(over: Partial<PayoutLedgerEntry> = {}): PayoutLedgerEntry {
  return {
    sessionId: "cs_1",
    stripeAccountId: ACCT,
    organiserAddress: "0x" + "b2".repeat(20),
    kind: "event",
    currency: "gbp",
    grossAmount: 2000,
    paymentIntentId: "pi_1",
    applicationFeeId: "fee_1",
    recordedAt: "2026-11-10T12:00:00.000Z",
    releaseAfter: "2026-11-20T00:00:00.000Z",
    status: "released",
    ...over,
  };
}

function fee(over: Record<string, unknown> = {}, charge: Record<string, unknown> = {}) {
  return {
    id: "fee_1",
    amount: 30,
    amount_refunded: 10,
    currency: "gbp",
    account: ACCT,
    charge: { id: "ch_1", amount: 2000, amount_refunded: 500, disputed: false, ...charge },
    ...over,
  };
}

const disputes = (statuses: string[]) =>
  (async function* () {
    for (const status of statuses) yield { status };
  })();

test("the fee's own amount and refunds are the base; the charge's are only for the refund rule", async (t) => {
  const calls: unknown[][] = [];
  t.mock.method(getStripe().applicationFees, "retrieve", async (...args: unknown[]) => {
    calls.push(args);
    return fee();
  });
  const listed = t.mock.method(getStripe().disputes, "list", () => disputes([]));
  const read = await liveEarningsReads.sale(entry());
  assert.deepEqual(read, {
    status: "found",
    facts: {
      feeId: "fee_1",
      feeAmount: 30,
      feeRefunded: 10,
      currency: "gbp",
      account: ACCT,
      chargeAmount: 2000,
      chargeRefunded: 500,
      disputes: [],
    },
  });
  assert.deepEqual(calls, [["fee_1", { expand: ["charge"] }]], "read on the platform key, charge expanded");
  assert.equal(listed.mock.callCount(), 0, "no dispute list for a charge that has none");
});

test("a disputed charge's disputes are listed on the fee's connected account", async (t) => {
  t.mock.method(getStripe().applicationFees, "retrieve", async () => fee({}, { disputed: true }));
  const calls: unknown[][] = [];
  t.mock.method(getStripe().disputes, "list", (...args: unknown[]) => {
    calls.push(args);
    return disputes(["warning_closed", "lost"]);
  });
  const read = await liveEarningsReads.sale(entry());
  assert.equal(read.status, "found");
  assert.deepEqual(read.status === "found" && read.facts.disputes, ["warning_closed", "lost"]);
  assert.deepEqual(calls, [[{ charge: "ch_1", limit: 100 }, { stripeAccount: ACCT }]]);
});

test("an entry without a fee id finds it through the payment intent's latest charge", async (t) => {
  const piCalls: unknown[][] = [];
  t.mock.method(getStripe().paymentIntents, "retrieve", async (...args: unknown[]) => {
    piCalls.push(args);
    return { latest_charge: { id: "ch_1", amount: 2000, application_fee_amount: 30, application_fee: "fee_9", disputed: false, currency: "gbp" } };
  });
  const feeCalls: unknown[] = [];
  t.mock.method(getStripe().applicationFees, "retrieve", async (id: unknown) => {
    feeCalls.push(id);
    return fee({ id: "fee_9" });
  });
  const read = await liveEarningsReads.sale(entry({ applicationFeeId: undefined }));
  assert.equal(read.status, "found");
  assert.deepEqual(piCalls, [["pi_1", { expand: ["latest_charge"] }, { stripeAccount: ACCT }]]);
  assert.deepEqual(feeCalls, ["fee_9"]);
});

test("unreadable: no fee id and no payment intent, no fee on the charge, an unexpanded charge, a failed read", async (t) => {
  assert.equal((await liveEarningsReads.sale(entry({ applicationFeeId: undefined, paymentIntentId: undefined }))).status, "unavailable");

  t.mock.method(getStripe().paymentIntents, "retrieve", async () => ({
    latest_charge: { id: "ch_1", amount: 2000, application_fee_amount: 0, application_fee: null, disputed: false, currency: "gbp" },
  }));
  assert.equal((await liveEarningsReads.sale(entry({ applicationFeeId: undefined }))).status, "unavailable");

  const retrieve = t.mock.method(getStripe().applicationFees, "retrieve", async () => fee({ charge: "ch_1" }));
  assert.equal((await liveEarningsReads.sale(entry())).status, "unavailable");

  retrieve.mock.mockImplementation(async () => {
    throw Object.assign(new Error("down"), { name: "StripeConnectionError" });
  });
  assert.deepEqual(await liveEarningsReads.sale(entry()), { status: "unavailable", reason: "StripeConnectionError" });
});

test("an organiser payout's status is read on its connected account; anything unknown or failed reads unavailable", async (t) => {
  const calls: unknown[][] = [];
  let status: unknown = "paid";
  const retrieve = t.mock.method(getStripe().payouts, "retrieve", async (...args: unknown[]) => {
    calls.push(args);
    return { status };
  });
  assert.equal(await liveEarningsReads.payoutStatus("po_1", ACCT), "paid");
  assert.deepEqual(calls, [["po_1", {}, { stripeAccount: ACCT }]]);
  status = "in_transit";
  assert.equal(await liveEarningsReads.payoutStatus("po_1", ACCT), "in_transit");
  status = "something_new";
  assert.equal(await liveEarningsReads.payoutStatus("po_1", ACCT), "unavailable");
  retrieve.mock.mockImplementation(async () => {
    throw new Error("down");
  });
  assert.equal(await liveEarningsReads.payoutStatus("po_1", ACCT), "unavailable");
});
