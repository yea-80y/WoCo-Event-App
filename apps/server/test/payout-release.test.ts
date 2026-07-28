/**
 * Payout hold + release logic.
 *
 * This is a money path: the failure modes are paying an organiser before their
 * event, paying them twice, paying out a refunded sale, breaching Stripe's hold
 * ceiling, or stranding funds forever. Each of those has a test here.
 *
 * The ledger writes .data/ relative to process.cwd(), so this suite chdirs into a
 * temp dir BEFORE importing it — test writes never touch the real .data.
 */

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let ledger: typeof import("../src/lib/stripe/payout-ledger.js");
let release: typeof import("../src/lib/stripe/payout-release.js");
let policy: typeof import("../src/lib/stripe/payout-policy.js");
let intents: typeof import("../src/lib/stripe/payout-intents.js");

const ACCT = "acct_test_1";
const ORG = "0xabc0000000000000000000000000000000000001";

/**
 * The ledger resolves its file path once, at import. chdir-per-test therefore
 * would NOT isolate suites — the file has to be deleted and the module's memory
 * reset together, which is what resetLedger does.
 */
let ledgerFile: string;
let intentsFile: string;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "woco-payout-test-"));
  process.chdir(dir);
  ledgerFile = join(dir, ".data", "stripe-payout-ledger.json");
  intentsFile = join(dir, ".data", "stripe-payout-intents.json");
  ledger = await import("../src/lib/stripe/payout-ledger.js");
  release = await import("../src/lib/stripe/payout-release.js");
  policy = await import("../src/lib/stripe/payout-policy.js");
  intents = await import("../src/lib/stripe/payout-intents.js");
});

function resetLedger(): void {
  rmSync(ledgerFile, { force: true });
  rmSync(intentsFile, { force: true });
  ledger.__resetForTests();
  intents.__resetForTests();
}

beforeEach(() => resetLedger());

// ---------------------------------------------------------------------------
// Fake gateway
// ---------------------------------------------------------------------------

interface FakeOpts {
  nets?: Record<string, number | null>;
  /** sessionId → currency the charge SETTLED in, when it differs from presentment. */
  settlements?: Record<string, string>;
  available?: number | null;
  country?: string;
  failPayout?: boolean;
  /** Simulate "couldn't ask Stripe whether the journalled payout exists". */
  failFind?: boolean;
}

interface FakePayout {
  id: string;
  amount: number;
  currency: string;
  idempotencyKey: string;
  metadata: Record<string, string>;
}

function fakeGateway(opts: FakeOpts = {}) {
  const payouts: FakePayout[] = [];
  let payoutSeq = 0;
  const gateway: import("../src/lib/stripe/payout-release.js").PayoutGateway = {
    async resolveNet(entry) {
      const v = opts.nets?.[entry.sessionId];
      if (v === null) return null;
      return {
        net: v === undefined ? entry.grossAmount : v,
        currency: opts.settlements?.[entry.sessionId] ?? entry.currency,
      };
    },
    async availableBalance() {
      return opts.available === undefined ? Number.MAX_SAFE_INTEGER : opts.available;
    },
    async createPayout({ amount, currency, idempotencyKey, metadata }) {
      if (opts.failPayout) throw new Error("stripe down");
      // Replay an identical key returns the original payout instead of minting a
      // second — this is the behaviour we rely on for crash safety, so the fake
      // must model it.
      const existing = payouts.find((p) => p.idempotencyKey === idempotencyKey);
      if (existing) return existing.id;
      const id = `po_${++payoutSeq}`;
      payouts.push({ id, amount, currency, idempotencyKey, metadata });
      return id;
    },
    async findPayoutByIntent(_acct, intentKey) {
      if (opts.failFind) return null;
      const found = payouts.find((p) => p.metadata.woco_intent === intentKey);
      return { payoutId: found?.id ?? null };
    },
    async accountCountry() {
      return opts.country;
    },
  };
  return { gateway, payouts };
}

function held(sessionId: string, over: Partial<Parameters<typeof ledger.recordHeld>[0]> = {}) {
  return ledger.recordHeld({
    sessionId,
    stripeAccountId: ACCT,
    organiserAddress: ORG,
    kind: "event",
    eventId: "ev1",
    currency: "gbp",
    grossAmount: 10_000,
    paymentIntentId: `pi_${sessionId}`,
    recordedAt: "2026-01-01T00:00:00.000Z",
    releaseAfter: "2026-02-01T00:00:00.000Z",
    ...over,
  });
}

const at = (iso: string) => new Date(iso);

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

test("hold ceiling is 90 days minus safety margin outside TH/US", () => {
  // Stripe documents 90 days for "all other countries"; we release early by a
  // margin so a missed sweep can't breach it.
  const ceiling = policy.holdCeilingAt("2026-01-01T00:00:00.000Z", "GB");
  assert.equal(ceiling, "2026-03-25T00:00:00.000Z"); // 90 − 7 margin = +83 days
  assert.equal(policy.maxHoldDays("GB"), 90);
});

test("country ceilings follow Stripe's documented table", () => {
  assert.equal(policy.maxHoldDays("TH"), 10);
  assert.equal(policy.maxHoldDays("US"), 730);
  assert.equal(policy.maxHoldDays("th"), 10, "country code must be case-insensitive");
  assert.equal(policy.maxHoldDays(undefined), 90, "unknown country falls back to 90");
});

test("event release is anchored to end date, falling back to start then a default", () => {
  assert.equal(
    policy.eventReleaseAfter("2026-01-01T00:00:00.000Z", "2026-06-10T22:00:00.000Z", "2026-06-10T18:00:00.000Z"),
    "2026-06-12T22:00:00.000Z",
  );
  // No end date — a single-session event anchors on start.
  assert.equal(
    policy.eventReleaseAfter("2026-01-01T00:00:00.000Z", "", "2026-06-10T18:00:00.000Z"),
    "2026-06-12T18:00:00.000Z",
  );
  // Neither parses: must not strand the money nor release it immediately.
  assert.equal(
    policy.eventReleaseAfter("2026-01-01T00:00:00.000Z", "not-a-date", undefined),
    "2026-01-15T00:00:00.000Z",
  );
});

// ---------------------------------------------------------------------------
// Holding
// ---------------------------------------------------------------------------

test("nothing is released before the event", async () => {
  held("cs_1");
  const { gateway, payouts } = fakeGateway();
  const [outcome] = await release.runReleaseSweep(gateway, at("2026-01-15T00:00:00.000Z"));
  assert.equal(payouts.length, 0);
  assert.deepEqual(outcome!.released, []);
  assert.deepEqual(outcome!.deferred, []);
  assert.equal(outcome!.amount, 0);
  assert.equal(ledger.getEntry("cs_1")?.status, "held");
});

test("a duplicate webhook delivery cannot create a second claim on the same money", () => {
  held("cs_dup", { grossAmount: 10_000 });
  held("cs_dup", { grossAmount: 99_999 });
  assert.equal(ledger.listHeld().length, 1);
  assert.equal(ledger.getEntry("cs_dup")?.grossAmount, 10_000, "first record wins");
});

test("one event's payout does not drain another event's held funds", async () => {
  // The organiser's balance pools both. Releasing the finished gig must not touch
  // the festival money — this is the whole reason the ledger exists.
  held("cs_gig", { grossAmount: 20_000, releaseAfter: "2026-02-01T00:00:00.000Z" });
  held("cs_festival", { grossAmount: 500_000, releaseAfter: "2026-06-01T00:00:00.000Z" });

  const { gateway, payouts } = fakeGateway({ available: 520_000, country: "GB" });
  await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));

  assert.equal(payouts.length, 1);
  assert.equal(payouts[0]!.amount, 20_000, "only the gig's takings");
  assert.equal(ledger.getEntry("cs_gig")?.status, "released");
  assert.equal(ledger.getEntry("cs_festival")?.status, "held");
});

// ---------------------------------------------------------------------------
// Releasing
// ---------------------------------------------------------------------------

test("net (not gross) is paid out, and is cached on the entry", async () => {
  held("cs_1", { grossAmount: 10_000 });
  // 10000 gross − 170 processing − 150 application fee.
  const { gateway, payouts } = fakeGateway({ nets: { cs_1: 9_680 } });
  await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.equal(payouts[0]!.amount, 9_680);
  assert.equal(ledger.getEntry("cs_1")?.netAmount, 9_680);
});

test("multiple due sales are released as one payout", async () => {
  held("cs_a", { grossAmount: 5_000 });
  held("cs_b", { grossAmount: 7_000 });
  const { gateway, payouts } = fakeGateway();
  await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.equal(payouts.length, 1);
  assert.equal(payouts[0]!.amount, 12_000);
});

test("currencies are never mixed into one payout", async () => {
  held("cs_gbp", { grossAmount: 5_000, currency: "gbp" });
  held("cs_eur", { grossAmount: 6_000, currency: "eur" });
  const { gateway, payouts } = fakeGateway();
  await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.equal(payouts.length, 2);
  assert.deepEqual(
    payouts.map((p) => `${p.currency}:${p.amount}`).sort(),
    ["eur:6000", "gbp:5000"],
  );
});

test("a refunded sale is voided, not paid out", async () => {
  held("cs_refunded");
  // Fully refunded: the application fee was not returned, so net goes negative.
  const { gateway, payouts } = fakeGateway({ nets: { cs_refunded: -150 } });
  await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.equal(payouts.length, 0);
  assert.equal(ledger.getEntry("cs_refunded")?.status, "void");
});

test("an unresolvable net leaves the entry held rather than guessing", async () => {
  held("cs_unknown");
  const { gateway, payouts } = fakeGateway({ nets: { cs_unknown: null } });
  const [outcome] = await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.equal(payouts.length, 0);
  assert.equal(ledger.getEntry("cs_unknown")?.status, "held");
  assert.deepEqual(outcome!.deferred, ["cs_unknown"]);
});

// ---------------------------------------------------------------------------
// Unsettled balance — the partial-release path
// ---------------------------------------------------------------------------

test("never pays out more than the settled balance, and never marks unpaid entries", async () => {
  held("cs_a", { grossAmount: 5_000, recordedAt: "2026-01-01T00:00:00.000Z" });
  held("cs_b", { grossAmount: 7_000, recordedAt: "2026-01-02T00:00:00.000Z" });
  // Only cs_a has settled.
  const { gateway, payouts } = fakeGateway({ available: 5_000 });
  await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));

  assert.equal(payouts.length, 1);
  assert.equal(payouts[0]!.amount, 5_000);
  assert.equal(ledger.getEntry("cs_a")?.status, "released");
  assert.equal(ledger.getEntry("cs_b")?.status, "held", "unpaid entry must stay held");
});

test("a single sale larger than the settled balance is deferred, not part-paid", async () => {
  // Regression guard: paying out `available` while marking nothing released would
  // pay the same money again on the next sweep.
  held("cs_big", { grossAmount: 50_000 });
  const { gateway, payouts } = fakeGateway({ available: 10_000 });
  await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.equal(payouts.length, 0);
  assert.equal(ledger.getEntry("cs_big")?.status, "held");
});

test("a zero balance releases nothing", async () => {
  held("cs_1");
  const { gateway, payouts } = fakeGateway({ available: 0 });
  await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.equal(payouts.length, 0);
  assert.equal(ledger.getEntry("cs_1")?.status, "held");
});

// ---------------------------------------------------------------------------
// Crash safety + idempotency
// ---------------------------------------------------------------------------

test("released entries are not paid a second time on the next sweep", async () => {
  held("cs_1");
  const { gateway, payouts } = fakeGateway();
  await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  await release.runReleaseSweep(gateway, at("2026-02-06T00:00:00.000Z"));
  assert.equal(payouts.length, 1);
});

test("a crash between payout and ledger write replays the same idempotency key", async () => {
  // Simulates: payout succeeded at Stripe, process died before markReleased.
  const entry = held("cs_1");
  const { gateway, payouts } = fakeGateway();
  const first = await release.releaseForAccount(ACCT, "gbp", [entry], gateway, at("2026-02-05T00:00:00.000Z"));
  const firstKey = payouts[0]!.idempotencyKey;

  resetLedger(); // the ledger write never reached disk
  const entryAgain = held("cs_1");
  await release.releaseForAccount(ACCT, "gbp", [entryAgain], gateway, at("2026-02-05T00:00:00.000Z"));

  assert.equal(payouts.length, 1, "must not create a second payout");
  assert.equal(payouts[0]!.idempotencyKey, firstKey, "same set ⇒ same key");
  assert.ok(first.payoutId);
});

test("a failed payout leaves everything held for the next sweep", async () => {
  held("cs_1");
  const { gateway } = fakeGateway({ failPayout: true });
  const [outcome] = await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.equal(outcome!.error, "stripe down");
  assert.deepEqual(outcome!.released, []);
  assert.equal(ledger.getEntry("cs_1")?.status, "held");
});

test("an unreadable balance defers instead of paying out blind", async () => {
  held("cs_1");
  const { gateway, payouts } = fakeGateway({ available: null });
  const [outcome] = await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.equal(payouts.length, 0);
  assert.equal(outcome!.error, "balance unavailable");
  assert.equal(ledger.getEntry("cs_1")?.status, "held");
});

// ---------------------------------------------------------------------------
// The intent journal — exactly-once where the idempotency key alone fails
// ---------------------------------------------------------------------------

function journal(key: string, sessionIds: string[], amount: number, createdAt: string): void {
  intents.saveIntent({
    stripeAccountId: ACCT,
    currency: "gbp",
    sessionIds,
    forcedSessionIds: [],
    amount,
    idempotencyKey: key,
    createdAt,
  });
}

test("a crashed payout is recovered from the journal, not re-derived", async () => {
  // Crash simulation: the payout reached Stripe, markReleased never ran. All
  // that survives is the journalled intent and the payout at Stripe.
  held("cs_a", { grossAmount: 5_000 });
  held("cs_b", { grossAmount: 7_000 });
  const key = "woco-payout-crashed";
  const { gateway, payouts } = fakeGateway();
  payouts.push({ id: "po_orig", amount: 12_000, currency: "gbp", idempotencyKey: key, metadata: { woco_intent: key } });
  journal(key, ["cs_a", "cs_b"], 12_000, "2026-02-05T00:00:00.000Z");

  const [outcome] = await release.runReleaseSweep(gateway, at("2026-02-05T01:00:00.000Z"));
  assert.equal(payouts.length, 1, "no second payout");
  assert.equal(ledger.getEntry("cs_a")?.status, "released");
  assert.equal(ledger.getEntry("cs_b")?.status, "released");
  assert.equal(ledger.getEntry("cs_a")?.payoutId, "po_orig");
  assert.equal(intents.getIntent(ACCT, "gbp"), undefined, "intent settled");
  assert.deepEqual(outcome!.released.slice().sort(), ["cs_a", "cs_b"]);
});

test("a newly due entry cannot drag a crashed set into a second payout", async () => {
  // The double-pay the journal exists to prevent: {A,B} paid, crash before the
  // ledger write, C becomes due. Without the journal the next sweep selects
  // {A,B,C} under a NEW key and pays A and B a second time.
  held("cs_a", { grossAmount: 5_000 });
  held("cs_b", { grossAmount: 7_000 });
  held("cs_c", { grossAmount: 3_000 });
  const key = "woco-payout-crashed2";
  const { gateway, payouts } = fakeGateway();
  payouts.push({ id: "po_orig", amount: 12_000, currency: "gbp", idempotencyKey: key, metadata: { woco_intent: key } });
  journal(key, ["cs_a", "cs_b"], 12_000, "2026-02-05T00:00:00.000Z");

  await release.runReleaseSweep(gateway, at("2026-02-05T01:00:00.000Z"));
  assert.equal(payouts.length, 2, "recovered payout + a fresh one");
  const fresh = payouts[1]!;
  assert.equal(fresh.amount, 3_000, "the new payout carries ONLY the new entry");
  assert.equal(ledger.getEntry("cs_c")?.payoutId, fresh.id);
});

test("an unconfirmed intent inside the idempotency window replays the same key", async () => {
  // Crash BEFORE the request reached Stripe: no payout exists. The journalled
  // request is replayed verbatim — same set, same amount, same key.
  held("cs_a", { grossAmount: 5_000 });
  const key = "woco-payout-inflight";
  const { gateway, payouts } = fakeGateway();
  journal(key, ["cs_a"], 4_800, "2026-02-05T00:00:00.000Z");

  await release.runReleaseSweep(gateway, at("2026-02-05T02:00:00.000Z"));
  assert.equal(payouts.length, 1);
  assert.equal(payouts[0]!.idempotencyKey, key, "journalled key, not a re-derived one");
  assert.equal(payouts[0]!.amount, 4_800, "journalled amount, not re-resolved");
  assert.equal(ledger.getEntry("cs_a")?.status, "released");
});

test("an expired unconfirmable intent is abandoned and re-selected with fresh nets", async () => {
  // The payout provably never happened and the key has expired at Stripe. The
  // entry returns to normal selection — and the refund that landed while the
  // intent was stuck is honoured, because nets are re-read, never replayed.
  held("cs_a", { grossAmount: 10_000 });
  const key = "woco-payout-stale";
  const { gateway, payouts } = fakeGateway({ nets: { cs_a: 4_840 } });
  journal(key, ["cs_a"], 9_680, "2026-02-03T00:00:00.000Z"); // 48h before `now`

  await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.equal(payouts.length, 1);
  assert.equal(payouts[0]!.amount, 4_840, "post-refund net, not the journalled pre-refund amount");
  assert.notEqual(payouts[0]!.idempotencyKey, key, "expired key is never reused");
  assert.equal(ledger.getEntry("cs_a")?.status, "released");
});

test("a failed intent lookup freezes the group rather than risking a double pay", async () => {
  held("cs_a");
  const key = "woco-payout-unknown";
  const { gateway, payouts } = fakeGateway({ failFind: true });
  journal(key, ["cs_a"], 9_680, "2026-02-05T00:00:00.000Z");

  const [outcome] = await release.runReleaseSweep(gateway, at("2026-02-05T01:00:00.000Z"));
  assert.equal(payouts.length, 0);
  assert.match(outcome!.error!, /lookup failed/);
  assert.equal(ledger.getEntry("cs_a")?.status, "held");
  assert.ok(intents.getIntent(ACCT, "gbp"), "intent stays until settled");
});

test("a failed payout journals its intent and settles it on the next sweep", async () => {
  // End-to-end: the payout call throws (ambiguous — a timeout can mean Stripe
  // processed it). The intent must survive, and the next sweep must settle it
  // under the ORIGINAL key.
  held("cs_a", { grossAmount: 5_000 });
  const failing = fakeGateway({ failPayout: true });
  const [first] = await release.runReleaseSweep(failing.gateway, at("2026-02-05T00:00:00.000Z"));
  assert.equal(first!.error, "stripe down");
  const journalled = intents.getIntent(ACCT, "gbp");
  assert.ok(journalled, "intent survives the failure");

  // Next sweep, Stripe healthy. A fresh fake: its payout store is empty, as if
  // Stripe never saw the first request.
  const healthy = fakeGateway();
  await release.runReleaseSweep(healthy.gateway, at("2026-02-05T01:00:00.000Z"));
  assert.equal(healthy.payouts.length, 1);
  assert.equal(healthy.payouts[0]!.idempotencyKey, journalled!.idempotencyKey);
  assert.equal(ledger.getEntry("cs_a")?.status, "released");
  assert.equal(intents.getIntent(ACCT, "gbp"), undefined);
});

test("orphaned intents are settled even when nothing is held", async () => {
  // Every entry of the crashed set is already settled or gone, so no held entry
  // produces this group — the sweep must still visit and clear the journal.
  const key = "woco-payout-orphan";
  const { gateway, payouts } = fakeGateway();
  payouts.push({ id: "po_orph", amount: 1_000, currency: "gbp", idempotencyKey: key, metadata: { woco_intent: key } });
  journal(key, ["cs_gone"], 1_000, "2026-02-05T00:00:00.000Z");

  await release.runReleaseSweep(gateway, at("2026-02-05T01:00:00.000Z"));
  assert.equal(intents.getIntent(ACCT, "gbp"), undefined);
  assert.equal(payouts.length, 1, "nothing new paid");
});

// ---------------------------------------------------------------------------
// Refund freshness — the ledger's netAmount is reporting, never truth
// ---------------------------------------------------------------------------

test("a cached net is re-read every sweep, so a late refund shrinks the payout", async () => {
  // The entry carries a stale netAmount from an earlier sweep (resolved, then
  // deferred on an unsettled balance). The refund that landed since MUST win.
  held("cs_a", { grossAmount: 10_000, netAmount: 9_680 });
  const { gateway, payouts } = fakeGateway({ nets: { cs_a: 4_840 } });
  await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.equal(payouts[0]!.amount, 4_840, "fresh net, not the cached 9680");
  assert.equal(ledger.getEntry("cs_a")?.netAmount, 4_840, "cache updated for reporting");
});

test("a fully refunded sale voids even after its net was cached", async () => {
  held("cs_a", { grossAmount: 10_000, netAmount: 9_680 });
  const { gateway, payouts } = fakeGateway({ nets: { cs_a: -150 } });
  await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.equal(payouts.length, 0);
  assert.equal(ledger.getEntry("cs_a")?.status, "void");
});

test("the live resolver ignores the cached net and reports the settlement currency", async () => {
  // Pins the actual regression: liveGateway used to short-circuit on
  // entry.netAmount, which is what made late refunds invisible.
  const calls: string[] = [];
  const fakeStripe = {
    paymentIntents: {
      retrieve: async (id: string) => {
        calls.push(`pi:${id}`);
        return { latest_charge: { id: "ch_1", balance_transaction: "txn_1", amount_refunded: 0 } };
      },
    },
    balanceTransactions: {
      retrieve: async (id: string) => {
        calls.push(`bt:${id}`);
        return { net: 4_840, currency: "GBP" };
      },
    },
  };
  const entry = held("cs_live", { currency: "eur", netAmount: 9_680 });
  const resolved = await release.resolveNetFromStripe(fakeStripe as never, entry);
  assert.deepEqual(resolved, { net: 4_840, currency: "gbp" });
  assert.deepEqual(calls, ["pi:pi_cs_live", "bt:txn_1"], "went to Stripe despite the cache");
});

// ---------------------------------------------------------------------------
// Settlement currency — converted charges must pay from the right balance
// ---------------------------------------------------------------------------

test("a charge that settled in another currency regroups instead of deferring forever", async () => {
  // EUR ticket on a GBP-only account: Stripe converts at charge time, so the
  // EUR balance stays empty for ever. The sweep must move the entry to the GBP
  // group — not poll an empty EUR balance until past the hold ceiling.
  held("cs_eur", { currency: "eur", grossAmount: 10_000 });
  const { gateway, payouts } = fakeGateway({ nets: { cs_eur: 9_200 }, settlements: { cs_eur: "gbp" } });

  const [first] = await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.equal(payouts.length, 0, "first sweep only records the settlement currency");
  assert.deepEqual(first!.deferred, ["cs_eur"]);
  assert.equal(ledger.getEntry("cs_eur")?.settlementCurrency, "gbp");

  await release.runReleaseSweep(gateway, at("2026-02-05T01:00:00.000Z"));
  assert.equal(payouts.length, 1);
  assert.equal(payouts[0]!.currency, "gbp", "paid from the settlement balance");
  assert.equal(payouts[0]!.amount, 9_200);
});

// ---------------------------------------------------------------------------
// The hold ceiling — Stripe's 90-day compliance deadline
// ---------------------------------------------------------------------------

test("funds are force-released at the ceiling even though the event has not happened", async () => {
  // On-sale in January for a July festival: Stripe requires payout within 90 days
  // of the charge, so the hold cannot cover it. This must happen and be flagged.
  held("cs_festival", {
    recordedAt: "2026-01-01T00:00:00.000Z",
    releaseAfter: "2026-07-20T00:00:00.000Z",
  });
  const { gateway, payouts } = fakeGateway({ country: "GB" });
  const [outcome] = await release.runReleaseSweep(gateway, at("2026-04-10T00:00:00.000Z"));

  assert.equal(payouts.length, 1);
  assert.equal(outcome!.forcedByCeiling, true);
  const entry = ledger.getEntry("cs_festival");
  assert.equal(entry?.status, "released");
  assert.equal(entry?.forcedByCeiling, true, "must be visible for reconciliation");
});

test("the ceiling does not fire before it is due", async () => {
  held("cs_festival", {
    recordedAt: "2026-01-01T00:00:00.000Z",
    releaseAfter: "2026-07-20T00:00:00.000Z",
  });
  const { gateway, payouts } = fakeGateway({ country: "GB" });
  await release.runReleaseSweep(gateway, at("2026-03-01T00:00:00.000Z"));
  assert.equal(payouts.length, 0);
  assert.equal(ledger.getEntry("cs_festival")?.forcedByCeiling, undefined);
});

test("Thailand's 10-day ceiling forces release far sooner", async () => {
  held("cs_th", {
    recordedAt: "2026-01-01T00:00:00.000Z",
    releaseAfter: "2026-07-20T00:00:00.000Z",
  });
  const { gateway, payouts } = fakeGateway({ country: "TH" });
  await release.runReleaseSweep(gateway, at("2026-01-05T00:00:00.000Z"));
  assert.equal(payouts.length, 1, "10 days minus margin ⇒ 3 days");
});

test("a normal post-event release is not flagged as ceiling-forced", async () => {
  held("cs_1", { recordedAt: "2026-01-20T00:00:00.000Z", releaseAfter: "2026-02-01T00:00:00.000Z" });
  const { gateway } = fakeGateway({ country: "GB" });
  const [outcome] = await release.runReleaseSweep(gateway, at("2026-02-02T00:00:00.000Z"));
  assert.equal(outcome!.forcedByCeiling, false);
  assert.equal(ledger.getEntry("cs_1")?.forcedByCeiling, undefined);
});

// ---------------------------------------------------------------------------
// Shop takings — the other thing a manual schedule freezes
// ---------------------------------------------------------------------------

test("shop takings release on their own delay, not an event date", async () => {
  const recordedAt = "2026-03-01T00:00:00.000Z";
  held("cs_shop", {
    kind: "shop",
    eventId: undefined,
    shopId: "shop1",
    orderId: "ord1",
    recordedAt,
    releaseAfter: policy.shopReleaseAfter(recordedAt),
  });
  const { gateway, payouts } = fakeGateway();
  await release.runReleaseSweep(gateway, at("2026-03-05T00:00:00.000Z"));
  assert.equal(payouts.length, 0, "not yet");
  await release.runReleaseSweep(gateway, at("2026-03-09T00:00:00.000Z"));
  assert.equal(payouts.length, 1, "released after the shop delay");
});

// ---------------------------------------------------------------------------
// Multi-organiser isolation
// ---------------------------------------------------------------------------

test("accounts are paid out independently", async () => {
  held("cs_1", { stripeAccountId: "acct_a", organiserAddress: ORG, grossAmount: 1_000 });
  held("cs_2", { stripeAccountId: "acct_b", organiserAddress: "0xdef", grossAmount: 2_000 });
  const { gateway, payouts } = fakeGateway();
  const outcomes = await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.equal(outcomes.length, 2);
  assert.deepEqual(payouts.map((p) => p.amount).sort((a, b) => a - b), [1_000, 2_000]);
});

test("listByOrganiser only returns that organiser's entries", () => {
  held("cs_1", { organiserAddress: ORG });
  held("cs_2", { stripeAccountId: "acct_b", organiserAddress: "0xDEF0000000000000000000000000000000000002" });
  const mine = ledger.listByOrganiser(ORG);
  assert.equal(mine.length, 1);
  assert.equal(mine[0]!.sessionId, "cs_1");
  // Address casing must not leak entries between organisers.
  assert.equal(ledger.listByOrganiser(ORG.toUpperCase()).length, 1);
});
