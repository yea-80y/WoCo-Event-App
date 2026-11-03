/**
 * Referral earnings (#12, ToS §9): the derivation and the payout record, with
 * every Stripe and Swarm read faked. The rules are pinned one per test so a
 * change to any of them turns exactly one red.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { REFERRAL_CONFIRMATION_FORMAT, referralShareBp, type ReferralConfirmationV1 } from "@woco/shared";
import {
  computeReferralEarnings,
  recordReferralPayout,
  type EarningsReads,
  type PayoutStatus,
  type SaleFacts,
  type SaleRead,
} from "../src/lib/campaign/earnings.js";
import type { JournalEntry, PayoutRecord, WithholdRecord } from "../src/lib/campaign/earnings-journal.js";
import type { RecordRead } from "../src/lib/campaign/issuer.js";
import type { PayoutLedgerEntry } from "../src/lib/stripe/payout-ledger.js";

const NOW = new Date("2026-12-20T00:00:00.000Z");
const REFERRER = "0x" + "a1".repeat(20);
const REFEREE = "0x" + "b2".repeat(20);
const OTHER_REFEREE = "0x" + "c3".repeat(20);
const ACCT = "acct_referee";
const CONFIRMED_AT = "2026-11-01T00:00:00.000Z";
const TX = (n: number) => "0x" + n.toString(16).padStart(64, "0");

function confirmation(referee = REFEREE, referrer = REFERRER, confirmedAt = CONFIRMED_AT): ReferralConfirmationV1 {
  return { confirmedAt, format: REFERRAL_CONFIRMATION_FORMAT, referee, referrer, refereeFeed: "0x" + "d4".repeat(20) } as ReferralConfirmationV1;
}

function entry(over: Partial<PayoutLedgerEntry> = {}): PayoutLedgerEntry {
  return {
    sessionId: "cs_1",
    stripeAccountId: ACCT,
    organiserAddress: REFEREE,
    kind: "event",
    eventId: "ev_1",
    currency: "gbp",
    grossAmount: 2000,
    paymentIntentId: "pi_1",
    applicationFeeId: "fee_1",
    netAmount: 1900,
    recordedAt: "2026-11-10T12:00:00.000Z",
    releaseAfter: "2026-11-20T00:00:00.000Z",
    status: "released",
    payoutId: "po_1",
    releasedAt: "2026-11-21T00:00:00.000Z",
    ...over,
  };
}

function facts(over: Partial<SaleFacts> = {}): SaleFacts {
  return {
    feeId: "fee_1",
    feeAmount: 30,
    feeRefunded: 0,
    currency: "gbp",
    account: ACCT,
    chargeAmount: 2000,
    chargeRefunded: 0,
    disputes: [],
    ...over,
  };
}

interface FakeOpts {
  entries?: PayoutLedgerEntry[];
  confirmations?: Record<string, RecordRead<ReferralConfirmationV1>>;
  /** By session id; default `facts()` with that session's fee id. */
  sales?: Record<string, SaleRead>;
  payouts?: Record<string, PayoutStatus>;
  journal?: JournalEntry[];
  journalReadable?: boolean;
  shareBp?: (referrer: string, saleAt: string) => number;
}

function fake(o: FakeOpts = {}) {
  const journal: JournalEntry[] = [...(o.journal ?? [])];
  const counts = { sale: 0, payout: 0, confirmation: 0 };
  const reads: EarningsReads = {
    entries: () => o.entries ?? [entry()],
    journal: () => journal,
    journalReadable: () => o.journalReadable ?? true,
    async confirmation(organiser) {
      counts.confirmation++;
      return o.confirmations?.[organiser] ?? (organiser === REFEREE ? { status: "found", record: confirmation() } : { status: "absent" });
    },
    async sale(e) {
      counts.sale++;
      return o.sales?.[e.sessionId] ?? { status: "found", facts: facts({ feeId: e.applicationFeeId ?? "fee_x" }) };
    },
    async payoutStatus(payoutId) {
      counts.payout++;
      return o.payouts?.[payoutId] ?? "paid";
    },
    ...(o.shareBp ? { shareBp: o.shareBp } : {}),
  };
  let ids = 0;
  return {
    reads,
    journal,
    counts,
    append: (e: JournalEntry) => {
      journal.push(e);
      return true;
    },
    newId: () => `rp_${++ids}`,
  };
}

async function statementFor(o: FakeOpts = {}) {
  return computeReferralEarnings(fake(o).reads, NOW);
}

async function lineFor(o: FakeOpts = {}, sessionId = "cs_1") {
  const s = await statementFor(o);
  return s.referrers.flatMap((r) => r.lines).find((l) => l.sessionId === sessionId);
}

describe("the base is the fee WoCo kept, never the charge", () => {
  test("fee 30p on a £20 charge earns 40% of 30p (12p), not of £20", async () => {
    const s = await statementFor();
    assert.equal(s.referrers.length, 1);
    const r = s.referrers[0];
    assert.equal(r.referrer, REFERRER);
    assert.equal(r.payableNumerator, 30 * 4000);
    assert.equal(r.dueMinor, 12);
  });

  test("a fee partly returned earns on what was kept; a fee returned in full earns nothing", async () => {
    const part = await lineFor({ sales: { cs_1: { status: "found", facts: facts({ feeRefunded: 10 }) } } });
    assert.equal(part?.state, "payable");
    assert.equal(part?.numerator, 20 * 4000);
    const all = await lineFor({ sales: { cs_1: { status: "found", facts: facts({ feeRefunded: 30 }) } } });
    assert.equal(all?.state, "zero");
    assert.equal(all?.numerator, 0);
  });
});

describe("which sales earn", () => {
  test("a sale made before the referral was confirmed earns nothing; one made at the instant does", async () => {
    const before = new Date(Date.parse(CONFIRMED_AT) - 1).toISOString();
    assert.equal(await lineFor({ entries: [entry({ recordedAt: before })] }), undefined);
    assert.equal((await lineFor({ entries: [entry({ recordedAt: CONFIRMED_AT })] }))?.state, "payable");
  });

  test("an organiser nobody referred earns nobody anything", async () => {
    const s = await statementFor({ entries: [entry({ organiserAddress: OTHER_REFEREE })] });
    assert.deepEqual(s.referrers, []);
  });

  test("a confirmation that cannot be read is flagged, never read as 'not referred' and never guessed", async () => {
    const f = fake({ confirmations: { [REFEREE]: { status: "unavailable" } } });
    const s = await computeReferralEarnings(f.reads, NOW);
    assert.deepEqual(s.referrers, []);
    assert.deepEqual(s.diagnostics.confirmationsUnavailable, [REFEREE]);
  });

  test("only ticket sales earn: shop orders and reconciliation rows never appear", async () => {
    const s = await statementFor({
      entries: [entry({ sessionId: "cs_shop", kind: "shop" }), entry({ sessionId: "cs_recon", kind: "reconciliation" })],
    });
    assert.deepEqual(s.referrers, []);
  });

  test("a sale with no organiser address is reported as unattributed", async () => {
    const s = await statementFor({ entries: [entry({ organiserAddress: "" })] });
    assert.deepEqual(s.referrers, []);
    assert.deepEqual(s.diagnostics.unattributedSales, ["cs_1"]);
  });

  test("each organiser's confirmation is read once per run", async () => {
    const f = fake({ entries: [entry(), entry({ sessionId: "cs_2" }), entry({ sessionId: "cs_3" })] });
    await computeReferralEarnings(f.reads, NOW);
    assert.equal(f.counts.confirmation, 1);
  });
});

describe("payable only once the event is over and the organiser is paid", () => {
  test("held: pending", async () => {
    const l = await lineFor({ entries: [entry({ status: "held", payoutId: undefined, releasedAt: undefined })] });
    assert.equal(l?.state, "pending");
    assert.equal(l?.numerator, 30 * 4000, "pending shows what it will earn");
  });

  test("void: zero", async () => {
    assert.equal((await lineFor({ entries: [entry({ status: "void", voidReason: "refunded" })] }))?.state, "zero");
  });

  test("released before the event by the hold ceiling: pending until the event is over", async () => {
    const l = await lineFor({ entries: [entry({ releaseAfter: "2026-12-25T00:00:00.000Z", forcedByCeiling: true })] });
    assert.equal(l?.state, "pending");
    assert.equal(l?.reason, "event not over");
  });

  test("no event date (the 14-day fallback release): pending, never assumed over", async () => {
    const recordedAt = "2026-11-10T12:00:00.000Z";
    const releaseAfter = new Date(Date.parse(recordedAt) + 14 * 86_400_000).toISOString();
    const l = await lineFor({ entries: [entry({ recordedAt, releaseAfter })] });
    assert.equal(l?.state, "pending");
    assert.match(l?.reason ?? "", /event date unknown/);
  });

  for (const status of ["pending", "in_transit", "unavailable"] as const) {
    test(`organiser payout ${status}: pending`, async () => {
      assert.equal((await lineFor({ payouts: { po_1: status } }))?.state, "pending");
    });
  }

  for (const status of ["failed", "canceled"] as const) {
    test(`organiser payout ${status}: pending and flagged`, async () => {
      const s = await statementFor({ payouts: { po_1: status } });
      assert.equal(s.referrers[0].lines[0].state, "pending");
      assert.deepEqual(s.diagnostics.failedPayouts, ["po_1"]);
    });
  }

  test("each organiser payout is read once, however many sales it carried", async () => {
    const f = fake({ entries: [entry(), entry({ sessionId: "cs_2" })] });
    await computeReferralEarnings(f.reads, NOW);
    assert.equal(f.counts.payout, 1);
  });

  test("released as a debt (net below zero): zero; net not resolved yet: pending", async () => {
    assert.equal((await lineFor({ entries: [entry({ netAmount: -100 })] }))?.state, "zero");
    assert.equal((await lineFor({ entries: [entry({ netAmount: undefined })] }))?.state, "pending");
  });
});

describe("refunds and disputes (owner 2026-11-03: a reversed sale earns nothing)", () => {
  test("refunded in full with the fee kept: zero", async () => {
    const l = await lineFor({ sales: { cs_1: { status: "found", facts: facts({ chargeRefunded: 2000 }) } } });
    assert.equal(l?.state, "zero");
  });

  test("refunded in part with the fee kept: the full fee still earns", async () => {
    const l = await lineFor({ sales: { cs_1: { status: "found", facts: facts({ chargeRefunded: 500 }) } } });
    assert.equal(l?.state, "payable");
    assert.equal(l?.numerator, 30 * 4000);
  });

  for (const status of ["needs_response", "under_review", "warning_needs_response", "warning_under_review"]) {
    test(`dispute ${status}: pending, not zero`, async () => {
      const l = await lineFor({ sales: { cs_1: { status: "found", facts: facts({ disputes: [status] }) } } });
      assert.equal(l?.state, "pending");
      assert.equal(l?.reason, "dispute open");
    });
  }

  test("chargeback lost: zero", async () => {
    assert.equal((await lineFor({ sales: { cs_1: { status: "found", facts: facts({ disputes: ["lost"] }) } } }))?.state, "zero");
  });

  test("dispute won: earns", async () => {
    assert.equal((await lineFor({ sales: { cs_1: { status: "found", facts: facts({ disputes: ["won"] }) } } }))?.state, "payable");
  });

  test("Stripe facts unreadable, or the fee on another account: pending and flagged", async () => {
    const s = await statementFor({ sales: { cs_1: { status: "unavailable", reason: "StripeConnectionError" } } });
    assert.equal(s.referrers[0].lines[0].state, "pending");
    assert.deepEqual(s.diagnostics.unreadableSales, ["cs_1"]);
    const t = await statementFor({ sales: { cs_1: { status: "found", facts: facts({ account: "acct_other" }) } } });
    assert.equal(t.referrers[0].lines[0].state, "pending");
    assert.deepEqual(t.diagnostics.unreadableSales, ["cs_1"]);
  });
});

describe("the rate is the one in force on the sale date", () => {
  const SCHEDULE = [
    { from: "2026-10-23T00:00:00.000Z", bp: 4000 },
    { from: "2026-11-15T00:00:00.000Z", bp: 2000 },
  ];

  test("referralShareBp: 0 before the first entry, each entry from its own date", () => {
    assert.equal(referralShareBp("2026-10-22T23:59:59.999Z", SCHEDULE), 0);
    assert.equal(referralShareBp("2026-10-23T00:00:00.000Z", SCHEDULE), 4000);
    assert.equal(referralShareBp("2026-11-14T23:59:59.999Z", SCHEDULE), 4000);
    assert.equal(referralShareBp("2026-11-15T00:00:00.000Z", SCHEDULE), 2000);
    assert.equal(referralShareBp("not a date", SCHEDULE), 0);
  });

  test("a change dated after a sale does not touch that sale", async () => {
    const s = await statementFor({
      entries: [entry({ sessionId: "cs_old" }), entry({ sessionId: "cs_new", recordedAt: "2026-11-16T00:00:00.000Z" })],
      shareBp: (_r, saleAt) => referralShareBp(saleAt, SCHEDULE),
    });
    const lines = s.referrers[0].lines;
    assert.equal(lines.find((l) => l.sessionId === "cs_old")?.bp, 4000);
    assert.equal(lines.find((l) => l.sessionId === "cs_new")?.bp, 2000);
  });

  test("a sale made before the scheme's first rate earns nothing and is not listed", async () => {
    const s = await statementFor({
      confirmations: { [REFEREE]: { status: "found", record: confirmation(REFEREE, REFERRER, "2026-10-01T00:00:00.000Z") } },
      entries: [entry({ recordedAt: "2026-10-20T00:00:00.000Z" })],
    });
    assert.deepEqual(s.referrers, []);
  });

  test("the live schedule is the launch rate, 40%, from launch day", () => {
    assert.equal(referralShareBp("2026-10-23T00:00:00.000Z"), 4000);
    assert.equal(referralShareBp("2026-10-22T23:59:59.999Z"), 0);
  });
});

describe("rounding: exact per sale, rounded down once per payout", () => {
  test("three 1p fees: nothing due after one, 1p after three", async () => {
    const one = await statementFor({ sales: { cs_1: { status: "found", facts: facts({ feeAmount: 1 }) } } });
    assert.equal(one.referrers[0].owedNumerator, 4000);
    assert.equal(one.referrers[0].dueMinor, 0, "a per-sale floor would lose it; it stays owed");
    const sales = Object.fromEntries(["cs_1", "cs_2", "cs_3"].map((id) => [id, { status: "found", facts: facts({ feeAmount: 1 }) } as SaleRead]));
    const three = await statementFor({
      entries: ["cs_1", "cs_2", "cs_3"].map((sessionId) => entry({ sessionId })),
      sales,
    });
    assert.equal(three.referrers[0].dueMinor, 1);
    assert.equal(three.referrers[0].owedNumerator, 12000);
  });

  test("the remainder left by a payout stays owed", async () => {
    // 30p fee -> 12p owed exactly; 33p fee -> 13.2p: pay 13, 0.2p carried.
    const f = fake({ sales: { cs_1: { status: "found", facts: facts({ feeAmount: 33 }) } } });
    const before = await computeReferralEarnings(f.reads, NOW);
    assert.equal(before.referrers[0].dueMinor, 13);
    const paid = await recordReferralPayout(payoutInput({ amountMinor: 13 }), { ...f, now: () => NOW });
    assert.equal(paid.ok, true);
    const after = await computeReferralEarnings(f.reads, NOW);
    assert.equal(after.referrers[0].owedNumerator, 2000);
    assert.equal(after.referrers[0].dueMinor, 0);
  });
});

describe("withholds (ToS §9: self-referral, fraud, a breach)", () => {
  function withhold(scope: WithholdRecord["scope"], key: string, id = "rw_1"): WithholdRecord {
    return { kind: "withhold", id, scope, key, reason: "test", by: "ops", at: "2026-12-01T00:00:00.000Z" };
  }
  const TWO = [entry(), entry({ sessionId: "cs_2", organiserAddress: OTHER_REFEREE })];
  const BOTH_REFERRED = {
    [REFEREE]: { status: "found", record: confirmation() },
    [OTHER_REFEREE]: { status: "found", record: confirmation(OTHER_REFEREE) },
  } as Record<string, RecordRead<ReferralConfirmationV1>>;

  test("referrer scope holds all of that referrer's earnings, visible as withheld", async () => {
    const s = await statementFor({ entries: TWO, confirmations: BOTH_REFERRED, journal: [withhold("referrer", REFERRER)] });
    const r = s.referrers[0];
    assert.equal(r.payableNumerator, 0);
    assert.equal(r.withheldNumerator, 2 * 30 * 4000);
    assert.equal(r.dueMinor, 0);
  });

  test("referee scope holds only that organiser's sales", async () => {
    const s = await statementFor({ entries: TWO, confirmations: BOTH_REFERRED, journal: [withhold("referee", OTHER_REFEREE)] });
    const lines = s.referrers[0].lines;
    assert.equal(lines.find((l) => l.sessionId === "cs_1")?.state, "payable");
    assert.equal(lines.find((l) => l.sessionId === "cs_2")?.state, "withheld");
  });

  test("sale scope holds one sale", async () => {
    const s = await statementFor({ entries: TWO, confirmations: BOTH_REFERRED, journal: [withhold("sale", "cs_1")] });
    const lines = s.referrers[0].lines;
    assert.equal(lines.find((l) => l.sessionId === "cs_1")?.state, "withheld");
    assert.equal(lines.find((l) => l.sessionId === "cs_2")?.state, "payable");
  });

  test("a lift restores what the withhold held", async () => {
    const s = await statementFor({
      journal: [withhold("referrer", REFERRER), { kind: "lift", id: "rl_1", withholdId: "rw_1", reason: "cleared", by: "ops", at: "2026-12-02T00:00:00.000Z" }],
    });
    assert.equal(s.referrers[0].lines[0].state, "payable");
  });
});

function payoutInput(over: Partial<Parameters<typeof recordReferralPayout>[0]> = {}): Parameters<typeof recordReferralPayout>[0] {
  return {
    referrer: REFERRER,
    currency: "gbp",
    amountMinor: 12,
    network: "arbitrum-one",
    asset: "USDC",
    sentAmount: "0.15",
    fxRate: "1.25",
    txHash: TX(1),
    by: "ops:test",
    ...over,
  };
}

describe("recording a payout", () => {
  test("records what is due, frozen from the server's own statement, to the referrer's own address", async () => {
    const f = fake();
    const r = await recordReferralPayout(payoutInput(), { ...f, now: () => NOW });
    assert.equal(r.ok, true);
    const rec = (r as { ok: true; record: PayoutRecord }).record;
    assert.equal(rec.amountMinor, 12);
    assert.equal(rec.toAddress, REFERRER);
    assert.deepEqual(rec.lines, [{ sessionId: "cs_1", feeId: "fee_1", numerator: 120000, feeKept: 30, bp: 4000 }]);
    assert.equal(f.journal.length, 1);
    const after = await computeReferralEarnings(f.reads, NOW);
    assert.equal(after.referrers[0].dueMinor, 0, "paid once, owed nothing more");
  });

  test("the frozen lines are the payable ones only - a pending sale is not settled by it", async () => {
    const f = fake({ entries: [entry(), entry({ sessionId: "cs_held", applicationFeeId: "fee_held", status: "held" })] });
    const r = await recordReferralPayout(payoutInput(), { ...f, now: () => NOW });
    assert.deepEqual(
      (r as { ok: true; record: PayoutRecord }).record.lines.map((l) => l.sessionId),
      ["cs_1"],
    );
  });

  test("an amount other than what is due now is refused, and nothing is written", async () => {
    const f = fake();
    const r = await recordReferralPayout(payoutInput({ amountMinor: 13 }), { ...f, now: () => NOW });
    assert.deepEqual(r, { ok: false, status: 409, error: "Amount differs from what is due now (12)" });
    assert.equal(f.journal.length, 0);
  });

  test("the same transaction cannot be recorded twice", async () => {
    const f = fake();
    await recordReferralPayout(payoutInput(), { ...f, now: () => NOW });
    const again = await recordReferralPayout(payoutInput({ txHash: TX(1).replace("0x", "0X") }), { ...f, now: () => NOW });
    assert.deepEqual(again, { ok: false, status: 409, error: "A payout with that transaction is already recorded" });
    assert.equal(f.journal.length, 1);
  });

  test("nothing due: refused", async () => {
    const f = fake({ entries: [entry({ status: "held" })] });
    const r = await recordReferralPayout(payoutInput(), { ...f, now: () => NOW });
    assert.deepEqual(r, { ok: false, status: 409, error: "Nothing is due to that referrer in that currency" });
  });

  test("an unreadable journal refuses every payout (it would forget the ones made)", async () => {
    const f = fake({ journalReadable: false });
    const r = await recordReferralPayout(payoutInput(), { ...f, now: () => NOW });
    assert.equal(r.ok, false);
    assert.equal((r as { status: number }).status, 503);
    assert.equal(f.journal.length, 0);
  });

  test("a write that fails reports it", async () => {
    const f = fake();
    const r = await recordReferralPayout(payoutInput(), { ...f, append: () => false, now: () => NOW });
    assert.equal((r as { status: number }).status, 503);
  });

  test("two payouts at once cannot both settle the same balance", async () => {
    const f = fake();
    const [a, b] = await Promise.all([
      recordReferralPayout(payoutInput({ txHash: TX(1) }), { ...f, now: () => NOW }),
      recordReferralPayout(payoutInput({ txHash: TX(2) }), { ...f, now: () => NOW }),
    ]);
    assert.equal([a, b].filter((r) => r.ok).length, 1);
    assert.equal(f.journal.length, 1);
  });

  test("a sale reversed after it was paid leaves a negative balance, netted against later earnings", async () => {
    const paid: PayoutRecord = {
      kind: "payout",
      id: "rp_0",
      referrer: REFERRER,
      currency: "gbp",
      amountMinor: 12,
      toAddress: REFERRER,
      network: "arbitrum-one",
      asset: "USDC",
      sentAmount: "0.15",
      txHash: TX(9),
      paidAt: "2026-12-01T00:00:00.000Z",
      recordedAt: "2026-12-01T00:00:00.000Z",
      by: "ops",
      lines: [{ sessionId: "cs_1", feeId: "fee_1", numerator: 120000, feeKept: 30, bp: 4000 }],
    };
    const reversed = { cs_1: { status: "found", facts: facts({ disputes: ["lost"] }) } as SaleRead };
    const alone = await statementFor({ journal: [paid], sales: reversed });
    assert.equal(alone.referrers[0].owedNumerator, -120000);
    assert.equal(alone.referrers[0].dueMinor, 0);
    const withLater = await statementFor({
      journal: [paid],
      entries: [entry(), entry({ sessionId: "cs_2", applicationFeeId: "fee_2" })],
      sales: { ...reversed, cs_2: { status: "found", facts: facts({ feeId: "fee_2", feeAmount: 50 }) } },
    });
    assert.equal(withLater.referrers[0].owedNumerator, 50 * 4000 - 120000);
    assert.equal(withLater.referrers[0].dueMinor, 8);
  });
});

describe("currencies are kept apart", () => {
  test("a euro sale is its own balance", async () => {
    const s = await statementFor({
      entries: [entry(), entry({ sessionId: "cs_eur", applicationFeeId: "fee_eur", currency: "eur" })],
      sales: { cs_eur: { status: "found", facts: facts({ feeId: "fee_eur", currency: "eur", feeAmount: 45 }) } },
    });
    assert.deepEqual(
      s.referrers.map((r) => [r.currency, r.dueMinor]),
      [
        ["eur", 18],
        ["gbp", 12],
      ],
    );
  });
});
