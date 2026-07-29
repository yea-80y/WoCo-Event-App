/**
 * Payout sweep follow-ups (#85): the past-ceiling alarm and the schedule-heal
 * retry queue.
 *
 * Neither loses money — these are the observability gaps around the money path.
 * An entry stuck past Stripe's hold ceiling and an account left on Stripe's
 * automatic schedule are both states that previously showed up only as a line in
 * a per-sweep log, i.e. not at all.
 *
 * The ledger writes .data/ relative to process.cwd(), so this suite chdirs into
 * a temp dir BEFORE importing it.
 */

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let ledger: typeof import("../src/lib/stripe/payout-ledger.js");
let release: typeof import("../src/lib/stripe/payout-release.js");
let intents: typeof import("../src/lib/stripe/payout-intents.js");

const ACCT = "acct_followups_1";
const ORG = "0xabc0000000000000000000000000000000000001";

let ledgerFile: string;
let intentsFile: string;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "woco-payout-followups-test-"));
  process.chdir(dir);
  ledgerFile = join(dir, ".data", "stripe-payout-ledger.json");
  intentsFile = join(dir, ".data", "stripe-payout-intents.json");
  ledger = await import("../src/lib/stripe/payout-ledger.js");
  release = await import("../src/lib/stripe/payout-release.js");
  intents = await import("../src/lib/stripe/payout-intents.js");
});

beforeEach(() => {
  rmSync(ledgerFile, { force: true });
  rmSync(intentsFile, { force: true });
  ledger.__resetForTests();
  intents.__resetForTests();
});

function held(sessionId: string, recordedAt: string) {
  return ledger.recordHeld({
    sessionId,
    stripeAccountId: ACCT,
    organiserAddress: ORG,
    kind: "event",
    eventId: "ev1",
    currency: "gbp",
    grossAmount: 10_000,
    paymentIntentId: `pi_${sessionId}`,
    recordedAt,
    releaseAfter: "2099-01-01T00:00:00.000Z",
  });
}

/** Default ceiling is 90 days minus the 7-day safety margin = 83. */
const CHARGED = "2026-01-01T00:00:00.000Z";
const DAY = 86_400_000;
const at = (days: number) => new Date(Date.parse(CHARGED) + days * DAY);

// ── Past-ceiling alarm ────────────────────────────────────────────────────

test("a fresh held entry is not a breach", () => {
  held("s1", CHARGED);
  assert.deepEqual(release.heldPastCeiling(at(10)), { count: 0, oldestBreachedAt: null });
});

test("nothing has breached the day before the ceiling", () => {
  held("s1", CHARGED);
  assert.equal(release.heldPastCeiling(at(82)).count, 0);
});

test("an entry still held past the ceiling is counted", () => {
  held("s1", CHARGED);
  const breach = release.heldPastCeiling(at(84));
  assert.equal(breach.count, 1);
  assert.ok(breach.oldestBreachedAt, "the alarm must say how long it has been wrong");
});

test("the alarm reports the OLDEST breach, not the newest", () => {
  held("old", CHARGED);
  held("new", new Date(Date.parse(CHARGED) + 10 * DAY).toISOString());

  const breach = release.heldPastCeiling(at(95));
  assert.equal(breach.count, 2);
  assert.equal(
    breach.oldestBreachedAt,
    new Date(Date.parse(CHARGED) + 83 * DAY).toISOString(),
    "escalation should be driven by the worst case",
  );
});

/** Only HELD money can breach — released and voided entries are done with. */
test("released and voided entries never count as breaches", () => {
  held("released", CHARGED);
  held("voided", CHARGED);
  ledger.markReleased("released", "po_1");
  ledger.markVoid("voided", "refunded");

  assert.equal(release.heldPastCeiling(at(200)).count, 0);
});

test("the sweep health payload carries the breach count and no amounts", () => {
  held("s1", CHARGED);
  const health = release.payoutSweepHealth();

  assert.equal(typeof health.heldPastCeiling, "number");
  assert.equal(typeof health.pendingScheduleHeals, "number");
  assert.ok(!("amount" in health), "the health endpoint is public — no organiser financials");
  assert.ok(!("grossAmount" in health));
});

// ── Schedule-heal retry queue ─────────────────────────────────────────────

test("nothing is queued for healing until a correction fails", async () => {
  const { pendingScheduleHeals } = await import("../src/lib/stripe/payout-schedule.js");
  assert.deepEqual(pendingScheduleHeals(), []);
});

/**
 * `ensureManualPayoutSchedule` swallows its own errors on purpose — it runs
 * inside a webhook that must answer fast. Without a queue that made the failure
 * invisible: the account stayed on Stripe's automatic schedule, paying the
 * organiser out before their event, until another webhook happened to arrive.
 * No Stripe key is configured in tests, so getStripe() throws and the call takes
 * exactly that failure path.
 */
test("a failed correction queues the account and reports it", async () => {
  const schedule = await import("../src/lib/stripe/payout-schedule.js");
  const ok = await schedule.ensureManualPayoutSchedule(ACCT);

  assert.equal(ok, false, "a failed correction must not report success");
  assert.deepEqual(schedule.pendingScheduleHeals(), [ACCT]);
  assert.equal(release.payoutSweepHealth().pendingScheduleHeals, 1);
});

test("the retry re-attempts every queued account and keeps failures queued", async () => {
  const schedule = await import("../src/lib/stripe/payout-schedule.js");
  await schedule.ensureManualPayoutSchedule("acct_a");
  await schedule.ensureManualPayoutSchedule("acct_b");
  assert.equal(schedule.pendingScheduleHeals().length >= 2, true);

  const result = await schedule.retryPendingScheduleHeals();
  assert.equal(result.attempted, schedule.pendingScheduleHeals().length);
  assert.equal(result.healed, 0, "still no Stripe key — nothing can heal");
  assert.ok(schedule.pendingScheduleHeals().includes("acct_a"), "a failure stays queued for next sweep");
});

test("queueing the same account twice does not duplicate the work", async () => {
  const schedule = await import("../src/lib/stripe/payout-schedule.js");
  const before = schedule.pendingScheduleHeals().length;
  await schedule.ensureManualPayoutSchedule("acct_dup");
  await schedule.ensureManualPayoutSchedule("acct_dup");
  assert.equal(schedule.pendingScheduleHeals().filter((a) => a === "acct_dup").length, 1);
  assert.equal(schedule.pendingScheduleHeals().length, before + 1);
});
