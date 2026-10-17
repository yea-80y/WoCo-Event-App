/**
 * The order-answer retention sweep (#547, `lib/attendee-batch/retention.ts`).
 * It erases, irreversibly, on a timer: every guard that keeps an order has a
 * test here that goes red when the guard is removed.
 *
 * Real ledger and held-order stores in a temp dir; chain, bee and clocks faked.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { concat, keccak256 } from "ethers";

process.chdir(mkdtempSync(join(tmpdir(), "woco-attendee-retention-")));
process.env.BEE_URL = "http://127.0.0.1:1";
process.env.EMAIL_HASH_SECRET ??= "0".repeat(64);
process.env.FEED_PRIVATE_KEY ??= "11".repeat(32);
process.env.OPS_TOKEN = "t".repeat(40);
delete process.env.ORDER_RETENTION_SWEEP;
delete process.env.ORDER_RETENTION_LIMIT;
globalThis.fetch = (async () => {
  throw new Error("no network in this test");
}) as unknown as typeof fetch;

const ledger = await import("../src/lib/attendee-batch/ledger.js");
const held = await import("../src/lib/attendee-batch/held-orders.js");
const writer = await import("../src/lib/attendee-batch/writer.js");
const retention = await import("../src/lib/attendee-batch/retention.js");
const { eraseOrder } = await import("../src/lib/attendee-batch/erase.js");
const { ops } = await import("../src/routes/ops.js");
const { readyAttendeeStore, acceptingUploadChunk } = await import("./helpers/attendee-store.js");
const { canonicalOrderBox } = await import("../src/lib/stripe/order-ref.js");
const { recordEventFeedSigner } = await import("../src/lib/event/feed-signer-record.js");
type RetentionDeps = import("../src/lib/attendee-batch/retention.js").RetentionDeps;
type EventContractTarget = import("../src/lib/chain/event-contract.js").EventContractTarget;

const DAY = 86_400_000;
/** Series end onchain. + 6 months = 2026-07-31T18:00Z, + 12 = 2027-01-31T18:00Z. */
const END = Date.parse("2026-01-31T18:00:00.000Z");
const DUE6 = Date.parse("2026-07-31T18:00:00.000Z");
const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const CONTRACT = { chainId: 42161, address: "0x" + "c0".repeat(20), version: "ledger" } as unknown as EventContractTarget;
const ORGANISER = "0x" + "4b".repeat(20);
recordEventFeedSigner("ev", "0x" + "fe".repeat(20), ORGANISER);

let stamper = "";
let batchId = "";
async function fresh(): Promise<void> {
  rmSync(join(process.cwd(), ".data"), { recursive: true, force: true });
  ledger._resetAttendeeLedgerForTests();
  held._resetHeldOrdersForTests();
  ({ stamper, batchId } = await readyAttendeeStore());
  retention._resetOrderRetentionForTests(NOW);
}

const storeDeps = { stamper: writer.getAttendeeStamper, upload: async (e: unknown, b: Uint8Array) => (await acceptingUploadChunk(e, b)).reference.toHex() };
const honestBurns = {
  stamper: writer.getAttendeeStamper,
  upload: async (burner: { identifier: Uint8Array; owner: Uint8Array }) => keccak256(concat([burner.identifier, burner.owner])).slice(2),
};

let seq = 0;
async function stored(meta: { retainMonths?: number; eventId?: string | null; seriesId?: string } = {}): Promise<string> {
  const eventId = meta.eventId === null ? undefined : (meta.eventId ?? "ev");
  return writer.storeAttendeePayload(`order ${++seq} `.repeat(300), {
    kind: "checkout",
    ...(eventId ? { eventId, seriesId: meta.seriesId ?? "s1" } : {}),
    ...("retainMonths" in meta ? (meta.retainMonths !== undefined ? { retainMonths: meta.retainMonths } : {}) : { retainMonths: 6 }),
  }, storeDeps as never);
}
async function heldOrder(opts: { paid?: boolean; retainMonths?: number } = {}): Promise<string> {
  const json = canonicalOrderBox({ v: 2, enc: "ab".repeat(1120), ct: (++seq).toString(16).padStart(4, "0").repeat(32) })!;
  const ref = await writer.orderRefOf(json);
  held.commitHold(ref, json, { eventId: "ev", seriesId: "s1" });
  if (opts.paid !== false) held.markHeldPaid(ref, `cs_${seq}`, NOW, { emailHash: "aa".repeat(32), retainMonths: opts.retainMonths ?? 6 });
  return ref;
}

/** Ends per series id; "throw" = the RPC cannot answer; null = no end onchain (V1). */
function fakeDeps(over: Partial<RetentionDeps> & { ends?: Record<string, number | null | "throw"> } = {}) {
  const calls = { erase: [] as string[], sleeps: [] as number[], chainEnd: 0, chainNow: 0 };
  const { ends, ...rest } = over;
  const deps: RetentionDeps = {
    now: () => NOW,
    chainNow: async () => {
      calls.chainNow++;
      return NOW;
    },
    registration: (_e, s) => ({ onChainEventId: `0x${Buffer.from(s).toString("hex").padStart(64, "0")}`, contract: CONTRACT }),
    chainEnd: async (_c, id) => {
      calls.chainEnd++;
      const s = Buffer.from(id.slice(2).replace(/^0+/, ""), "hex").toString();
      const v = ends && s in ends ? ends[s] : END;
      if (v === "throw") throw new Error("rpc down");
      return v;
    },
    batch: async () => ({ owner: stamper, depth: 20, bucketDepth: 16, immutable: false, batchTTL: 30 * 86400 }),
    stamper: () => stamper,
    inFlight: () => false,
    erase: async (root, erasure) => {
      calls.erase.push(root);
      return eraseOrder(root, erasure, honestBurns as never);
    },
    sessions: () => new Map(),
    paceMs: 7,
    sleep: async (ms) => {
      calls.sleeps.push(ms);
    },
    ...rest,
  };
  return { deps, calls };
}

const live = (deps: RetentionDeps, limit?: number) => retention.runOrderRetention({ mode: "live", deps, ...(limit ? { limit } : {}) });
function ok(run: Awaited<ReturnType<typeof live>>) {
  assert.equal(run.refused, null, run.refused ?? "");
  return run as Extract<typeof run, { refused: null }>;
}

// ── Due date and erasure ───────────────────────────────────────────────────

test("a due order is erased with its rule recorded; one not yet due is kept", async () => {
  await fresh();
  const due = await stored({ retainMonths: 6 });
  const later = await stored({ retainMonths: 12 });
  const { deps } = fakeDeps();
  const { summary } = ok(await live(deps));
  const rec = ledger.getOrderRecord(due)!;
  assert.equal(rec.state, "burned");
  assert.equal(rec.erasedBy, "retention");
  assert.deepEqual(rec.retentionRule, { retainMonths: 6, endMs: END, endSource: "chain", dueAt: "2026-07-31T18:00:00.000Z" });
  assert.equal(ledger.isOrderErased(later), false);
  assert.equal(summary.due, 1);
  assert.equal(summary.erased, 1);
  assert.equal(summary.notDue, 1);
  assert.equal(summary.oldestOverdueDays, null, "nothing left overdue");
});

test("the due instant: a millisecond before is kept, the instant itself is due", async () => {
  await fresh();
  const ref = await stored();
  const before = fakeDeps({ now: () => DUE6 - 1, chainNow: async () => DUE6 - 1 });
  ok(await live(before.deps));
  assert.equal(ledger.isOrderErased(ref), false);
  const at = fakeDeps({ now: () => DUE6, chainNow: async () => DUE6 });
  ok(await live(at.deps));
  assert.equal(ledger.isOrderErased(ref), true);
});

test("no period, or one an organiser cannot pick, is never erased - and needs no chain read", async () => {
  await fresh();
  const none = await stored({ retainMonths: undefined });
  const three = await stored({ retainMonths: 3 });
  const { deps, calls } = fakeDeps();
  const { summary, items } = ok(await live(deps));
  assert.deepEqual(calls.erase, []);
  assert.equal(calls.chainEnd, 0);
  assert.equal(summary.skipped.noRetainMonths, 2);
  assert.equal(ledger.isOrderErased(none) || ledger.isOrderErased(three), false);
  assert.ok(items.every((it) => it.reason === "noRetainMonths" && it.daysOverdue === null));
});

test("the sweep reads no notice: the period is the sale's snapshot", () => {
  const src = readFileSync(new URL("../src/lib/attendee-batch/retention.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /notice-gate|organiser-notice|organiserNotice/);
});

// ── Undeterminable: kept, counted, never overdue ──────────────────────────

test("no eventId/seriesId, no registration, no end onchain, an RPC that cannot answer: kept, never overdue", async () => {
  await fresh();
  const noIds = await stored({ eventId: null });
  const unregistered = await stored({ seriesId: "unreg" });
  const v1 = await stored({ seriesId: "v1" });
  const down = await stored({ seriesId: "down" });
  const { deps, calls } = fakeDeps({
    ends: { v1: null, down: "throw" },
    registration: (_e, s) => (s === "unreg" ? null : { onChainEventId: `0x${Buffer.from(s).toString("hex").padStart(64, "0")}`, contract: CONTRACT }),
  });
  const { summary } = ok(await live(deps));
  assert.deepEqual(calls.erase, []);
  for (const r of [noIds, unregistered, v1, down]) assert.equal(ledger.isOrderErased(r), false);
  assert.deepEqual(
    { ...summary.undeterminable },
    { noEventSeries: 1, noRegistration: 1, chainUnavailable: 1, noChainEnd: 1, total: 4 },
  );
  assert.equal(summary.due, 0);
  assert.equal(summary.oldestOverdueDays, null);
});

test("now is the earlier clock: a chain behind the server keeps the order, a chain that cannot answer keeps it", async () => {
  await fresh();
  const ref = await stored();
  const behind = fakeDeps({ chainNow: async () => DUE6 - DAY });
  ok(await live(behind.deps));
  assert.equal(ledger.isOrderErased(ref), false, "chain clock before due");
  const down = fakeDeps({ chainNow: async () => { throw new Error("rpc down"); } });
  const { summary } = ok(await live(down.deps));
  assert.equal(ledger.isOrderErased(ref), false);
  assert.equal(summary.undeterminable.chainUnavailable, 1);
  assert.equal(summary.due, 0, "undeterminable, never overdue");
  assert.equal(summary.oldestOverdueDays, null);
  // A server clock before due is never overruled by a chain clock after it.
  let chainReads = 0;
  const early = fakeDeps({ now: () => DUE6 - DAY, chainNow: async () => (chainReads++, NOW) });
  ok(await live(early.deps));
  assert.equal(chainReads, 0);
  assert.equal(ledger.isOrderErased(ref), false);
});

// ── Due but kept ───────────────────────────────────────────────────────────

test("a store in flight is skipped", async () => {
  await fresh();
  const ref = await stored();
  const { deps, calls } = fakeDeps({ inFlight: () => true });
  const { summary } = ok(await live(deps));
  assert.deepEqual(calls.erase, []);
  assert.equal(summary.skipped.inFlight, 1);
  assert.equal(ledger.isOrderErased(ref), false);
});

test("no stamper, or a batch the stamper does not own: skipped", async () => {
  await fresh();
  const ref = await stored();
  const noKey = fakeDeps({ stamper: () => null });
  assert.equal(ok(await live(noKey.deps)).summary.skipped.noStamper, 1);
  const other = fakeDeps({ batch: async () => ({ owner: "0x" + "99".repeat(20), depth: 20, bucketDepth: 16, immutable: false, batchTTL: 86400 }) });
  assert.equal(ok(await live(other.deps)).summary.skipped.stamperNotOwner, 1);
  assert.deepEqual([...noKey.calls.erase, ...other.calls.erase], []);
  assert.equal(ledger.isOrderErased(ref), false);
});

const deadBatch = (ttl: number) => async () => ({ owner: stamper, depth: 20, bucketDepth: 16, immutable: false, batchTTL: ttl });

test("a batch the chain says is dead, or bee does not list, is counted apart, kept, never tombstoned and never overdue (#884)", async () => {
  await fresh();
  const ref = await stored();
  const cases = [
    { batch: async () => null, reason: "batchUnlisted" as const },
    { batch: deadBatch(0), reason: "batchDead" as const },
    { batch: deadBatch(-1), reason: "batchDead" as const },
  ];
  for (const { batch, reason } of cases) {
    const { deps, calls } = fakeDeps({ batch });
    const { summary, items } = ok(await live(deps));
    assert.equal(summary.skipped[reason], 1, reason);
    assert.equal(summary.skipped[reason === "batchDead" ? "batchUnlisted" : "batchDead"], 0, reason);
    assert.deepEqual(calls.erase, []);
    assert.equal(summary.due, 1, "still due");
    assert.equal(items[0]!.reason, reason);
    assert.equal(summary.oldestOverdueDays, null, `${reason} is not overdue`);
    const rec = ledger.getOrderRecord(ref)!;
    assert.equal(rec.state, "stored");
    assert.equal(rec.erasedBy, undefined);
  }
  // A lookup that throws cannot say: unknown, and that one stays overdue.
  const unknown = ok(await live(fakeDeps({ batch: async () => { throw new Error("bee down"); } }).deps)).summary;
  assert.equal(unknown.skipped.batchUnknown, 1);
  assert.equal(unknown.skipped.batchUnlisted + unknown.skipped.batchDead, 0);
  assert.ok(unknown.oldestOverdueDays! > 70);
  // A TTL that is not a number is a reading we cannot trust, never a quiet "dead".
  for (const ttl of [Number.NaN, "0" as unknown as number, undefined as unknown as number]) {
    const odd = ok(await live(fakeDeps({ batch: deadBatch(ttl) }).deps)).summary;
    assert.equal(odd.skipped.batchUnknown, 1, String(ttl));
    assert.equal(odd.skipped.batchDead, 0, String(ttl));
    assert.ok(odd.oldestOverdueDays! > 70, String(ttl));
  }
  // The ledger says expired; the chain says alive: the chain decides.
  ledger.setBatchExpiry(batchId, new Date(NOW - 30 * DAY).toISOString());
  ok(await live(fakeDeps().deps));
  assert.equal(ledger.getOrderRecord(ref)?.state, "burned");
});

// ── Runs ───────────────────────────────────────────────────────────────────

test("a dry run decides everything and erases nothing", async () => {
  await fresh();
  const ref = await stored();
  const h = await heldOrder();
  const { deps, calls } = fakeDeps();
  const { summary, items } = ok(await retention.runOrderRetention({ mode: "dry-run", deps }));
  assert.deepEqual(calls.erase, []);
  assert.deepEqual(calls.sleeps, []);
  assert.equal(summary.wouldErase, 2);
  assert.equal(summary.erased, 0);
  assert.equal(ledger.isOrderErased(ref), false);
  assert.ok(held.getHeldOrder(h));
  assert.ok(items.every((it) => it.action === "erase" && it.reason === null));
});

test("the per-run limit holds, oldest due first, paced between erasures", async () => {
  await fresh();
  const a = await stored({ seriesId: "a" });
  const b = await stored({ seriesId: "b" });
  const c = await stored({ seriesId: "c" });
  const { deps, calls } = fakeDeps({ ends: { a: END + 2 * DAY, b: END, c: END + DAY } });
  const { summary } = ok(await live(deps, 2));
  assert.deepEqual(calls.erase, [b, c]);
  assert.deepEqual(calls.sleeps, [7], "one pause, between the two");
  assert.equal(summary.skipped.overLimit, 1);
  assert.equal(ledger.isOrderErased(a), false);
  assert.equal(summary.backlog, 1);
  assert.equal(summary.oldestBacklogDays, Math.round(((NOW - (DUE6 + 2 * DAY)) / DAY) * 10) / 10);
  assert.equal(summary.oldestOverdueDays, null, "held back by the limit is backlog, not overdue");
});

test("backlog and overdue are told apart in one run", async () => {
  await fresh();
  await stored({ seriesId: "a" });
  await stored({ seriesId: "b" });
  await stored({ seriesId: "c" });
  // b is the oldest and blocked (in flight), a is erased, c is held back by the limit.
  const { deps } = fakeDeps({ ends: { a: END + DAY, b: END, c: END + 3 * DAY } });
  let n = 0;
  const { summary } = ok(await live({ ...deps, inFlight: () => n++ === 0 }, 1));
  assert.deepEqual([summary.erased, summary.skipped.inFlight, summary.backlog], [1, 1, 1]);
  assert.equal(summary.oldestOverdueDays, Math.round(((NOW - DUE6) / DAY) * 10) / 10);
  assert.equal(summary.oldestBacklogDays, Math.round(((NOW - (DUE6 + 3 * DAY)) / DAY) * 10) / 10);
});

test("an order already erased is not touched again", async () => {
  await fresh();
  const ref = await stored();
  await eraseOrder(ref, { by: "request" }, honestBurns as never);
  const tomb = await heldOrder();
  await eraseOrder(tomb, { by: "request" });
  const { deps, calls } = fakeDeps();
  const { summary } = ok(await live(deps));
  assert.deepEqual(calls.erase, []);
  assert.equal(summary.due, 0);
  assert.equal(ledger.getOrderRecord(ref)?.erasedBy, "request");
  assert.equal(ledger.getOrderRecord(tomb)?.erasedBy, "request");
});

test("a stored order whose hold was never released is one order, erased once", async () => {
  await fresh();
  const ref = await heldOrder({ retainMonths: 6 });
  await writer.storeAttendeePayload(held.getHeldOrder(ref)!.json, { kind: "checkout", eventId: "ev", seriesId: "s1", retainMonths: 6 }, storeDeps as never);
  assert.ok(held.getHeldOrder(ref), "the hold outlived the store");
  const { deps, calls } = fakeDeps();
  const { summary, items } = ok(await live(deps));
  assert.deepEqual(calls.erase, [ref]);
  assert.equal(items.length, 1);
  assert.equal(summary.erased, 1);
  assert.equal(held.getHeldOrder(ref), null);
  assert.equal(ledger.getOrderRecord(ref)?.state, "burned");
});

test("an order on a batch the ledger does not know is kept", async () => {
  await fresh();
  const ref = await stored();
  const file = join(process.cwd(), ".data", "attendee-slots.json");
  const raw = JSON.parse(readFileSync(file, "utf8"));
  raw.orders[ref].batchId = "0d".repeat(32);
  writeFileSync(file, JSON.stringify(raw));
  ledger._resetAttendeeLedgerForTests();
  const { deps, calls } = fakeDeps();
  const { summary } = ok(await live(deps));
  assert.deepEqual(calls.erase, []);
  assert.equal(summary.skipped.batchUnknown, 1);
  assert.ok(summary.oldestOverdueDays! > 70, "unknown, not unlisted: still overdue");
});

test("a paid order still held is erased too: hold deleted, tombstone with the rule, period and organiser", async () => {
  await fresh();
  const ref = await heldOrder({ retainMonths: 6 });
  const unpaid = await heldOrder({ paid: false });
  const { deps, calls } = fakeDeps();
  const { summary } = ok(await live(deps));
  assert.deepEqual(calls.erase, [ref], "an unpaid hold is the 24 h rule's, not the sweep's");
  assert.equal(summary.erased, 1);
  assert.equal(held.getHeldOrder(ref), null);
  const rec = ledger.getOrderRecord(ref)!;
  assert.equal(rec.state, "burned");
  assert.equal(rec.erasedBy, "retention");
  assert.equal(rec.retainMonths, 6);
  assert.equal(rec.organiser, ORGANISER);
  assert.equal(rec.retentionRule?.dueAt, "2026-07-31T18:00:00.000Z");
  assert.ok(held.getHeldOrder(unpaid));
});

test("an unreadable attendee ledger refuses the whole run", async () => {
  await fresh();
  await stored();
  writeFileSync(join(process.cwd(), ".data", "attendee-slots.json"), "{ not json");
  ledger._resetAttendeeLedgerForTests();
  const { deps, calls } = fakeDeps();
  const run = await live(deps);
  assert.equal(run.refused !== null && run.why, "stores");
  assert.deepEqual(calls.erase, []);
  assert.equal(retention.orderRetentionHealth(NOW).checks.stores.ok, false);
});

test("one unreadable held order refuses the whole run", async () => {
  await fresh();
  const ref = await stored();
  mkdirSync(join(process.cwd(), ".data", "held-orders"), { recursive: true });
  writeFileSync(join(process.cwd(), ".data", "held-orders", `${"ef".repeat(32)}.json`), "garbage");
  held._resetHeldOrdersForTests();
  const { deps, calls } = fakeDeps();
  const run = await live(deps);
  assert.equal(run.refused !== null && run.why, "stores");
  assert.deepEqual(calls.erase, []);
  assert.equal(ledger.isOrderErased(ref), false);
});

test("one run at a time; off refuses", async () => {
  await fresh();
  await stored();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { deps } = fakeDeps({ chainEnd: async () => { await gate; return END; } });
  const first = live(deps);
  const second = await Promise.race([live(deps), new Promise<"hung">((r) => setTimeout(() => r("hung"), 2000).unref())]);
  assert.ok(second !== "hung" && second.refused !== null && second.why === "busy", "a second run is refused, not queued");
  release();
  ok(await first);
  const off = await retention.runOrderRetention({ mode: "off", deps });
  assert.equal(off.refused !== null && off.why, "off");
});

test("an erase that fails is counted, stays overdue, and the run carries on", async () => {
  await fresh();
  const a = await stored({ seriesId: "a" });
  const b = await stored({ seriesId: "b" });
  const { deps } = fakeDeps({
    ends: { a: END, b: END + DAY },
    erase: async (root, erasure) => (root === a ? Promise.reject(new Error("bee down")) : eraseOrder(root, erasure, honestBurns as never)),
  });
  const { summary } = ok(await live(deps));
  assert.equal(summary.skipped.eraseFailed, 1);
  assert.equal(summary.erased, 1);
  assert.equal(ledger.isOrderErased(b), true);
  assert.ok(summary.oldestOverdueDays! > 70);
});

// ── Config and health ──────────────────────────────────────────────────────

test("mode: unset or unrecognised is a dry run; only an explicit live erases; the default limit is 500", () => {
  assert.deepEqual(retention.retentionConfig({}), { mode: "dry-run", limit: 500, configError: false });
  assert.equal(retention.retentionConfig({ ORDER_RETENTION_SWEEP: " LIVE " }).mode, "live");
  assert.equal(retention.retentionConfig({ ORDER_RETENTION_SWEEP: "off" }).mode, "off");
  assert.deepEqual(retention.retentionConfig({ ORDER_RETENTION_SWEEP: "yes" }), { mode: "dry-run", limit: 500, configError: true });
  assert.equal(retention.retentionConfig({ ORDER_RETENTION_LIMIT: "1" }).limit, 1);
  for (const bad of ["0", "-1", "1.5", "501", "x"]) {
    assert.deepEqual(retention.retentionConfig({ ORDER_RETENTION_LIMIT: bad }), { mode: "dry-run", limit: 500, configError: true }, bad);
  }
});

function withMode<T>(mode: string | undefined, f: () => T): T {
  const before = process.env.ORDER_RETENTION_SWEEP;
  if (mode === undefined) delete process.env.ORDER_RETENTION_SWEEP;
  else process.env.ORDER_RETENTION_SWEEP = mode;
  try {
    return f();
  } finally {
    if (before === undefined) delete process.env.ORDER_RETENTION_SWEEP;
    else process.env.ORDER_RETENTION_SWEEP = before;
  }
}

async function withModeAsync(mode: string, f: () => Promise<void>): Promise<void> {
  process.env.ORDER_RETENTION_SWEEP = mode;
  try {
    await f();
  } finally {
    delete process.env.ORDER_RETENTION_SWEEP;
  }
}

test("health: red when live and an order is over a week past due; a dry run reports it without alarming", async () => {
  await fresh();
  await stored();
  ok(await live(fakeDeps({ inFlight: () => true }).deps));
  const liveHealth = withMode("live", () => retention.orderRetentionHealth(NOW));
  assert.equal(liveHealth.ok, false);
  assert.equal(liveHealth.checks.overdue.ok, false);
  assert.equal(liveHealth.skipped?.inFlight, 1);
  const dry = withMode(undefined, () => retention.orderRetentionHealth(NOW));
  assert.equal(dry.checks.overdue.ok, true);
  assert.ok(dry.oldestOverdueDays! > 7);
});

test("health: a week or less past due is not red", async () => {
  await fresh();
  await stored();
  ok(await live(fakeDeps({ inFlight: () => true, now: () => DUE6 + 7 * DAY, chainNow: async () => DUE6 + 7 * DAY }).deps));
  assert.equal(withMode("live", () => retention.orderRetentionHealth(NOW)).checks.overdue.ok, true);
});

test("health: a backlog the limit holds back is red only when live and over 14 days past due", async () => {
  for (const [daysPast, red] of [[14, false], [15, true]] as const) {
    await fresh();
    await stored({ seriesId: "a" });
    await stored({ seriesId: "b" });
    const at = DUE6 + daysPast * DAY;
    ok(await live(fakeDeps({ now: () => at, chainNow: async () => at }).deps, 1));
    const h = withMode("live", () => retention.orderRetentionHealth(at));
    assert.equal(h.backlog, 1);
    assert.equal(h.oldestBacklogDays, daysPast);
    assert.equal(h.oldestOverdueDays, null);
    assert.equal(h.checks.overdue.ok, true, "a backlog is never overdue");
    assert.equal(h.checks.backlog.ok, !red, `${daysPast} days`);
    assert.equal(h.ok, !red);
    assert.equal(withMode(undefined, () => retention.orderRetentionHealth(at)).checks.backlog.ok, true, "a dry run never alarms");
  }
});

test("health: a batch bee does not list is red at the third run in a row, live only; a run without one resets it", async () => {
  await fresh();
  await stored();
  const unlisted = fakeDeps({ batch: async () => null }).deps;
  const health = (mode?: string) => withMode(mode, () => retention.orderRetentionHealth(NOW));
  for (const n of [1, 2]) {
    ok(await live(unlisted));
    assert.equal(health("live").unlistedStreak, n);
    assert.equal(health("live").checks.batchUnlisted.ok, true, `run ${n}`);
    assert.equal(health("live").ok, true, "not overdue either");
  }
  ok(await live(unlisted));
  assert.equal(health("live").unlistedStreak, 3);
  assert.equal(health("live").checks.batchUnlisted.ok, false);
  assert.equal(health("live").ok, false);
  assert.equal(health(undefined).checks.batchUnlisted.ok, true, "a dry run never alarms");
  // A run that meets no unlisted batch (here, the store is in flight) resets the streak.
  ok(await live(fakeDeps({ inFlight: () => true }).deps));
  assert.equal(health("live").unlistedStreak, 0);
  assert.equal(health("live").checks.batchUnlisted.ok, true);
  ok(await live(unlisted));
  assert.equal(health("live").unlistedStreak, 1, "counts again from one");
  assert.equal(health("live").checks.batchUnlisted.ok, true);
});

test("health: a dead batch never alarms, however many runs meet it", async () => {
  await fresh();
  const ref = await stored();
  for (let i = 0; i < 4; i++) ok(await live(fakeDeps({ batch: deadBatch(0) }).deps));
  const h = withMode("live", () => retention.orderRetentionHealth(NOW));
  assert.equal(h.skipped?.batchDead, 1);
  assert.equal(h.oldestOverdueDays, null);
  assert.equal(h.unlistedStreak, 0);
  assert.ok(Object.values(h.checks).every((c) => c.ok), JSON.stringify(h.checks));
  assert.equal(h.ok, true);
  assert.equal(ledger.isOrderErased(ref), false);
});

test("health: undeterminable orders are counted, never overdue", async () => {
  await fresh();
  await stored({ seriesId: "v1" });
  ok(await live(fakeDeps({ ends: { v1: null } }).deps));
  const h = withMode("live", () => retention.orderRetentionHealth(NOW));
  assert.equal(h.ok, true);
  assert.equal(h.undeterminable?.total, 1);
  assert.equal(h.oldestOverdueDays, null);
});

test("health: no completed run in 48 h is red unless the sweep is off; a bad mode is red", () => {
  retention._resetOrderRetentionForTests(NOW - 49 * 60 * 60 * 1000);
  assert.equal(withMode(undefined, () => retention.orderRetentionHealth(NOW)).checks.ran.ok, false);
  assert.equal(withMode("off", () => retention.orderRetentionHealth(NOW)).checks.ran.ok, true);
  retention._resetOrderRetentionForTests(NOW - 47 * 60 * 60 * 1000);
  assert.equal(withMode(undefined, () => retention.orderRetentionHealth(NOW)).checks.ran.ok, true);
  assert.equal(withMode("liev", () => retention.orderRetentionHealth(NOW)).checks.config.ok, false);
});

// ── Ops routes ─────────────────────────────────────────────────────────────

const app = new Hono();
app.route("/api/ops", ops);
const auth = { authorization: `Bearer ${"t".repeat(40)}`, "content-type": "application/json" };

test("ops preview lists every order with its due date and action, erasing nothing", async () => {
  await fresh();
  const ref = await stored();
  await stored({ retainMonths: 12 });
  const { deps, calls } = fakeDeps({ sessions: () => new Map([[ref, "cs_live_1"]]) });
  retention._resetOrderRetentionForTests(NOW, deps);
  const res = await app.request("/api/ops/attendee-batch/retention/preview?limit=5", { headers: auth });
  assert.equal(res.status, 200);
  const data = ((await res.json()) as { data: { mode: string; limit: number; totals: { erase: number; wait: number }; socUploads: number; items: Array<Record<string, unknown>> } }).data;
  assert.equal(data.mode, "dry-run");
  assert.equal(data.limit, 5);
  assert.deepEqual([data.totals.erase, data.totals.wait], [1, 1]);
  const item = data.items.find((it) => it.sessionId === "cs_live_1")!;
  assert.equal(item.rootPrefix, ref.slice(0, 16));
  assert.equal(item.eventId, "ev");
  assert.equal(item.seriesId, "s1");
  assert.equal(item.organiser, ORGANISER);
  assert.equal(item.chainEnd, new Date(END).toISOString());
  assert.equal(item.retainMonths, 6);
  assert.equal(item.dueAt, "2026-07-31T18:00:00.000Z");
  assert.ok((item.daysOverdue as number) > 70);
  assert.equal(item.action, "erase");
  assert.equal(data.socUploads, item.chunks);
  assert.deepEqual(calls.erase, []);
  assert.equal((await app.request("/api/ops/attendee-batch/retention/preview?limit=0", { headers: auth })).status, 400);
});

test("ops run: needs `by`, takes the configured mode, erases at most `limit`", async () => {
  await fresh();
  const a = await stored({ seriesId: "a" });
  const b = await stored({ seriesId: "b" });
  const { deps, calls } = fakeDeps({ ends: { a: END, b: END + DAY } });
  retention._resetOrderRetentionForTests(NOW, deps);
  const run = (body: unknown) => app.request("/api/ops/attendee-batch/retention/run", { method: "POST", headers: auth, body: JSON.stringify(body) });
  assert.equal((await run({ limit: 1 })).status, 400);
  assert.equal((await run({ by: "op", limit: 0 })).status, 400);
  const dry = await run({ by: "op", limit: 1 });
  assert.equal(dry.status, 200);
  assert.deepEqual(calls.erase, [], "default mode is a dry run");
  await withModeAsync("live", async () => {
    const res = await run({ by: "op", limit: 1 });
    assert.equal(res.status, 200);
    const data = ((await res.json()) as { data: { summary: { erased: number }; due: Array<{ rootPrefix: string; reason: string }> } }).data;
    assert.equal(data.summary.erased, 1);
    assert.deepEqual(data.due.map((d) => [d.rootPrefix, d.reason]), [[a.slice(0, 16), "erased"], [b.slice(0, 16), "overLimit"]]);
  });
  assert.deepEqual(calls.erase, [a]);
  assert.equal(ledger.getOrderRecord(a)?.erasedBy, "retention");
  await withModeAsync("off", async () => assert.equal((await run({ by: "op" })).status, 409));
});

test("wiring: a daily timer runs the sweep and /api/health reports it", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(src, /orderRetention: orderRetentionHealth\(\),/);
  assert.match(src, /runOrderRetention\(\)\.catch\(/);
  assert.match(src, /setInterval\(sweepOrderRetention, 24 \* 60 \* 60 \* 1000\)\.unref\(\);/);
});
