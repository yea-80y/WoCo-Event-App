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
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let ledger: typeof import("../src/lib/stripe/payout-ledger.js");
let release: typeof import("../src/lib/stripe/payout-release.js");
let policy: typeof import("../src/lib/stripe/payout-policy.js");
let intents: typeof import("../src/lib/stripe/payout-intents.js");
let surplus: typeof import("../src/lib/stripe/payout-surplus.js");

const ACCT = "acct_test_1";
const ORG = "0xabc0000000000000000000000000000000000001";

/**
 * The ledger resolves its file path once, at import. chdir-per-test therefore
 * would NOT isolate suites — the file has to be deleted and the module's memory
 * reset together, which is what resetLedger does.
 */
let ledgerFile: string;
let intentsFile: string;
let surplusFile: string;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "woco-payout-test-"));
  process.chdir(dir);
  ledgerFile = join(dir, ".data", "stripe-payout-ledger.json");
  intentsFile = join(dir, ".data", "stripe-payout-intents.json");
  surplusFile = join(dir, ".data", "stripe-payout-surplus.json");
  ledger = await import("../src/lib/stripe/payout-ledger.js");
  release = await import("../src/lib/stripe/payout-release.js");
  policy = await import("../src/lib/stripe/payout-policy.js");
  intents = await import("../src/lib/stripe/payout-intents.js");
  surplus = await import("../src/lib/stripe/payout-surplus.js");
});

function resetLedger(): void {
  rmSync(ledgerFile, { force: true });
  // `recursive` because one test replaces the intents file with a DIRECTORY to
  // force an unwritable journal; a bare unlink would fail and poison the suite.
  rmSync(intentsFile, { recursive: true, force: true });
  rmSync(surplusFile, { force: true });
  ledger.__resetForTests();
  intents.__resetForTests();
  surplus.__resetForTests();
  release.__resetSweepStateForTests();
}

beforeEach(() => resetLedger());

// ---------------------------------------------------------------------------
// Fake gateway
// ---------------------------------------------------------------------------

interface FakeOpts {
  nets?: Record<string, number | null>;
  /** sessionId → currency the charge SETTLED in, when it differs from presentment. */
  settlements?: Record<string, string>;
  /** sessionId → why its net may still move (#781 part 2). */
  unsettled?: Record<string, "dispute" | "refund">;
  /**
   * Stripe's balance. Left out, it matches the ledger exactly (the held nets);
   * `available` alone means "the rest is still pending" (#781 part 2). `null` =
   * the balance cannot be read.
   */
  available?: number | null;
  pending?: number;
  country?: string;
  failPayout?: boolean;
  /** Simulate "couldn't ask Stripe whether the journalled payout exists". */
  failFind?: boolean;
  /** Payout ids, so two fakes in one test do not mint the same id. */
  idPrefix?: string;
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
      const unsettled = opts.unsettled?.[entry.sessionId];
      return {
        net: v === undefined ? entry.grossAmount : v,
        currency: opts.settlements?.[entry.sessionId] ?? entry.currency,
        ...(unsettled ? { unsettled } : {}),
      };
    },
    async balance(acct, cur) {
      if (opts.available === null) return null;
      const ledgerSum = ledger
        .listHeld()
        .filter((e) => e.stripeAccountId === acct && (e.settlementCurrency ?? e.currency) === cur)
        .reduce((sum, e) => sum + (e.netAmount ?? e.grossAmount), 0);
      const available = opts.available === undefined ? ledgerSum : opts.available;
      const pending = opts.pending === undefined ? Math.max(0, ledgerSum - available) : opts.pending;
      return { available, pending };
    },
    async createPayout({ amount, currency, idempotencyKey, metadata }) {
      if (opts.failPayout) throw new Error("stripe down");
      // Replay an identical key returns the original payout instead of minting a
      // second — this is the behaviour we rely on for crash safety, so the fake
      // must model it.
      const existing = payouts.find((p) => p.idempotencyKey === idempotencyKey);
      if (existing) return existing.id;
      const id = `${opts.idPrefix ?? "po"}_${++payoutSeq}`;
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

test("a refunded sale is carried as a debt — not paid out, not voided (#781)", async () => {
  held("cs_refunded");
  // Fully refunded: the fees were not returned, so net goes negative. That money
  // has left the balance; voiding it would drop it from the arithmetic.
  const { gateway, payouts } = fakeGateway({ nets: { cs_refunded: -150 } });
  await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.equal(payouts.length, 0);
  assert.equal(ledger.getEntry("cs_refunded")?.status, "held");
  assert.equal(ledger.getEntry("cs_refunded")?.netAmount, -150);
});

test("a due sale that comes to exactly nothing is voided", async () => {
  held("cs_zero");
  const { gateway, payouts } = fakeGateway({ nets: { cs_zero: 0 } });
  const [outcome] = await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.equal(payouts.length, 0);
  assert.deepEqual(outcome!.voided, ["cs_zero"]);
  assert.equal(ledger.getEntry("cs_zero")?.status, "void");
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

test("an unwritable journal defers the payout instead of paying unjournalled", async () => {
  // The journal only closes the double-pay window while it is ON DISK: it is
  // written seconds before the payout, so the crash it guards against is the one
  // that takes the in-memory copy with it — and a full disk produces both. Paying
  // anyway would leave Stripe paid, disk silent, and the next sweep free to
  // re-select a grown set under a different key. Deferring is the safe direction:
  // the funds stay held and nothing has been spent.
  held("cs_j", { grossAmount: 5_000 });
  // A directory where the file belongs: the temp write succeeds, the rename onto
  // it cannot. Deterministic regardless of uid, unlike a permissions test.
  mkdirSync(intentsFile, { recursive: true });
  try {
    const { gateway, payouts } = fakeGateway();
    const [outcome] = await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));

    assert.equal(payouts.length, 0, "Stripe must not be called without a journalled intent");
    assert.match(outcome!.error ?? "", /journal/);
    assert.deepEqual(outcome!.deferred, ["cs_j"]);
    assert.equal(ledger.getEntry("cs_j")?.status, "held", "funds stay held, nothing is lost");
    assert.equal(intents.getIntent(ACCT, "gbp"), undefined, "a failed write must not leave a phantom intent in memory");
  } finally {
    rmSync(intentsFile, { recursive: true, force: true });
  rmSync(surplusFile, { force: true });
  }

  // …and the next sweep, with a writable journal, pays normally.
  const { gateway, payouts } = fakeGateway();
  await release.runReleaseSweep(gateway, at("2026-02-05T01:00:00.000Z"));
  assert.equal(payouts.length, 1);
  assert.equal(ledger.getEntry("cs_j")?.status, "released");
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

test("a fully refunded sale becomes a debt even after its net was cached", async () => {
  held("cs_a", { grossAmount: 10_000, netAmount: 9_680 });
  const { gateway, payouts } = fakeGateway({ nets: { cs_a: -150 } });
  await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.equal(payouts.length, 0);
  assert.equal(ledger.getEntry("cs_a")?.status, "held");
  assert.equal(ledger.getEntry("cs_a")?.netAmount, -150, "fresh net, not the cached 9680");
});

// ---------------------------------------------------------------------------
// Disputes (#645 part C) — held while open, netted when closed, never voided early
// ---------------------------------------------------------------------------

/** An async-iterable list, the shape stripe-node's auto-paginating `list()` returns. */
function listOf<T>(items: T[]) {
  return {
    async *[Symbol.asyncIterator]() {
      yield* items;
    },
  };
}

/** A fake Stripe whose charge is disputed, with these disputes. */
function disputedStripe(disputes: Array<{ status: string; balance_transactions: Array<{ net: number; currency: string }> }>) {
  return {
    refunds: { list: () => listOf([]) },
    paymentIntents: {
      retrieve: async () => ({ latest_charge: { id: "ch_1", balance_transaction: "txn_1", amount_refunded: 0, disputed: true } }),
    },
    balanceTransactions: {
      retrieve: async () => ({ net: 9_500, currency: "gbp" }),
    },
    disputes: {
      list: () => ({
        async *[Symbol.asyncIterator]() {
          yield* disputes;
        },
      }),
    },
  };
}

test("an OPEN dispute marks the sale unsettled, at what has posted", async () => {
  const entry = held("cs_d");
  for (const status of ["needs_response", "under_review", "warning_needs_response", "warning_under_review"]) {
    const r = await release.resolveNetFromStripe(disputedStripe([{ status, balance_transactions: [] }]) as never, entry);
    assert.deepEqual(r, { net: 9_500, currency: "gbp", unsettled: "dispute" }, status);
  }
  // A chargeback's withdrawal posts while it is open: netted, still unsettled (#781 part 2).
  const r = await release.resolveNetFromStripe(
    disputedStripe([{ status: "needs_response", balance_transactions: [{ net: -11_500, currency: "gbp" }] }]) as never,
    entry,
  );
  assert.deepEqual(r, { net: -2_000, currency: "gbp", unsettled: "dispute" });
});

test("a LOST dispute's withdrawal is netted, which takes the sale to zero or below", async () => {
  const entry = held("cs_d");
  const r = await release.resolveNetFromStripe(
    disputedStripe([{ status: "lost", balance_transactions: [{ net: -11_500, currency: "gbp" }] }]) as never,
    entry,
  );
  assert.deepEqual(r, { net: -2_000, currency: "gbp" });
});

test("a WON dispute nets the withdrawal and the reinstatement: only the dispute fee is lost", async () => {
  const entry = held("cs_d");
  const r = await release.resolveNetFromStripe(
    disputedStripe([
      {
        status: "won",
        balance_transactions: [
          { net: -11_500, currency: "gbp" },
          { net: 10_000, currency: "gbp" },
        ],
      },
    ]) as never,
    entry,
  );
  assert.deepEqual(r, { net: 8_000, currency: "gbp" });
});

test("a WON dispute whose reinstatement has not posted yet is unsettled, never final", async () => {
  const entry = held("cs_d");
  const r = await release.resolveNetFromStripe(
    disputedStripe([{ status: "won", balance_transactions: [{ net: -11_500, currency: "gbp" }] }]) as never,
    entry,
  );
  assert.deepEqual(r, { net: -2_000, currency: "gbp", unsettled: "dispute" });
});

test("a won INQUIRY (no funds ever moved) is final at the charge's net", async () => {
  const entry = held("cs_d");
  const r = await release.resolveNetFromStripe(disputedStripe([{ status: "won", balance_transactions: [] }]) as never, entry);
  assert.deepEqual(r, { net: 9_500, currency: "gbp" });
});

test("a dispute balance transaction in another currency decides nothing", async () => {
  const entry = held("cs_d");
  const r = await release.resolveNetFromStripe(
    disputedStripe([{ status: "lost", balance_transactions: [{ net: -100, currency: "eur" }] }]) as never,
    entry,
  );
  assert.equal(r, null);
});

test("the sweep HOLDS a sale with an open dispute — never pays it, never voids it", async () => {
  held("cs_d");
  held("cs_ok");
  const { gateway, payouts } = fakeGateway();
  const base = gateway.resolveNet;
  gateway.resolveNet = async (entry) =>
    entry.sessionId === "cs_d" ? { net: 10_000, currency: "gbp", unsettled: "dispute" } : base(entry);
  const [outcome] = await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.deepEqual(outcome!.deferred, ["cs_d"]);
  assert.equal(ledger.getEntry("cs_d")?.status, "held", "a won dispute gives the money back, so no terminal void");
  assert.equal(payouts.length, 1);
  assert.equal(payouts[0]!.amount, 10_000, "only the undisputed sale is paid");
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
    refunds: {
      list: () => {
        calls.push("refunds");
        return listOf([]);
      },
    },
  };
  const entry = held("cs_live", { currency: "eur", netAmount: 9_680 });
  const resolved = await release.resolveNetFromStripe(fakeStripe as never, entry);
  assert.deepEqual(resolved, { net: 4_840, currency: "gbp" });
  assert.deepEqual(calls, ["pi:pi_cs_live", "bt:txn_1", "refunds"], "went to Stripe despite the cache");
});

// ---------------------------------------------------------------------------
// Unsettled refunds (#701) — a refund that has not moved money yet holds the sale
// ---------------------------------------------------------------------------

/** A fake Stripe whose charge has these refunds; `amount_refunded` is deliberately 0. */
function refundedStripe(
  refunds: Array<{ status: string | null; balance_transaction: string | null; failure_balance_transaction?: string | null }>,
) {
  const bts: Record<string, { net: number; currency: string }> = {
    txn_charge: { net: 9_500, currency: "gbp" },
    txn_refund: { net: -10_000, currency: "gbp" },
    txn_reversal: { net: 10_000, currency: "gbp" },
  };
  return {
    paymentIntents: {
      retrieve: async () => ({ latest_charge: { id: "ch_1", balance_transaction: "txn_charge", amount_refunded: 0 } }),
    },
    balanceTransactions: { retrieve: async (id: string) => bts[id] },
    refunds: { list: () => listOf(refunds) },
  };
}

test("a refund still waiting to move money (pending, requires_action) holds the sale — never paid out", async () => {
  const entry = held("cs_r");
  for (const status of ["pending", "requires_action"]) {
    const r = await release.resolveNetFromStripe(refundedStripe([{ status, balance_transaction: null }]) as never, entry);
    assert.deepEqual(r, { net: 9_500, currency: "gbp", unsettled: "refund" }, status);
  }
});

test("a failed or cancelled refund moved nothing and does not hold the sale", async () => {
  const entry = held("cs_r");
  for (const status of ["failed", "canceled"]) {
    const r = await release.resolveNetFromStripe(refundedStripe([{ status, balance_transaction: null }]) as never, entry);
    assert.deepEqual(r, { net: 9_500, currency: "gbp" }, status);
  }
});

test("a refund that FAILED after its debit posted nets the reversal too — the sale keeps its worth", async () => {
  const entry = held("cs_r");
  const r = await release.resolveNetFromStripe(
    refundedStripe([{ status: "failed", balance_transaction: "txn_refund", failure_balance_transaction: "txn_reversal" }]) as never,
    entry,
  );
  assert.deepEqual(r, { net: 9_500, currency: "gbp" }, "not -500, which would void a sale whose money is back");
});

test("a failed refund whose reversal has not posted yet is unsettled at its posted debit — never a terminal void", async () => {
  const entry = held("cs_r");
  const r = await release.resolveNetFromStripe(
    refundedStripe([{ status: "failed", balance_transaction: "txn_refund", failure_balance_transaction: null }]) as never,
    entry,
  );
  assert.deepEqual(r, { net: -500, currency: "gbp", unsettled: "refund" });
});

test("a refund with no balance transaction and a status we do not know holds (fail closed)", async () => {
  const entry = held("cs_r");
  for (const status of [null, "succeeded", "something_new"]) {
    const r = await release.resolveNetFromStripe(refundedStripe([{ status, balance_transaction: null }]) as never, entry);
    assert.deepEqual(r, { net: 9_500, currency: "gbp", unsettled: "refund" }, String(status));
  }
});

test("refunds are read even when amount_refunded says 0, and a landed one is netted", async () => {
  const entry = held("cs_r");
  const r = await release.resolveNetFromStripe(
    refundedStripe([{ status: "succeeded", balance_transaction: "txn_refund" }]) as never,
    entry,
  );
  assert.deepEqual(r, { net: -500, currency: "gbp" });
});

test("a cancelled event's sale is held until its refunds settle — even past the hold ceiling (#644)", async () => {
  held("cs_cx", { eventId: "ev_cancelled", recordedAt: "2026-01-01T00:00:00.000Z", releaseAfter: "2026-07-20T00:00:00.000Z" });
  held("cs_ok", { eventId: "ev_fine" });
  const { gateway, payouts } = fakeGateway({ country: "GB" });
  let settled = false;
  gateway.cancellationHold = (eventId) => eventId === "ev_cancelled" && !settled;
  const [outcome] = await release.runReleaseSweep(gateway, at("2026-04-10T00:00:00.000Z"));
  assert.deepEqual(outcome!.deferred, ["cs_cx"], "past the ceiling, and still held");
  assert.equal(payouts.length, 1, "the other event's sale is paid as normal");
  assert.equal(ledger.getEntry("cs_cx")?.status, "held");

  settled = true;
  const { gateway: g2 } = fakeGateway({ nets: { cs_cx: -300 }, country: "GB" });
  g2.cancellationHold = () => false;
  await release.runReleaseSweep(g2, at("2026-04-10T01:00:00.000Z"));
  assert.equal(ledger.getEntry("cs_cx")?.status, "held", "once settled it nets below zero: a debt, not a void (#781)");
  assert.equal(ledger.getEntry("cs_cx")?.netAmount, -300);
});

test("a journalled payout is not replayed once a sale in it belongs to a cancelled event (#644)", async () => {
  // Crash after journalling, then the event is cancelled. Replaying would pay
  // the cancelled sale; clearing early would drop the key that keeps the rest
  // of the set from being paid twice. The group waits out the window instead.
  held("cs_x", { eventId: "ev_cx", grossAmount: 5_000 });
  held("cs_y", { eventId: "ev1", grossAmount: 7_000 });
  const key = "woco-payout-cancelled-since";
  const { gateway, payouts } = fakeGateway({ nets: { cs_x: -300 } });
  // As live: the per-sale hold lifts once the refund settles; the event stays cancelled.
  let refundSettled = false;
  gateway.cancellationHold = (eventId) => eventId === "ev_cx" && !refundSettled;
  gateway.eventCancelled = (eventId) => eventId === "ev_cx";
  journal(key, ["cs_x", "cs_y"], 12_000, "2026-02-05T00:00:00.000Z");

  const [first] = await release.runReleaseSweep(gateway, at("2026-02-05T02:00:00.000Z"));
  assert.equal(payouts.length, 0, "never replayed");
  assert.ok(intents.getIntent(ACCT, "gbp"), "the intent and its key survive");
  assert.deepEqual(first!.deferred.slice().sort(), ["cs_x", "cs_y"]);
  assert.equal(ledger.getEntry("cs_y")?.status, "held");

  refundSettled = true;
  await release.runReleaseSweep(gateway, at("2026-02-05T02:30:00.000Z"));
  assert.equal(payouts.length, 0, "still not replayed once the refund has settled: the journalled sum predates it");
  assert.equal(ledger.getEntry("cs_x")?.status, "held");

  await release.runReleaseSweep(gateway, at("2026-02-06T00:00:00.000Z"));
  assert.equal(intents.getIntent(ACCT, "gbp"), undefined, "abandoned once the key has expired");
  assert.equal(payouts.length, 1);
  assert.equal(payouts[0]!.amount, 6_700, "the sale that was not refunded, less the fees kept on the one that was (#781)");
  assert.notEqual(payouts[0]!.idempotencyKey, key);
  assert.equal(ledger.getEntry("cs_x")?.status, "released", "re-resolved fresh: the refunded sale is netted");
  assert.equal(ledger.getEntry("cs_x")?.payoutId, payouts[0]!.id);
});

test("the live eventCancelled asks about the EVENT, and an unreadable record counts as cancelled (#644)", async () => {
  const cancellations = await import("../src/lib/event/cancellations.js");
  cancellations.recordCancellation({ eventId: "ev_ec_live", by: "ops:test", feeReturned: false });
  cancellations.addRefundRow("ev_ec_live", { sessionId: "cs_ec", paymentIntentId: "pi_cs_ec", account: ACCT });
  cancellations.updateRefundRow("ev_ec_live", "cs_ec", { status: "done" });
  assert.equal(release.liveGateway.cancellationHold!("ev_ec_live", "cs_ec"), false, "the sale's hold has lifted");
  assert.equal(release.liveGateway.eventCancelled!("ev_ec_live"), true, "the event is still cancelled");
  assert.equal(release.liveGateway.eventCancelled!("ev_ec_open"), false);

  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(process.cwd(), ".data", "event-cancellations.json"), "null");
  cancellations.__resetForTests();
  try {
    assert.equal(release.liveGateway.eventCancelled!("ev_ec_open"), true, "unreadable: every event counts as cancelled");
  } finally {
    rmSync(join(process.cwd(), ".data", "event-cancellations.json"), { force: true });
    cancellations.__resetForTests();
  }
});

test("the live hold is PER SALE: a cancelled event's sale with no refund row yet is held (#644)", async () => {
  const cancellations = await import("../src/lib/event/cancellations.js");
  cancellations.recordCancellation({ eventId: "ev_cancel_live", by: "ops:test", feeReturned: false });
  held("cs_norow", { eventId: "ev_cancel_live" });
  const { gateway, payouts } = fakeGateway();
  gateway.cancellationHold = release.liveGateway.cancellationHold;
  const [outcome] = await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.deepEqual(outcome!.deferred, ["cs_norow"], "the refund job has not reached it: never read as refunded");
  assert.equal(payouts.length, 0);

  cancellations.addRefundRow("ev_cancel_live", { sessionId: "cs_norow", paymentIntentId: "pi_cs_norow", account: ACCT });
  cancellations.updateRefundRow("ev_cancel_live", "cs_norow", { status: "disputed" });
  assert.equal(release.liveGateway.cancellationHold!("ev_cancel_live", "cs_norow"), true, "a dispute still holds");
  cancellations.updateRefundRow("ev_cancel_live", "cs_norow", { status: "done" });
  assert.equal(release.liveGateway.cancellationHold!("ev_cancel_live", "cs_norow"), false);
  assert.equal(release.liveGateway.cancellationHold!("ev_not_cancelled", "cs_x"), false);
});

test("the sweep holds a sale whose refund is not settled — neither paid nor voided", async () => {
  held("cs_r", { netAmount: 9_680 });
  const { gateway, payouts } = fakeGateway();
  gateway.resolveNet = async () => ({ net: 9_680, currency: "gbp", unsettled: "refund" });
  const [outcome] = await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.deepEqual(outcome!.deferred, ["cs_r"]);
  assert.equal(payouts.length, 0);
  assert.equal(ledger.getEntry("cs_r")?.status, "held");
  assert.equal(ledger.getEntry("cs_r")?.netAmount, 9_680, "the posted net, the refund not yet in it");
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

// ---------------------------------------------------------------------------
// Debts (#781) — a sale a refund or chargeback takes below zero is netted
// ---------------------------------------------------------------------------

// The owner's two sandbox organisers, as found on 2026-10-06.
const F1 = "acct_1UKR9sDWSXJ2ZzY3";
const F2 = "acct_1UDCgTDWPU4NxJWH";

test("F1: a cancelled sale's kept fees come off the other event's payout — 2962 paid, not deferred for ever", async () => {
  // One sale held (net 3131, event over); one sale of a cancelled event,
  // refunded with the fees kept (-169). Stripe's available balance: 2962.
  held("cs_f1_sale", { stripeAccountId: F1, eventId: "ev_f1", grossAmount: 3_300 });
  // The cancelled event's own date is months away: settled, it is due now.
  held("cs_f1_cx", { stripeAccountId: F1, eventId: "ev_f1_cx", grossAmount: 3_300, releaseAfter: "2026-06-01T00:00:00.000Z" });
  const { gateway, payouts } = fakeGateway({ nets: { cs_f1_sale: 3_131, cs_f1_cx: -169 }, available: 2_962 });
  gateway.cancellationHold = () => false;
  gateway.eventCancelled = (eventId) => eventId === "ev_f1_cx";
  const [outcome] = await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.equal(payouts.length, 1);
  assert.equal(payouts[0]!.amount, 2_962);
  assert.deepEqual(outcome!.debts, ["cs_f1_cx"]);
  assert.equal(ledger.getEntry("cs_f1_sale")?.payoutId, payouts[0]!.id);
  const debt = ledger.getEntry("cs_f1_cx")!;
  assert.equal(debt.status, "released", "released by the payout it was deducted from");
  assert.equal(debt.payoutId, payouts[0]!.id);
  assert.equal(debt.netAmount, -169);
});

test("a cancelled event's kept fees are netted even when the balance has room — never paid from another event's takings", async () => {
  // Another event's sale is held (not due) and its money is in the balance, so
  // the due sale fits without the debt. Paying it in full would spend 169 of
  // that event's takings.
  held("cs_due", { eventId: "ev_done", grossAmount: 3_300 });
  held("cs_cx", { eventId: "ev_cx", grossAmount: 3_300, releaseAfter: "2026-06-01T00:00:00.000Z" });
  held("cs_other", { eventId: "ev_later", grossAmount: 10_300, releaseAfter: "2026-06-01T00:00:00.000Z" });
  const { gateway, payouts } = fakeGateway({ nets: { cs_due: 3_131, cs_cx: -169, cs_other: 10_000 }, available: 12_962 });
  gateway.cancellationHold = () => false;
  gateway.eventCancelled = (eventId) => eventId === "ev_cx";
  await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.equal(payouts[0]!.amount, 2_962, "the 10000 left behind is exactly the other event's");
  assert.equal(ledger.getEntry("cs_other")?.status, "held");
});

test("F2: a sale voided before #781 is reopened, re-read and netted; the 85 nothing accounts for is never paid", async () => {
  held("cs_f2_sale", { stripeAccountId: F2, grossAmount: 3_300 });
  held("cs_f2_old", { stripeAccountId: F2, grossAmount: 3_300 });
  ledger.setNetAmount("cs_f2_old", -970);
  ledger.markVoid("cs_f2_old", "no net proceeds — refunded or fees exceeded takings");
  const stuck = fakeGateway({ nets: { cs_f2_sale: 3_131 }, available: 2_246 });
  await release.runReleaseSweep(stuck.gateway, at("2026-02-05T00:00:00.000Z"));
  assert.equal(stuck.payouts.length, 0, "as found: 3131 never fits 2246");

  assert.equal(ledger.reopenVoid("cs_f2_sale"), null, "only a void can be reopened");
  assert.equal(ledger.reopenVoid("cs_f2_old")?.status, "held");
  const { gateway, payouts } = fakeGateway({ nets: { cs_f2_sale: 3_131, cs_f2_old: -970 }, available: 2_246 });
  await release.runReleaseSweep(gateway, at("2026-02-05T01:00:00.000Z"));
  assert.equal(payouts[0]!.amount, 2_161, "3131 - 970; the surplus stays in the balance");
});

test("a reopened entry is netted at what Stripe says now, not at the net cached when it was voided", async () => {
  held("cs_sale", { grossAmount: 3_300 });
  held("cs_old", { grossAmount: 3_300 });
  ledger.setNetAmount("cs_old", -970);
  ledger.markVoid("cs_old", "test");
  ledger.reopenVoid("cs_old");
  // A reversal posted after the void: the sale is really -885.
  const { gateway, payouts } = fakeGateway({ nets: { cs_sale: 3_131, cs_old: -885 }, available: 2_246 });
  await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.equal(payouts[0]!.amount, 2_246);
  assert.equal(ledger.getEntry("cs_old")?.netAmount, -885);
});

test("a refund flagged on a sale whose event is still ahead is netted at the next payout, not at its event's date", async () => {
  held("cs_due", { grossAmount: 5_000 });
  held("cs_future", { eventId: "ev_future", releaseAfter: "2026-09-01T00:00:00.000Z" });
  assert.equal(ledger.flagForRecheck("cs_future"), true);
  assert.equal(ledger.flagForRecheck("cs_unknown"), false, "an organiser's own sale has no ledger entry");
  const { gateway, payouts } = fakeGateway({ nets: { cs_due: 5_000, cs_future: -400 }, available: 4_600 });
  await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.equal(payouts[0]!.amount, 4_600);
  assert.equal(ledger.getEntry("cs_future")?.status, "released");
});

test("a flagged sale that is not due and still worth something is read, never paid", async () => {
  held("cs_future", { releaseAfter: "2026-09-01T00:00:00.000Z" });
  ledger.flagForRecheck("cs_future");
  const { gateway, payouts } = fakeGateway({ nets: { cs_future: 6_000 } });
  await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.equal(payouts.length, 0);
  const e = ledger.getEntry("cs_future")!;
  assert.equal(e.status, "held");
  assert.equal(e.netAmount, 6_000);
  assert.equal(e.recheck, undefined, "read, so the flag clears");
});

test("a flag survives while the refund is still settling, so the sale is read again next sweep", async () => {
  held("cs_future", { releaseAfter: "2026-09-01T00:00:00.000Z" });
  ledger.flagForRecheck("cs_future");
  const { gateway } = fakeGateway();
  gateway.resolveNet = async () => ({ net: 10_000, currency: "gbp", unsettled: "refund" });
  await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.equal(ledger.getEntry("cs_future")?.recheck, true);
});

test("a refund whose flag was lost is named by the daily scan when the balance holds less than the ledger", async () => {
  // cs_future was read at 7000; a refund since took it to -400 and its webhook
  // flag was lost. The balance shows the truth (5000 - 400).
  held("cs_due", { grossAmount: 5_000 });
  held("cs_future", { releaseAfter: "2026-09-01T00:00:00.000Z", netAmount: 7_000 });
  const reads: string[] = [];
  const { gateway, payouts } = fakeGateway({ nets: { cs_due: 5_000, cs_future: -400 }, available: 4_600, pending: 0 });
  const inner = gateway.resolveNet;
  gateway.resolveNet = async (e) => {
    reads.push(e.sessionId);
    return inner(e);
  };
  const [outcome] = await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.deepEqual(reads, ["cs_due", "cs_future"]);
  assert.equal(payouts[0]!.amount, 4_600);
  assert.equal(outcome!.recon, undefined, "named, so nothing is left unattributed");
  assert.equal(ledger.getEntry("cs_future")?.status, "released");
});

test("the shortfall scan runs at most once a day, and only when the balance holds less than the ledger", async () => {
  // A chargeback of 1000 after an earlier payout, and the due sale still pending.
  held("cs_due", { grossAmount: 5_000 });
  held("cs_future", { releaseAfter: "2026-09-01T00:00:00.000Z", netAmount: 7_000 });
  const reads: string[] = [];
  const { gateway, payouts } = fakeGateway({ nets: { cs_due: 5_000, cs_future: 7_000 }, available: 0, pending: 11_000 });
  const inner = gateway.resolveNet;
  gateway.resolveNet = async (e) => {
    reads.push(e.sessionId);
    return inner(e);
  };
  await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.deepEqual(reads, ["cs_due", "cs_future"]);
  reads.length = 0;
  await release.runReleaseSweep(gateway, at("2026-02-05T01:00:00.000Z"));
  assert.deepEqual(reads, ["cs_due"], "not again within the day");
  reads.length = 0;
  await release.runReleaseSweep(gateway, at("2026-02-06T01:00:00.000Z"));
  assert.deepEqual(reads, ["cs_due", "cs_future"]);
  assert.equal(payouts.length, 0, "a positive net that is not due is never paid");

  // The balance matches the ledger: no scan at all.
  resetLedger();
  held("cs_due", { grossAmount: 5_000 });
  held("cs_future", { releaseAfter: "2026-09-01T00:00:00.000Z", netAmount: 7_000 });
  const fits = fakeGateway({ nets: { cs_due: 5_000 } });
  const fitReads: string[] = [];
  const fitInner = fits.gateway.resolveNet;
  fits.gateway.resolveNet = async (e) => {
    fitReads.push(e.sessionId);
    return fitInner(e);
  };
  await release.runReleaseSweep(fits.gateway, at("2026-02-05T00:00:00.000Z"));
  assert.deepEqual(fitReads, ["cs_due"]);
});

// `heldPastCeiling` reads the real clock, so entries recorded "now" keep it at
// zero and leave `ok` to the alarm under test.
const RECORDED_NOW = () => new Date().toISOString();

test("debts larger than everything due: no payout, all held, and the account is reported as owing", async () => {
  held("cs_due", { grossAmount: 3_300, recordedAt: RECORDED_NOW() });
  held("cs_chargeback", { releaseAfter: "2026-09-01T00:00:00.000Z", recordedAt: RECORDED_NOW() });
  ledger.flagForRecheck("cs_chargeback");
  // A lost chargeback (amount + fee) on a balance that held 3131: Stripe's balance is now negative.
  const { gateway, payouts } = fakeGateway({ nets: { cs_due: 3_131, cs_chargeback: -5_300 }, available: -2_169 });
  const [outcome] = await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.equal(payouts.length, 0);
  assert.equal(outcome!.owes, true);
  assert.equal(ledger.getEntry("cs_due")?.status, "held");
  assert.equal(ledger.getEntry("cs_chargeback")?.status, "held");
  const h = release.payoutSweepHealth();
  assert.equal(h.accountsOwing, 1);
  assert.equal(h.balanceShort, 0, "explained by the debt, so not a short balance");
  assert.equal(h.ok, true, "counted, not paged: only the organiser selling again clears it");

  // New takings cover the debt: paid, and the alarm clears.
  held("cs_new", { grossAmount: 3_300, recordedAt: RECORDED_NOW() });
  const covered = fakeGateway({ nets: { cs_due: 3_131, cs_chargeback: -5_300, cs_new: 3_131 }, available: 962 });
  await release.runReleaseSweep(covered.gateway, at("2026-02-05T01:00:00.000Z"));
  assert.equal(covered.payouts[0]!.amount, 962);
  assert.equal(release.payoutSweepHealth().accountsOwing, 0);
});

test("a due sale that has not fitted the balance for over a week alarms; a few days of pending funds does not", async () => {
  held("cs_due", { grossAmount: 5_000, recordedAt: RECORDED_NOW() });
  const short = fakeGateway({ nets: { cs_due: 5_000 }, available: 4_000 });
  await release.runReleaseSweep(short.gateway, at("2026-02-05T00:00:00.000Z"));
  assert.equal(release.payoutSweepHealth().balanceShort, 0, "4 days past due: funds may still be pending");
  assert.equal(release.payoutSweepHealth().ok, true);
  await release.runReleaseSweep(short.gateway, at("2026-02-09T00:00:00.000Z"));
  const h = release.payoutSweepHealth();
  assert.equal(h.balanceShort, 1);
  assert.equal(h.oldestBalanceShortSince, "2026-02-01T00:00:00.000Z");
  assert.equal(h.ok, false);

  const paid = fakeGateway({ nets: { cs_due: 5_000 }, available: 5_000 });
  await release.runReleaseSweep(paid.gateway, at("2026-02-09T01:00:00.000Z"));
  assert.equal(release.payoutSweepHealth().balanceShort, 0, "rebuilt each sweep: cleared once it pays");
});

test("the hold-ceiling count ignores debts: they hold no funds", () => {
  held("cs_debt", { netAmount: -169 });
  held("cs_funds", { netAmount: 3_131 });
  assert.equal(release.heldPastCeiling(at("2026-12-01T00:00:00.000Z")).count, 1);
});

test("a cancelled event's sale an operator resolved (nothing refunded in Stripe) is paid only by its date or the ceiling", async () => {
  // Already read once, so only the cancellation makes the sweep read it now.
  held("cs_resolved", { eventId: "ev_cx", releaseAfter: "2026-06-01T00:00:00.000Z", netAmount: 9_680 });
  const { gateway, payouts } = fakeGateway({ nets: { cs_resolved: 9_680 }, country: "GB" });
  gateway.cancellationHold = () => false;
  gateway.eventCancelled = () => true;
  const reads: string[] = [];
  const inner = gateway.resolveNet;
  gateway.resolveNet = async (e) => {
    reads.push(e.sessionId);
    return inner(e);
  };
  await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.deepEqual(reads, ["cs_resolved"], "a cancelled event's settled sale is read at once");
  assert.equal(payouts.length, 0, "read early only to net a debt; a positive keeps its date");
  assert.equal(ledger.getEntry("cs_resolved")?.netAmount, 9_680);
  // Recorded 1 Jan: the GB ceiling (90 days less the margin) falls before its date.
  await release.runReleaseSweep(gateway, at("2026-04-01T00:00:00.000Z"));
  assert.equal(payouts[0]!.amount, 9_680);
  assert.equal(ledger.getEntry("cs_resolved")?.forcedByCeiling, true);
});

test("an unsettled debt (a dispute on a refunded charge) is netted at what has posted, never blocking the payout", async () => {
  // Only a failed read holds the payout. An open dispute could last months; what
  // has posted is already gone from the balance, so it nets now (#781 part 2).
  held("cs_due", { grossAmount: 5_000 });
  held("cs_debt", { releaseAfter: "2026-09-01T00:00:00.000Z", netAmount: -169 });
  const { gateway, payouts } = fakeGateway({ nets: { cs_due: 5_000, cs_debt: -169 }, unsettled: { cs_debt: "dispute" } });
  await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.equal(payouts[0]!.amount, 4_831);
  assert.equal(ledger.getEntry("cs_debt")?.status, "released");
});

test("a known debt that cannot be read this sweep holds the payout rather than paying without it", async () => {
  held("cs_due", { grossAmount: 5_000 });
  held("cs_debt", { releaseAfter: "2026-09-01T00:00:00.000Z", netAmount: -400 });
  const { gateway, payouts } = fakeGateway({ nets: { cs_due: 5_000, cs_debt: null }, available: 4_600 });
  const [outcome] = await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.equal(payouts.length, 0);
  assert.equal(outcome!.error, "a known debt could not be read");

  const ok = fakeGateway({ nets: { cs_due: 5_000, cs_debt: -400 }, available: 4_600 });
  await release.runReleaseSweep(ok.gateway, at("2026-02-05T01:00:00.000Z"));
  assert.equal(ok.payouts[0]!.amount, 4_600);
});

test("a debt that hit the hold ceiling does not mark the payout or itself as ceiling-forced", async () => {
  // Old enough for the ceiling, event still ahead; the sale paid is event-due.
  held("cs_old_debt", { recordedAt: "2026-01-01T00:00:00.000Z", releaseAfter: "2026-09-01T00:00:00.000Z", netAmount: -300 });
  held("cs_due", { recordedAt: "2026-04-01T00:00:00.000Z", releaseAfter: "2026-04-05T00:00:00.000Z" });
  const { gateway, payouts } = fakeGateway({ nets: { cs_old_debt: -300, cs_due: 5_000 }, country: "GB" });
  const [outcome] = await release.runReleaseSweep(gateway, at("2026-04-10T00:00:00.000Z"));
  assert.equal(payouts[0]!.amount, 4_700);
  assert.equal(payouts[0]!.metadata.woco_forced_by_hold_ceiling, undefined);
  assert.equal(outcome!.forcedByCeiling, false);
  assert.equal(ledger.getEntry("cs_old_debt")?.forcedByCeiling, undefined);
});

test("funds held past the ceiling make the payout section page", () => {
  held("cs_stuck", { netAmount: 3_131 });
  const h = release.payoutSweepHealth();
  assert.ok(h.heldPastCeiling >= 1);
  assert.equal(h.ok, false);
});

test("when only part of what is due fits and the debt cancels it out, nothing is paid — never a zero or negative payout", async () => {
  // Debt 500; due sales 300 (settled) and 400 (still pending). With both, the
  // account is owed 200 — but only 300 is available net of the debt's draw.
  held("cs_debt", { releaseAfter: "2026-09-01T00:00:00.000Z" });
  ledger.flagForRecheck("cs_debt");
  held("cs_a", { recordedAt: "2026-01-01T00:00:00.000Z" });
  held("cs_b", { recordedAt: "2026-01-02T00:00:00.000Z" });
  const { gateway, payouts } = fakeGateway({ nets: { cs_debt: -500, cs_a: 300, cs_b: 400 }, available: -200 });
  const [outcome] = await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.equal(payouts.length, 0);
  assert.equal(outcome!.owes, undefined, "not owing: with everything due it nets +200");
  assert.deepEqual(outcome!.deferred.slice().sort(), ["cs_a", "cs_b"]);
  assert.equal(outcome!.shortSince, "2026-02-01T00:00:00.000Z");
});

// ---------------------------------------------------------------------------
// The balance against the ledger (#781 part 2) — money that moved outside a sale
// ---------------------------------------------------------------------------

/** Every payout equals the rows released with it: sales, debts and its reconciliation row. */
function assertPayoutsMatchRows(payouts: FakePayout[]): void {
  for (const p of payouts) {
    const rows = ledger
      .listByOrganiser(ORG)
      .filter((e) => e.payoutId === p.id)
      .reduce((sum, e) => sum + (e.netAmount ?? 0), 0);
    assert.equal(rows, p.amount, `payout ${p.id}: rows add up to what it paid`);
  }
}

test("a chargeback after the last payout comes off the next one, as an unattributed row", async () => {
  // 65 left the balance after an earlier payout; nothing in the ledger says so.
  held("cs_next", { grossAmount: 100 });
  const { gateway, payouts } = fakeGateway({ nets: { cs_next: 100 }, available: 35, pending: 0 });
  const [outcome] = await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.equal(payouts[0]!.amount, 35);
  assert.equal(outcome!.recon, -65);
  const recon = ledger.listByOrganiser(ORG).find((e) => e.kind === "reconciliation")!;
  assert.equal(recon.netAmount, -65);
  assert.equal(recon.status, "released");
  assertPayoutsMatchRows(payouts);
});

test("the same chargeback, recovered by Stripe from the organiser's bank first: the next payout is whole", async () => {
  held("cs_next", { grossAmount: 100 });
  const { gateway, payouts } = fakeGateway({ nets: { cs_next: 100 }, available: 100, pending: 0 });
  const [outcome] = await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.equal(payouts[0]!.amount, 100);
  assert.equal(outcome!.recon, undefined);
  assertPayoutsMatchRows(payouts);
});

test("a debt Stripe recovered from the bank is not deducted twice: the surplus it leaves is paid back after the wait", async () => {
  // A sale charged back before its event (net -18). The balance went to -18 and
  // Stripe debited the organiser's bank to zero it. Then a new sale (95).
  held("cs_debt", { releaseAfter: "2026-09-01T00:00:00.000Z", netAmount: -18 });
  held("cs_new", { grossAmount: 95 });
  const { gateway, payouts } = fakeGateway({ nets: { cs_debt: -18, cs_new: 95 }, available: 95, pending: 0 });
  await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.equal(payouts[0]!.amount, 77, "the debt is netted now; the 18 the bank paid is surplus");

  const later = fakeGateway({ available: 18, pending: 0, idPrefix: "po_later" });
  await release.runReleaseSweep(later.gateway, at("2026-02-08T00:00:00.000Z"));
  assert.equal(later.payouts.length, 0, "not before the surplus has lasted a week");
  await release.runReleaseSweep(later.gateway, at("2026-02-12T01:00:00.000Z"));
  assert.equal(later.payouts[0]!.amount, 18, "the organiser gets back what the bank debit covered");
  assertPayoutsMatchRows([...payouts, ...later.payouts]);
});

test("pending funds are not a shortfall: nothing is netted while the due sale's money settles", async () => {
  held("cs_due", { grossAmount: 100 });
  const settling = fakeGateway({ nets: { cs_due: 100 }, available: 0, pending: 100 });
  const [first] = await release.runReleaseSweep(settling.gateway, at("2026-02-05T00:00:00.000Z"));
  assert.equal(settling.payouts.length, 0);
  assert.equal(first!.rho, 0);
  const settled = fakeGateway({ nets: { cs_due: 100 }, available: 100, pending: 0 });
  const [second] = await release.runReleaseSweep(settled.gateway, at("2026-02-06T00:00:00.000Z"));
  assert.equal(settled.payouts[0]!.amount, 100);
  assert.equal(second!.recon, undefined);
});

test("a dispute won after payout is paid back on its own once it has lasted a week; a surplus that vanishes restarts the wait", async () => {
  // Everything was paid; the reinstatement (+50) arrives with nothing held.
  held("cs_old");
  ledger.markManyReleased(["cs_old"], "po_earlier");
  const won = fakeGateway({ available: 50, pending: 0 });
  await release.runReleaseSweep(won.gateway, at("2026-03-01T00:00:00.000Z"));
  assert.equal(won.payouts.length, 0, "day 0: waiting");

  // Gone again (a refund Stripe was holding took it): the clock resets.
  const gone = fakeGateway({ available: 0, pending: 0 });
  await release.runReleaseSweep(gone.gateway, at("2026-03-03T00:00:00.000Z"));
  await release.runReleaseSweep(won.gateway, at("2026-03-04T00:00:00.000Z"));
  await release.runReleaseSweep(won.gateway, at("2026-03-09T00:00:00.000Z"));
  assert.equal(won.payouts.length, 0, "5 days since it came back");

  // A restart keeps the clock: it is on disk.
  surplus.__resetForTests();
  await release.runReleaseSweep(won.gateway, at("2026-03-11T01:00:00.000Z"));
  assert.equal(won.payouts[0]!.amount, 50);
  assert.equal(won.payouts[0]!.metadata.woco_first_session.startsWith("recon_"), true, "a payout with no sale in it");
  assertPayoutsMatchRows(won.payouts);
});

test("a balance that cannot be read nets nothing and pays nothing (a missing currency row is pinned on the live read)", async () => {
  held("cs_due", { grossAmount: 100 });
  const { gateway, payouts } = fakeGateway({ nets: { cs_due: 100 }, available: null });
  const [outcome] = await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.equal(payouts.length, 0);
  assert.equal(outcome!.error, "balance unavailable");
  assert.equal(ledger.listByOrganiser(ORG).some((e) => e.kind === "reconciliation"), false);
});

test("a sale never read is read once before anything is measured; if that read fails, nothing is paid", async () => {
  held("cs_due", { grossAmount: 100 });
  held("cs_new", { releaseAfter: "2026-09-01T00:00:00.000Z" });
  const failing = fakeGateway({ nets: { cs_due: 100, cs_new: null } });
  const [outcome] = await release.runReleaseSweep(failing.gateway, at("2026-02-05T00:00:00.000Z"));
  assert.equal(failing.payouts.length, 0, "the balance would be measured against a guess");
  assert.equal(outcome!.error, "a sale could not be read");

  const ok = fakeGateway({ nets: { cs_due: 100, cs_new: 900 } });
  await release.runReleaseSweep(ok.gateway, at("2026-02-05T01:00:00.000Z"));
  assert.equal(ok.payouts[0]!.amount, 100);
  assert.equal(ledger.getEntry("cs_new")?.netAmount, 900, "read once, cached");
});

test("an owing group pays nothing, is counted, and its held sales are not reported as funds past the ceiling", async () => {
  // A chargeback after payout (balance 5300 short), and an old sale due.
  held("cs_old_due", { grossAmount: 3_300 });
  const { gateway, payouts } = fakeGateway({ nets: { cs_old_due: 3_131 }, available: -2_169, pending: 0 });
  const [outcome] = await release.runReleaseSweep(gateway, at("2026-04-10T00:00:00.000Z"));
  assert.equal(payouts.length, 0);
  assert.equal(outcome!.owes, true);
  assert.equal(release.payoutSweepHealth().accountsOwing, 1);
  assert.equal(release.heldPastCeiling(at("2026-12-01T00:00:00.000Z")).count, 0, "no funds behind it");
});

test("a crash after paying a set with a reconciliation row: recovery writes the row with the original payout", async () => {
  held("cs_next", { grossAmount: 100 });
  const { gateway, payouts } = fakeGateway({ nets: { cs_next: 100 }, available: 35, pending: 0 });
  // Pay, then lose the ledger write: put the entry back and keep the journal.
  const realCreate = gateway.createPayout;
  let journalled: import("../src/lib/stripe/payout-intents.js").PayoutIntent | undefined;
  gateway.createPayout = async (args) => {
    const id = await realCreate(args);
    journalled = intents.getIntent(ACCT, "gbp");
    throw new Error("crash after Stripe accepted the payout");
  };
  await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.equal(payouts.length, 1);
  assert.equal(journalled?.recon?.amount, -65);
  assert.equal(ledger.listByOrganiser(ORG).some((e) => e.kind === "reconciliation"), false);

  gateway.createPayout = realCreate;
  await release.runReleaseSweep(gateway, at("2026-02-05T01:00:00.000Z"));
  assert.equal(payouts.length, 1, "confirmed, never paid twice");
  const recon = ledger.listByOrganiser(ORG).find((e) => e.kind === "reconciliation");
  assert.equal(recon?.payoutId, payouts[0]!.id);
  assertPayoutsMatchRows(payouts);
});

test("a journalled set is replayed when its event was cancelled BEFORE the set was chosen", async () => {
  held("cs_cx", { eventId: "ev_cx", grossAmount: 5_000 });
  held("cs_y", { eventId: "ev1", grossAmount: 7_000 });
  const key = "woco-payout-cancelled-before";
  const { gateway, payouts } = fakeGateway({ nets: { cs_cx: -300 } });
  gateway.cancellationHold = () => false;
  gateway.eventCancelled = (eventId) => eventId === "ev_cx";
  gateway.cancelledAfter = () => false;
  journal(key, ["cs_cx", "cs_y"], 6_700, "2026-02-05T00:00:00.000Z");
  await release.runReleaseSweep(gateway, at("2026-02-05T02:00:00.000Z"));
  assert.equal(payouts.length, 1, "replayed: the cancellation is already in its sum");
  assert.equal(payouts[0]!.idempotencyKey, key);
});

test("the live cancelledAfter compares the cancellation time with the set's", async () => {
  const cancellations = await import("../src/lib/event/cancellations.js");
  cancellations.recordCancellation({ eventId: "ev_ca_live", by: "ops:test", feeReturned: false });
  const at0 = cancellations.getCancellation("ev_ca_live")!.cancelledAt;
  assert.equal(release.liveGateway.cancelledAfter!("ev_ca_live", "2000-01-01T00:00:00.000Z"), true);
  assert.equal(release.liveGateway.cancelledAfter!("ev_ca_live", at0), false, "not after itself");
  assert.equal(release.liveGateway.cancelledAfter!("ev_ca_open", "2000-01-01T00:00:00.000Z"), false);
});

test("a surplus unpaid for a month makes the payout section page", () => {
  const longAgo = new Date(Date.now() - 40 * 86_400_000);
  surplus.observeSurplus(ACCT, "gbp", 50, longAgo);
  const h = release.payoutSweepHealth();
  assert.equal(h.surplusOverdue, 1);
  assert.equal(h.ok, false);
});

test("the live balance read: a currency with no row is unreadable, never zero", async () => {
  const fakeStripe = {
    balance: {
      retrieve: async () => ({
        available: [{ currency: "gbp", amount: 2_962 }],
        pending: [{ currency: "gbp", amount: 100 }, { currency: "eur", amount: 5 }],
      }),
    },
  };
  assert.deepEqual(await release.balanceFromStripe(fakeStripe as never, ACCT, "GBP"), { available: 2_962, pending: 100 });
  assert.deepEqual(await release.balanceFromStripe(fakeStripe as never, ACCT, "eur"), { available: 0, pending: 5 });
  assert.equal(await release.balanceFromStripe(fakeStripe as never, ACCT, "usd"), null);
});

test("an organiser's own money is paid out after the wait even with an old fee debt held and nothing due", async () => {
  // A kept fee (-18) sits as a debt; nothing is due; their own Dashboard payment
  // of 1000 settled. The surplus is 1018 against the ledger (#785's shape).
  held("cs_debt", { releaseAfter: "2026-09-01T00:00:00.000Z", netAmount: -18 });
  const { gateway, payouts } = fakeGateway({ nets: { cs_debt: -18 }, available: 1_000, pending: 0 });
  await release.runReleaseSweep(gateway, at("2026-02-01T00:00:00.000Z"));
  assert.equal(payouts.length, 0, "waiting");
  const [outcome] = await release.runReleaseSweep(gateway, at("2026-02-08T01:00:00.000Z"));
  assert.equal(payouts[0]!.amount, 1_000, "their 1000, the fee they owed netted from the surplus");
  assert.equal(outcome!.owes, undefined);
  assert.equal(ledger.getEntry("cs_debt")?.status, "released");
  assertPayoutsMatchRows(payouts);
});

test("kept fees that Stripe recovered from the bank are settled on the ledger with no payout, and nothing alarms", async () => {
  // A cancelled event's kept fees (-169) are held debts; Stripe debited the bank
  // to cover them, so the balance is 0 and the surplus exactly cancels the debt.
  held("cs_cx", { eventId: "ev_cx", releaseAfter: "2026-09-01T00:00:00.000Z", netAmount: -169 });
  const { gateway, payouts } = fakeGateway({ nets: { cs_cx: -169 }, available: 0, pending: 0 });
  await release.runReleaseSweep(gateway, at("2026-02-01T00:00:00.000Z"));
  const [outcome] = await release.runReleaseSweep(gateway, at("2026-02-08T01:00:00.000Z"));
  assert.equal(payouts.length, 0, "nothing to pay");
  assert.equal(outcome!.settledWithoutPayout, true);
  const debt = ledger.getEntry("cs_cx")!;
  assert.equal(debt.status, "released");
  assert.ok(debt.payoutId?.startsWith("settle_"));
  const recon = ledger.listByOrganiser(ORG).find((e) => e.kind === "reconciliation")!;
  assert.equal(recon.netAmount, 169);
  assert.equal(recon.payoutId, debt.payoutId, "the settlement's rows add up to zero");
  assert.equal(surplus.listSurplusClocks().length, 0, "the surplus is spent, so no clock is left to alarm");
});

test("a surplus that shrank during the wait is paid at its smallest, not its latest", async () => {
  held("cs_old");
  ledger.markManyReleased(["cs_old"], "po_earlier");
  const start = fakeGateway({ available: 50, pending: 0, idPrefix: "po_a" });
  await release.runReleaseSweep(start.gateway, at("2026-03-01T00:00:00.000Z"));
  const low = fakeGateway({ available: 30, pending: 0, idPrefix: "po_b" });
  await release.runReleaseSweep(low.gateway, at("2026-03-03T00:00:00.000Z"));
  const back = fakeGateway({ available: 50, pending: 0, idPrefix: "po_c" });
  await release.runReleaseSweep(back.gateway, at("2026-03-08T01:00:00.000Z"));
  assert.equal(back.payouts[0]!.amount, 30, "only what lasted the whole week");
});

test("a surplus still in pending starts the clock but is not paid until it is available; a part paid keeps its clock", async () => {
  held("cs_old");
  ledger.markManyReleased(["cs_old"], "po_earlier");
  const pendingOnly = fakeGateway({ available: 0, pending: 50, idPrefix: "po_p" });
  await release.runReleaseSweep(pendingOnly.gateway, at("2026-03-01T00:00:00.000Z"));
  await release.runReleaseSweep(pendingOnly.gateway, at("2026-03-08T01:00:00.000Z"));
  assert.equal(pendingOnly.payouts.length, 0, "a payout can only use available money");

  const part = fakeGateway({ available: 20, pending: 30, idPrefix: "po_q" });
  await release.runReleaseSweep(part.gateway, at("2026-03-08T02:00:00.000Z"));
  assert.equal(part.payouts[0]!.amount, 20);
  const clock = surplus.listSurplusClocks()[0]!;
  assert.equal(clock.since, "2026-03-01T00:00:00.000Z", "the rest keeps the clock it has already served");
  assert.equal(clock.min, 30);

  const rest = fakeGateway({ available: 30, pending: 0, idPrefix: "po_r" });
  await release.runReleaseSweep(rest.gateway, at("2026-03-08T03:00:00.000Z"));
  assert.equal(rest.payouts[0]!.amount, 30, "no second week's wait");
});

test("a crashed SURPLUS payout: recovery writes its row and spends the surplus clock", async () => {
  held("cs_old");
  ledger.markManyReleased(["cs_old"], "po_earlier");
  const { gateway, payouts } = fakeGateway({ available: 50, pending: 0 });
  await release.runReleaseSweep(gateway, at("2026-03-01T00:00:00.000Z"));
  const realCreate = gateway.createPayout;
  gateway.createPayout = async (args) => {
    await realCreate(args);
    throw new Error("crash after Stripe accepted the payout");
  };
  await release.runReleaseSweep(gateway, at("2026-03-08T01:00:00.000Z"));
  assert.equal(payouts.length, 1);
  gateway.createPayout = realCreate;
  const after = fakeGateway({ available: 0, pending: 0 });
  after.gateway.findPayoutByIntent = gateway.findPayoutByIntent;
  await release.runReleaseSweep(after.gateway, at("2026-03-08T02:00:00.000Z"));
  const recon = ledger.listByOrganiser(ORG).find((e) => e.kind === "reconciliation");
  assert.equal(recon?.netAmount, 50);
  assert.equal(recon?.payoutId, payouts[0]!.id);
  assert.equal(surplus.listSurplusClocks().length, 0);
});
