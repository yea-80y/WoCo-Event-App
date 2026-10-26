/**
 * #883 - an event's door roster (attendee emails and order answers, encrypted to
 * the organiser) is deleted 2 days after the event's ONCHAIN end, never the
 * organiser-editable feed `endDate`. No trusted end keeps the roster. The
 * check-in set and door passes are never touched. The event's door entries (later
 * buyers' sealed email and card name) go on the same clock, with or without a roster.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckinRecord } from "@woco/shared";

const CHAIN = 421614;
const OTHER_CHAIN = 42161;
const LEDGER = "0x" + "1e".repeat(20);
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-13T12:00:00Z");
const endedDaysAgo = (d: number) => (NOW - d * DAY) / 1000;

const ev = (n: number) => `e0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const id = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const E = {
  OLD: ev(1), RECENT: ev(2), EDGE: ev(3), UNREG: ev(4), NOEND: ev(5), RPC: ev(6),
  TWO: ev(7), BROKEN: ev(8), BEHIND: ev(9), KEEPS_DOOR: ev(10), CHMOD: ev(11), GATE: ev(12),
  ENTRIES: ev(14), ENTRIES_ONLY: ev(15), ENTRIES_RECENT: ev(16),
  HOLDS: ev(17), HOLDS_RECENT: ev(18),
};

/** onChainEventId → end in seconds, null (no end onchain) or "throw" (RPC down). */
const ends: Record<string, number | null | "throw"> = {
  [id(1)]: endedDaysAgo(3),
  [id(2)]: endedDaysAgo(1),
  [id(3)]: endedDaysAgo(2),
  [id(5)]: null,
  [id(6)]: "throw",
  [id(7)]: endedDaysAgo(60),
  [id(8)]: endedDaysAgo(1),
  [id(9)]: endedDaysAgo(60),
  [id(10)]: endedDaysAgo(3),
  [id(11)]: endedDaysAgo(3),
  [id(12)]: endedDaysAgo(3),
  [id(13)]: endedDaysAgo(3),
  [id(14)]: endedDaysAgo(3),
  [id(15)]: endedDaysAgo(3),
  [id(16)]: endedDaysAgo(1),
  [id(17)]: endedDaysAgo(3),
  [id(18)]: endedDaysAgo(1),
};
const reg = (n: number, chainId = CHAIN) => ({ onChainEventId: id(n), chainId, contract: LEDGER, version: "ledger" });
const REGISTRY = {
  [`${E.OLD}|s1`]: reg(1),
  [`${E.RECENT}|s1`]: reg(2),
  [`${E.EDGE}|s1`]: reg(3),
  [`${E.NOEND}|s1`]: reg(5),
  [`${E.RPC}|s1`]: reg(6),
  // The LATEST series end counts: one ended long ago, one recently.
  [`${E.TWO}|s1`]: reg(7),
  [`${E.TWO}|s2`]: reg(8),
  // A readable series long over, beside a record this build cannot read.
  [`${E.BROKEN}|s1`]: reg(9),
  [`${E.BROKEN}|s2`]: { onChainEventId: id(99), chainId: "not-a-number", contract: "0xnope" },
  [`${E.BEHIND}|s1`]: reg(13, OTHER_CHAIN),
  [`${E.KEEPS_DOOR}|s1`]: reg(10),
  [`${E.CHMOD}|s1`]: reg(11),
  [`${E.GATE}|s1`]: reg(12),
  [`${E.ENTRIES}|s1`]: reg(14),
  [`${E.ENTRIES_ONLY}|s1`]: reg(15),
  [`${E.ENTRIES_RECENT}|s1`]: reg(16),
  [`${E.HOLDS}|s1`]: reg(17),
  [`${E.HOLDS_RECENT}|s1`]: reg(18),
};

let dir: string;
let originalCwd: string;
let store: typeof import("../src/lib/checkin/store.js");
let retention: typeof import("../src/lib/checkin/roster-retention.js");
let guard: typeof import("../src/lib/event/end-date-guard.js");
let doorEntries: typeof import("../src/lib/checkin/door-entries.js");
let holds: typeof import("../src/lib/ticket-hold/store.js");

const reads: string[] = [];
let gate: Promise<void> | null = null;
const readEnd = async (_c: unknown, onChainEventId: string) => {
  reads.push(onChainEventId);
  if (gate) await gate;
  const e = ends[onChainEventId];
  if (e === "throw" || e === undefined) throw Object.assign(new Error(`rpc down at https://rpc.example/KEY for ${onChainEventId}`), { code: "SERVER_ERROR" });
  return e;
};
const clocks: Record<number, number> = { [CHAIN]: NOW, [OTHER_CHAIN]: NOW };
const chainNow = async (chainId: number) => clocks[chainId];
const sweep = (now = NOW) => retention.sweepExpiredRosters({ now, readEnd, chainNow });

const rosterFile = (eventId: string) =>
  join(dir, ".data", "checkin-rosters", `${createHash("sha256").update(eventId).digest("hex")}.json`);
const putRoster = (eventId: string) => store.storeRoster(eventId, { iv: "iv", ciphertext: "ct", updatedAt: new Date().toISOString() });
const hasRoster = (eventId: string) => existsSync(rosterFile(eventId));

before(async () => {
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "woco-883-"));
  mkdirSync(join(dir, ".data"));
  writeFileSync(join(dir, ".data", "onchain-events.json"), JSON.stringify(REGISTRY));
  // Every store captures `join(process.cwd(), ".data")` at module load.
  process.chdir(dir);
  process.env.CHECKIN_PASS_SECRET = "test-secret-for-roster-retention";
  store = await import("../src/lib/checkin/store.js");
  retention = await import("../src/lib/checkin/roster-retention.js");
  guard = await import("../src/lib/event/end-date-guard.js");
  doorEntries = await import("../src/lib/checkin/door-entries.js");
  holds = await import("../src/lib/ticket-hold/store.js");
});

after(() => {
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

test("a roster goes once its event ended over 2 days ago onchain; one inside the period stays", async () => {
  putRoster(E.OLD);
  putRoster(E.RECENT);
  writeFileSync(`${rosterFile(E.OLD)}.tmp`, "{}"); // a crashed write's copy goes with it
  assert.equal(await sweep(), 1);
  assert.equal(hasRoster(E.OLD), false);
  assert.equal(existsSync(`${rosterFile(E.OLD)}.tmp`), false);
  assert.equal(hasRoster(E.RECENT), true);
});

test("exactly 2 days is kept, by either clock; a moment more is not", async () => {
  putRoster(E.EDGE);
  try {
    clocks[CHAIN] = NOW + DAY;
    assert.equal(await sweep(NOW), 0, "the server clock at exactly 2 days");
    clocks[CHAIN] = NOW;
    assert.equal(await sweep(NOW + DAY), 0, "the chain clock at exactly 2 days");
    assert.equal(hasRoster(E.EDGE), true);
    clocks[CHAIN] = NOW + 1;
    assert.equal(await sweep(NOW + 1), 1);
  } finally {
    clocks[CHAIN] = NOW;
  }
  assert.equal(hasRoster(E.EDGE), false);
});

test("no trusted end keeps the roster: no registration, no end onchain, an unreadable record", async () => {
  putRoster(E.UNREG);
  putRoster(E.NOEND);
  putRoster(E.BROKEN);
  assert.equal(await sweep(NOW + 3650 * DAY), 0);
  for (const e of [E.UNREG, E.NOEND, E.BROKEN]) assert.equal(hasRoster(e), true);
  assert.equal(retention.rosterRetentionHealth().undated, 3);
});

test("the LATEST series end counts", async () => {
  putRoster(E.TWO);
  assert.equal(await sweep(), 0);
  assert.equal(hasRoster(E.TWO), true);
});

test("the earlier of the server and chain clocks decides", async () => {
  putRoster(E.BEHIND);
  clocks[OTHER_CHAIN] = NOW - 2 * DAY; // the chain says 1 day
  assert.equal(await sweep(), 0);
  assert.equal(hasRoster(E.BEHIND), true);
  clocks[OTHER_CHAIN] = NOW + 365 * DAY;
  assert.equal(await sweep(NOW - 2 * DAY), 0, "nor may a chain clock ahead of the server's");
  assert.equal(hasRoster(E.BEHIND), true);
  clocks[OTHER_CHAIN] = NOW;
  assert.equal(await sweep(), 1);
  assert.equal(hasRoster(E.BEHIND), false);
});

test("a chain that does not answer keeps the roster, reports the class only, and the next pass retries", async () => {
  putRoster(E.RPC);
  assert.equal(await sweep(), 0);
  assert.equal(hasRoster(E.RPC), true);
  const { lastError } = retention.rosterRetentionHealth();
  assert.match(lastError ?? "", /end unreadable \(rpc SERVER_ERROR\)/);
  assert.doesNotMatch(lastError ?? "", /KEY|https|0x/, "no RPC URL or event id on the public endpoint");

  ends[id(6)] = endedDaysAgo(40);
  assert.equal(await sweep(), 1);
  assert.equal(hasRoster(E.RPC), false);
  assert.equal(retention.rosterRetentionHealth().lastError, null);
});

test("the check-in set and the door pass are never touched", async () => {
  store.issueDoorPass(E.KEEPS_DOOR, Math.floor(NOW / 1000));
  const rec: CheckinRecord = { seriesId: "s1", edition: 1, at: "2026-09-01T20:00:00.000Z", deviceId: "deviceaaaaaaaaaa", method: "scan", claimId: "c1" };
  store.claimCheckin(E.KEEPS_DOOR, rec);
  putRoster(E.KEEPS_DOOR);
  const checkinsFile = join(dir, ".data", "checkins", `${createHash("sha256").update(E.KEEPS_DOOR).digest("hex")}.json`);
  const passes = readFileSync(join(dir, ".data", "door-passes.json"), "utf-8");
  const checkins = readFileSync(checkinsFile, "utf-8");

  assert.equal(await sweep(), 1);
  assert.equal(hasRoster(E.KEEPS_DOOR), false);
  assert.equal(readFileSync(join(dir, ".data", "door-passes.json"), "utf-8"), passes);
  assert.equal(readFileSync(checkinsFile, "utf-8"), checkins);
});

test("a second pass is a no-op; a roster uploaded again after the deadline goes on the next pass", async () => {
  const before = retention.rosterRetentionHealth().deleted;
  assert.equal(await sweep(), 0);
  assert.equal(retention.rosterRetentionHealth().deleted, before);

  putRoster(E.OLD);
  assert.equal(await sweep(), 1);
  assert.equal(hasRoster(E.OLD), false);
});

test("a delete that fails keeps nothing back from the next pass", async () => {
  putRoster(E.CHMOD);
  const rosters = join(dir, ".data", "checkin-rosters");
  chmodSync(rosters, 0o500);
  try {
    assert.equal(await sweep(), 0);
    assert.equal(hasRoster(E.CHMOD), true);
    assert.match(retention.rosterRetentionHealth().lastError ?? "", /delete failed \(EACCES\)/);
  } finally {
    chmodSync(rosters, 0o700);
  }
  assert.equal(await sweep(), 1);
  assert.equal(hasRoster(E.CHMOD), false);
});

test("a pass while one is running does nothing", async () => {
  guard._resetChainEndMemoForTests();
  putRoster(E.GATE);
  let release!: () => void;
  gate = new Promise((r) => (release = r));
  reads.length = 0;
  const first = sweep();
  const second = sweep();
  release();
  const [a, b] = await Promise.all([first, second]);
  gate = null;
  assert.equal(b, null);
  assert.equal(a, 1);
  assert.equal(reads.filter((r) => r === id(12)).length, 1, "one pass read the end");
  assert.equal(hasRoster(E.GATE), false);
});

test("/api/health status: run time, count and error - reported, never an alarm", () => {
  const h = retention.rosterRetentionHealth();
  assert.equal(h.keptAfterEndDays, 2);
  assert.equal(typeof h.lastRunAt, "string");
  assert.equal(h.deleted, 8, "every deletion above, counted once");
  assert.equal("ok" in h, false);
});

const entriesFile = (eventId: string) =>
  join(dir, ".data", "checkin-door-entries", `${createHash("sha256").update(eventId).digest("hex")}.json`);
const putEntries = (eventId: string) => doorEntries.startDoorEntries(eventId, "e".repeat(32), "ab".repeat(1216));

test("door entries go with the roster, and on their own when no roster was pushed", async () => {
  putRoster(E.ENTRIES);
  putEntries(E.ENTRIES);
  putEntries(E.ENTRIES_ONLY);
  putEntries(E.ENTRIES_RECENT);
  await sweep();
  assert.equal(hasRoster(E.ENTRIES), false);
  assert.equal(existsSync(entriesFile(E.ENTRIES)), false, "with the roster");
  assert.equal(existsSync(entriesFile(E.ENTRIES_ONLY)), false, "no roster: still on the clock");
  assert.equal(existsSync(entriesFile(E.ENTRIES_RECENT)), true, "inside the period");
});

test("#983: held tickets go on the same clock, with or without a roster, and none sooner", async () => {
  const { deriveXWingKeypairFromSeed } = await import("@woco/shared/crypto/xwing");
  const key = deriveXWingKeypairFromSeed("0x" + "4d".repeat(32)).publicKey;
  const hold = (eventId: string, sessionId: string) =>
    holds.holdTickets(
      { sessionId, eventId, seriesId: "s1", orderKeyRef: "ab".repeat(32), tickets: [{ edition: 1, qrContent: `woco://t/${eventId}/s1/1/0x${"cd".repeat(65)}` }] },
      async () => key,
    );
  assert.equal(await hold(E.HOLDS, "cs_test_sweep000001"), true);
  assert.equal(await hold(E.HOLDS, "cs_test_sweep000002"), true);
  assert.equal(await hold(E.HOLDS_RECENT, "cs_test_sweep000003"), true);
  await sweep();
  assert.equal(holds.getTicketHold("cs_test_sweep000001"), null, "every sale of the event");
  assert.equal(holds.getTicketHold("cs_test_sweep000002"), null);
  assert.ok(holds.getTicketHold("cs_test_sweep000003"), "inside the period");
});
