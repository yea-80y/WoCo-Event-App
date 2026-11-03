/**
 * The referral payout journal store (#12). It writes .data/ under process.cwd(),
 * so the suite chdirs into a temp dir BEFORE importing it.
 */

import { test, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let j: typeof import("../src/lib/campaign/earnings-journal.js");
let file: string;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "woco-referral-journal-"));
  process.chdir(dir);
  mkdirSync(join(dir, ".data"), { recursive: true });
  file = join(dir, ".data", "referral-payout-journal.json");
  j = await import("../src/lib/campaign/earnings-journal.js");
});

beforeEach(() => {
  j.__resetJournalForTests();
  rmSync(file, { force: true });
});

const WITHHOLD = { kind: "withhold", id: "rw_1", scope: "referrer", key: "0x" + "a1".repeat(20), reason: "r", by: "ops", at: "2026-12-01T00:00:00.000Z" } as const;
const LIFT = { kind: "lift", id: "rl_1", withholdId: "rw_1", reason: "ok", by: "ops", at: "2026-12-02T00:00:00.000Z" } as const;

test("appends survive a restart, in order", () => {
  assert.equal(j.appendJournal(WITHHOLD), true);
  assert.equal(j.appendJournal(LIFT), true);
  j.__resetJournalForTests();
  assert.deepEqual(j.journalEntries().map((e) => e.id), ["rw_1", "rl_1"]);
});

test("a lifted withhold is no longer active", () => {
  j.appendJournal(WITHHOLD);
  assert.equal(j.activeWithholds().length, 1);
  j.appendJournal(LIFT);
  assert.equal(j.activeWithholds().length, 0);
  assert.equal(j.referralJournalHealth().activeWithholds, 0);
});

describe("a journal file that cannot be read", () => {
  for (const [name, contents] of [
    ["truncated JSON", `{"entries": [{"kind": "pay`],
    ["JSON null", "null"],
    ["no entries array", `{"entries": {}}`],
    ["a payout with no transaction", `{"entries": [{"kind": "payout", "id": "rp_1", "referrer": "0xa", "currency": "gbp", "amountMinor": 12}]}`],
    ["a payout with no amount", `{"entries": [{"kind": "payout", "id": "rp_1", "referrer": "0xa", "currency": "gbp", "txHash": "0x1"}]}`],
    ["an unknown kind", `{"entries": [{"kind": "adjustment", "id": "ra_1"}]}`],
  ] as const) {
    test(`${name}: never overwritten, every write refused, health red`, () => {
      writeFileSync(file, contents);
      assert.equal(j.journalReadable(), false);
      assert.equal(j.appendJournal(WITHHOLD), false);
      assert.equal(j.journalEntries().length, 0, "a refused write leaves nothing in memory either");
      assert.equal(readFileSync(file, "utf-8"), contents, "the file is left exactly as it was");
      const h = j.referralJournalHealth();
      assert.equal(h.ok, false);
      assert.equal(h.fileUnreadable, true);
    });
  }
});

test("no file yet is an empty journal, not an unreadable one", () => {
  assert.equal(j.journalReadable(), true);
  assert.equal(j.referralJournalHealth().ok, true);
});
