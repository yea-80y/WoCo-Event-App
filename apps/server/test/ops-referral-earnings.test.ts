/**
 * /api/ops/referral-earnings (#12): the operator surface. The derivation itself
 * is pinned in referral-earnings.test.ts; this pins the routes' input checks and
 * that withholds and lifts reach the journal.
 */

import { test, before, beforeEach, after, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EMAIL_HASH_SECRET = "test-secret-ops-referral";

let ops: typeof import("../src/routes/ops.js");
let journal: typeof import("../src/lib/campaign/earnings-journal.js");

const TOKEN = "test-operator-token-0123456789";
const originalToken = process.env.OPS_TOKEN;
const REFERRER = "0x" + "a1".repeat(20);
let journalFile: string;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "woco-ops-referral-"));
  process.chdir(dir);
  mkdirSync(join(dir, ".data"), { recursive: true });
  journalFile = join(dir, ".data", "referral-payout-journal.json");
  ops = await import("../src/routes/ops.js");
  journal = await import("../src/lib/campaign/earnings-journal.js");
});

after(() => {
  if (originalToken === undefined) delete process.env.OPS_TOKEN;
  else process.env.OPS_TOKEN = originalToken;
});

beforeEach(() => {
  ops._resetOpsLockoutForTest();
  process.env.OPS_TOKEN = TOKEN;
  journal.__resetJournalForTests();
  rmSync(journalFile, { force: true });
});

const authed = (path: string, init: RequestInit = {}) =>
  ops.ops.request(path, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${TOKEN}` } });
const post = (path: string, body: unknown) =>
  authed(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const PAYOUT = {
  by: "ops:test",
  referrer: REFERRER,
  currency: "GBP",
  amountMinor: 12,
  network: "arbitrum-one",
  asset: "USDC",
  sentAmount: "0.15",
  txHash: "0x" + "ab".repeat(32),
};

test("without the operator token: not found", async () => {
  const res = await ops.ops.request("/referral-earnings");
  assert.equal(res.status, 404);
});

test("GET answers a statement with the journal's health", async () => {
  const res = await authed("/referral-earnings");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; data: { referrers: unknown[]; journalReadable: boolean; journal: { ok: boolean } } };
  assert.equal(body.ok, true);
  assert.deepEqual(body.data.referrers, []);
  assert.equal(body.data.journalReadable, true);
  assert.equal(body.data.journal.ok, true);
});

test("GET refuses a referrer that is not an address", async () => {
  assert.equal((await authed("/referral-earnings?referrer=bob")).status, 400);
});

describe("POST /referral-earnings/payouts input checks", () => {
  for (const [what, over] of [
    ["no by", { by: "" }],
    ["referrer not an address", { referrer: "0x123" }],
    ["currency not ISO", { currency: "pounds" }],
    ["amount zero", { amountMinor: 0 }],
    ["amount fractional", { amountMinor: 1.5 }],
    ["amount as a string", { amountMinor: "12" }],
    ["tx hash short", { txHash: "0xabc" }],
    ["no network", { network: "" }],
    ["no asset", { asset: "" }],
    ["sent amount not decimal", { sentAmount: "1e5" }],
    ["fx rate not decimal", { fxRate: "abc" }],
    ["paidAt not a date", { paidAt: "yesterday" }],
  ] as const) {
    test(`${what}: 400, nothing written`, async () => {
      const res = await post("/referral-earnings/payouts", { ...PAYOUT, ...over });
      assert.equal(res.status, 400);
      assert.equal(journal.journalEntries().length, 0);
    });
  }

  test("a well-formed payout with nothing due: 409, nothing written", async () => {
    const res = await post("/referral-earnings/payouts", PAYOUT);
    assert.equal(res.status, 409);
    assert.equal(journal.journalEntries().length, 0);
  });
});

describe("withholds", () => {
  test("recorded with the scope and key given; lifted once", async () => {
    const res = await post("/referral-earnings/withholds", { by: "ops", scope: "referrer", key: REFERRER.toUpperCase().replace("0X", "0x"), reason: "self-referral" });
    assert.equal(res.status, 200);
    const { data } = (await res.json()) as { data: { withhold: { id: string; key: string } } };
    assert.equal(data.withhold.key, REFERRER, "addresses are stored lowercase");
    assert.equal(journal.activeWithholds().length, 1);

    const lift = await post(`/referral-earnings/withholds/${data.withhold.id}/lift`, { by: "ops", reason: "cleared" });
    assert.equal(lift.status, 200);
    assert.equal(journal.activeWithholds().length, 0);
    const again = await post(`/referral-earnings/withholds/${data.withhold.id}/lift`, { by: "ops", reason: "cleared" });
    assert.equal(again.status, 404, "a lifted withhold cannot be lifted again");
  });

  for (const [what, body] of [
    ["unknown scope", { by: "ops", scope: "everyone", key: REFERRER, reason: "r" }],
    ["sale scope with an address", { by: "ops", scope: "sale", key: REFERRER, reason: "r" }],
    ["referee scope with a session id", { by: "ops", scope: "referee", key: "cs_1", reason: "r" }],
    ["no reason", { by: "ops", scope: "referrer", key: REFERRER, reason: "" }],
    ["no by", { by: "", scope: "referrer", key: REFERRER, reason: "r" }],
  ] as const) {
    test(`${what}: 400`, async () => {
      assert.equal((await post("/referral-earnings/withholds", body)).status, 400);
      assert.equal(journal.journalEntries().length, 0);
    });
  }

  test("lifting a withhold that does not exist: 404", async () => {
    assert.equal((await post("/referral-earnings/withholds/rw_nope/lift", { by: "ops", reason: "r" })).status, 404);
  });
});
