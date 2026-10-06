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
  // `recursive` because one test replaces the intents file with a DIRECTORY to
  // force an unwritable journal; a bare unlink would fail and poison the suite.
  rmSync(intentsFile, { recursive: true, force: true });
  ledger.__resetForTests();
  intents.__resetForTests();
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

test("an OPEN dispute holds the sale — not a number", async () => {
  const entry = held("cs_d");
  for (const status of ["needs_response", "under_review", "warning_needs_response", "warning_under_review"]) {
    const r = await release.resolveNetFromStripe(disputedStripe([{ status, balance_transactions: [] }]) as never, entry);
    assert.deepEqual(r, { held: "dispute" }, status);
  }
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

test("a WON dispute whose reinstatement has not posted yet is still held, never voided", async () => {
  const entry = held("cs_d");
  const r = await release.resolveNetFromStripe(
    disputedStripe([{ status: "won", balance_transactions: [{ net: -11_500, currency: "gbp" }] }]) as never,
    entry,
  );
  assert.deepEqual(r, { held: "dispute" });
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
  gateway.resolveNet = async (entry) => (entry.sessionId === "cs_d" ? { held: "dispute" } : base(entry));
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
    assert.deepEqual(r, { held: "refund" }, status);
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

test("a failed refund whose reversal has not posted yet holds — never a terminal void", async () => {
  const entry = held("cs_r");
  const r = await release.resolveNetFromStripe(
    refundedStripe([{ status: "failed", balance_transaction: "txn_refund", failure_balance_transaction: null }]) as never,
    entry,
  );
  assert.deepEqual(r, { held: "refund" });
});

test("a refund with no balance transaction and a status we do not know holds (fail closed)", async () => {
  const entry = held("cs_r");
  for (const status of [null, "succeeded", "something_new"]) {
    const r = await release.resolveNetFromStripe(refundedStripe([{ status, balance_transaction: null }]) as never, entry);
    assert.deepEqual(r, { held: "refund" }, String(status));
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
  gateway.resolveNet = async () => ({ held: "refund" });
  const [outcome] = await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.deepEqual(outcome!.deferred, ["cs_r"]);
  assert.equal(payouts.length, 0);
  assert.equal(ledger.getEntry("cs_r")?.status, "held");
  assert.equal(ledger.getEntry("cs_r")?.netAmount, 9_680, "a held sale's last known net is not overwritten");
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
  gateway.resolveNet = async () => ({ held: "refund" });
  await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.equal(ledger.getEntry("cs_future")?.recheck, true);
});

test("a debt whose flag was lost is found by the shortfall scan — at most once a day, and only when something due does not fit", async () => {
  held("cs_due", { grossAmount: 5_000 });
  held("cs_future", { releaseAfter: "2026-09-01T00:00:00.000Z" });
  const reads: string[] = [];
  const { gateway, payouts } = fakeGateway({ nets: { cs_due: 5_000, cs_future: 7_000 }, available: 1_000 });
  const inner = gateway.resolveNet;
  gateway.resolveNet = async (e) => {
    reads.push(e.sessionId);
    return inner(e);
  };
  await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.deepEqual(reads, ["cs_due", "cs_future"], "something due did not fit: the not-due sale is read");
  reads.length = 0;
  await release.runReleaseSweep(gateway, at("2026-02-05T01:00:00.000Z"));
  assert.deepEqual(reads, ["cs_due"], "not again within the day");
  reads.length = 0;
  await release.runReleaseSweep(gateway, at("2026-02-06T01:00:00.000Z"));
  assert.deepEqual(reads, ["cs_due", "cs_future"]);
  assert.equal(payouts.length, 0, "a positive net that is not due is never paid");

  // The same scan finding a debt: netted, and the due sale fits.
  resetLedger();
  held("cs_due", { grossAmount: 5_000 });
  held("cs_future", { releaseAfter: "2026-09-01T00:00:00.000Z" });
  const found = fakeGateway({ nets: { cs_due: 5_000, cs_future: -400 }, available: 4_600 });
  await release.runReleaseSweep(found.gateway, at("2026-02-05T00:00:00.000Z"));
  assert.equal(found.payouts[0]!.amount, 4_600);

  // Everything due fits: no scan at all.
  resetLedger();
  held("cs_due", { grossAmount: 5_000 });
  held("cs_future", { releaseAfter: "2026-09-01T00:00:00.000Z" });
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

test("a cancelled event's sale an operator resolved (nothing refunded in Stripe) is not paid before its date", async () => {
  held("cs_resolved", { eventId: "ev_cx", releaseAfter: "2026-06-01T00:00:00.000Z" });
  const { gateway, payouts } = fakeGateway({ nets: { cs_resolved: 9_680 } });
  gateway.cancellationHold = () => false;
  gateway.eventCancelled = () => true;
  await release.runReleaseSweep(gateway, at("2026-02-05T00:00:00.000Z"));
  assert.equal(payouts.length, 0, "read early only to net a debt; a positive keeps its date");
  assert.equal(ledger.getEntry("cs_resolved")?.netAmount, 9_680);
  await release.runReleaseSweep(gateway, at("2026-06-02T00:00:00.000Z"));
  assert.equal(payouts[0]!.amount, 9_680);
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
