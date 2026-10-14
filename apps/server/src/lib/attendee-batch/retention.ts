/**
 * Order-answer retention sweep (#547). Each buyer's sealed order is erased
 * `retainMonths` UTC calendar months after the onchain end of the series they
 * bought: the period the organiser's notice gave when the sale was made,
 * snapshotted at checkout and carried to the ledger. It is the organiser's
 * standing instruction to WoCo as their processor (DPA Annex 3), carried out
 * through the same `eraseOrder` an erasure request uses. The sweep reads no
 * notice: a later edit is not an instruction about past sales.
 *
 * Erasure is irreversible and keeping an order one more day is not, so every
 * doubt keeps the order, counted so it is seen:
 *   - no retainMonths, or one an organiser cannot pick: never erased;
 *   - the clock is the series' onchain `eventEndTs` (fixed at registration),
 *     never the organiser-signed feed `endDate`; no eventId/seriesId, no
 *     registration record, an RPC that cannot answer or no end onchain keeps it;
 *   - "now" is the earlier of our clock and the chain's, so a fast server
 *     clock cannot erase early;
 *   - a store in flight, no stamper, a batch the stamper does not own, or a
 *     batch the chain says is dead, does not list, or cannot say: kept. Dead is
 *     read from chain at sweep time, never from the ledger's `expiresAt` (#884),
 *     and is never recorded as an erasure: nothing was erased;
 *   - the attendee ledger or any held order unreadable: the whole run refuses.
 *     An unreadable ledger loads empty, and an unreadable hold is an order we
 *     cannot see.
 *
 * `ORDER_RETENTION_SWEEP` = off | dry-run (default) | live. Sequential and
 * paced, at most `ORDER_RETENTION_LIMIT` erasures a run (default 500, about 17
 * minutes at the 2 s pace): each burn is one synchronous SOC push per chunk
 * through the upload queue that checkout uses too.
 *
 * Overdue (red after a week, live only) counts only orders someone can act on.
 * Not overdue: an order held back by the limit is `backlog` (red only past two
 * weeks: the sweep is not keeping up), a dead batch can never be erased (counted,
 * never red), and a batch bee does not list may be a transient miss (#884; red
 * after three runs in a row).
 */

import { addCalendarMonthsUtc, isNoticeRetentionMonths } from "@woco/shared";
import { chainTimeMs, contractKey, type EventContractTarget } from "../chain/event-contract.js";
import { chainEventEndMsAt } from "../event/end-date-guard.js";
import { lookupOnChainEventId, registrationContractFor } from "../event/onchain-registry.js";
import { saleSessionsByOrderRef } from "../stripe/ticket-sales.js";
import { liveBatchLookup, type BatchLookup, type ChainBatch } from "./admin.js";
import { eraseOrder, type EraseOutcome } from "./erase.js";
import { heldOrdersHealth, paidUnstored, type HeldOrder } from "./held-orders.js";
import { getBatchRecord, getOrderRecord, ledgerReadable, listOrders, type Erasure, type OrderRecord } from "./ledger.js";
import { attendeeStamperAddress, isStoreInFlight } from "./writer.js";

export type RetentionMode = "off" | "dry-run" | "live";

const DAY_MS = 86_400_000;
const DEFAULT_LIMIT = 500;
export const MAX_LIMIT = 500;
const OVERDUE_ALARM_DAYS = 7;
const BACKLOG_ALARM_DAYS = 14;
const UNLISTED_ALARM_RUNS = 3;
const NO_RUN_ALARM_MS = 48 * 60 * 60 * 1000;
const days = (ms: number | null) => (ms === null ? null : Math.round((ms / DAY_MS) * 10) / 10);

export function retentionConfig(env: NodeJS.ProcessEnv = process.env): { mode: RetentionMode; limit: number; configError: boolean } {
  const rawMode = (env.ORDER_RETENTION_SWEEP ?? "").trim().toLowerCase();
  const known = rawMode === "off" || rawMode === "dry-run" || rawMode === "live";
  const rawLimit = (env.ORDER_RETENTION_LIMIT ?? "").trim();
  const n = Number(rawLimit);
  const limitOk = Number.isInteger(n) && n > 0 && n <= MAX_LIMIT;
  return {
    // Unset or unrecognised is a dry run: erasing is never what a typo gets.
    mode: known ? (rawMode as RetentionMode) : "dry-run",
    limit: limitOk ? n : DEFAULT_LIMIT,
    configError: (rawMode !== "" && !known) || (rawLimit !== "" && !limitOk),
  };
}

/** Why a due date cannot be worked out. Never counted as overdue. */
export type Undetermined = "noEventSeries" | "noRegistration" | "chainUnavailable" | "noChainEnd";
/** Why an order is not erased this run, though it may be due. */
export type Skip =
  | "noRetainMonths"
  | "inFlight"
  | "noStamper"
  | "stamperNotOwner"
  | "batchDead"
  | "batchUnlisted"
  | "batchUnknown"
  | "overLimit"
  | "eraseFailed";

const UNDETERMINED: Undetermined[] = ["noEventSeries", "noRegistration", "chainUnavailable", "noChainEnd"];
const SKIPS: Skip[] = ["noRetainMonths", "inFlight", "noStamper", "stamperNotOwner", "batchDead", "batchUnlisted", "batchUnknown", "overLimit", "eraseFailed"];

export interface RetentionItem {
  rootPrefix: string;
  source: "ledger" | "held";
  eventId: string | null;
  seriesId: string | null;
  organiser: string | null;
  sessionId: string | null;
  kind: string;
  state: string;
  chainEnd: string | null;
  retainMonths: number | null;
  dueAt: string | null;
  daysOverdue: number | null;
  chunks: number;
  /** `erase` = erased (live) or would be (dry run); `wait` = not due yet. */
  action: "erase" | "wait" | "skip";
  reason: Undetermined | Skip | "erased" | null;
}

export interface RetentionSummary {
  at: string;
  mode: RetentionMode;
  limit: number;
  /** Orders past their due date this run, erased or not. */
  due: number;
  erased: number;
  wouldErase: number;
  notDue: number;
  skipped: Record<Skip, number>;
  undeterminable: Record<Undetermined, number> & { total: number };
  /** Of the due orders still on record that someone can act on: not backlog, not a dead or unlisted batch. */
  oldestOverdueDays: number | null;
  /** Due orders held back only by the per-run limit, and the oldest of them. */
  backlog: number;
  oldestBacklogDays: number | null;
  /** SOC pushes the erasures make (one per chunk) and the pause between orders. */
  socUploads: number;
  paceMs: number;
}

export interface RetentionDeps {
  now: () => number;
  chainNow: (chainId: number) => Promise<number>;
  registration: (eventId: string, seriesId: string) => { onChainEventId: string; contract: EventContractTarget } | null;
  chainEnd: (contract: EventContractTarget, onChainEventId: string) => Promise<number | null>;
  batch: BatchLookup;
  stamper: () => string | null;
  inFlight: (root: string) => boolean;
  erase: (root: string, erasure: Erasure) => Promise<EraseOutcome>;
  sessions: () => Map<string, string>;
  paceMs: number;
  sleep: (ms: number) => Promise<void>;
}

export const liveRetentionDeps: RetentionDeps = {
  now: Date.now,
  chainNow: chainTimeMs,
  registration: (eventId, seriesId) => {
    const onChainEventId = lookupOnChainEventId(eventId, seriesId);
    const contract = registrationContractFor(eventId, seriesId);
    return onChainEventId && contract ? { onChainEventId, contract } : null;
  },
  chainEnd: (contract, onChainEventId) => chainEventEndMsAt(contract, onChainEventId),
  batch: liveBatchLookup,
  stamper: () => {
    try {
      return attendeeStamperAddress();
    } catch {
      return null;
    }
  },
  inFlight: isStoreInFlight,
  erase: (root, erasure) => eraseOrder(root, erasure),
  sessions: saleSessionsByOrderRef,
  paceMs: 2_000,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

interface Work {
  root: string;
  item: RetentionItem;
  record: OrderRecord | null;
  rule?: Erasure["rule"];
  dueMs?: number;
  overdueMs?: number;
}

function storesRefusal(): string | null {
  if (!ledgerReadable()) return "the attendee ledger is unreadable";
  if (heldOrdersHealth().unreadable) return "held orders are unreadable";
  return null;
}

/** Every order the sweep could act on: ledger records not yet erased, and paid holds not yet stored. */
function worklist(sessions: Map<string, string>): Work[] {
  const base = (root: string, source: "ledger" | "held", o: { eventId?: string; seriesId?: string; retainMonths?: number }) => ({
    rootPrefix: root.slice(0, 16),
    source,
    eventId: o.eventId ?? null,
    seriesId: o.seriesId ?? null,
    retainMonths: o.retainMonths ?? null,
    chainEnd: null,
    dueAt: null,
    daysOverdue: null,
    action: "skip" as const,
    reason: null,
  });
  const out: Work[] = [];
  for (const { root, record } of listOrders()) {
    if (record.state === "burned") continue;
    out.push({
      root,
      record,
      item: {
        ...base(root, "ledger", record),
        organiser: record.organiser ?? null,
        sessionId: sessions.get(root) ?? null,
        kind: record.kind,
        state: record.state,
        chunks: record.chunks.length,
      },
    });
  }
  for (const hold of paidUnstored()) {
    // A record of the same root decides it: stored with its hold not yet released, or a tombstone.
    if (getOrderRecord(hold.root)) continue;
    out.push({ root: hold.root, record: null, item: { ...base(hold.root, "held", hold as HeldOrder), organiser: null, sessionId: hold.sessionId ?? null, kind: "held", state: "paid-unstored", chunks: 0 } });
  }
  return out;
}

/** Work out each order's due date and whether it has passed. Reads chain, never erases. */
async function classify(work: Work[], deps: RetentionDeps): Promise<void> {
  const ends = new Map<string, Promise<number | null>>();
  const clocks = new Map<number, Promise<number>>();
  const serverNow = deps.now();
  for (const w of work) {
    const it = w.item;
    const months = it.retainMonths;
    if (!isNoticeRetentionMonths(months)) {
      it.reason = "noRetainMonths";
      continue;
    }
    if (!it.eventId || !it.seriesId) {
      it.reason = "noEventSeries";
      continue;
    }
    const reg = deps.registration(it.eventId, it.seriesId);
    if (!reg) {
      it.reason = "noRegistration";
      continue;
    }
    const endKey = `${contractKey(reg.contract)}:${reg.onChainEventId.toLowerCase()}`;
    let end = ends.get(endKey);
    if (!end) ends.set(endKey, (end = deps.chainEnd(reg.contract, reg.onChainEventId)));
    let endMs: number | null;
    try {
      endMs = await end;
    } catch {
      it.reason = "chainUnavailable";
      continue;
    }
    if (endMs === null) {
      it.reason = "noChainEnd";
      continue;
    }
    const dueMs = addCalendarMonthsUtc(endMs, months);
    it.chainEnd = new Date(endMs).toISOString();
    it.dueAt = new Date(dueMs).toISOString();
    w.dueMs = dueMs;
    w.rule = { retainMonths: months, endMs, endSource: "chain", dueAt: it.dueAt };
    if (serverNow < dueMs) {
      it.action = "wait";
      continue;
    }
    // Due by our clock: the chain's must agree, so a fast server clock cannot erase early.
    let clock = clocks.get(reg.contract.chainId);
    if (!clock) clocks.set(reg.contract.chainId, (clock = deps.chainNow(reg.contract.chainId)));
    let now: number;
    try {
      now = Math.min(serverNow, await clock);
    } catch {
      it.reason = "chainUnavailable";
      continue;
    }
    if (now < dueMs) {
      it.action = "wait";
      continue;
    }
    w.overdueMs = now - dueMs;
    it.daysOverdue = days(w.overdueMs);
  }
}

/** Why a due order cannot be erased now, or null. Batches are read from chain once per run. */
async function blocked(w: Work, deps: RetentionDeps, batches: Map<string, Promise<ChainBatch | null>>): Promise<Skip | null> {
  if (deps.inFlight(w.root)) return "inFlight";
  if (!w.record) return null; // only held: the hold is deleted, no batch involved
  const stamper = deps.stamper();
  if (!stamper) return "noStamper";
  const ledgerBatch = getBatchRecord(w.record.batchId);
  if (!ledgerBatch) return "batchUnknown";
  let chain = batches.get(w.record.batchId);
  if (!chain) batches.set(w.record.batchId, (chain = deps.batch(w.record.batchId)));
  let found: ChainBatch | null;
  try {
    found = await chain;
  } catch {
    return "batchUnknown";
  }
  if (!found) return "batchUnlisted";
  // Only a real TTL can say "dead", which never alarms; one we cannot read stays overdue.
  if (typeof found.batchTTL !== "number" || Number.isNaN(found.batchTTL)) return "batchUnknown";
  if (found.batchTTL <= 0) return "batchDead";
  if (found.owner !== stamper || ledgerBatch.owner !== stamper) return "stamperNotOwner";
  return null;
}

function emptySummary(at: number, mode: RetentionMode, limit: number, paceMs: number): RetentionSummary {
  return {
    at: new Date(at).toISOString(),
    mode,
    limit,
    due: 0,
    erased: 0,
    wouldErase: 0,
    notDue: 0,
    skipped: Object.fromEntries(SKIPS.map((k) => [k, 0])) as Record<Skip, number>,
    undeterminable: { ...(Object.fromEntries(UNDETERMINED.map((k) => [k, 0])) as Record<Undetermined, number>), total: 0 },
    oldestOverdueDays: null,
    backlog: 0,
    oldestBacklogDays: null,
    socUploads: 0,
    paceMs,
  };
}

export type RetentionRun =
  | { refused: string; why: "off" | "busy" | "stores" }
  | { refused: null; summary: RetentionSummary; items: RetentionItem[] };

/**
 * One pass. `erase` false is a dry run: everything a live run would decide,
 * nothing erased. The limit counts erasures (or would-be erasures), oldest due first.
 */
async function sweep(mode: RetentionMode, erase: boolean, limit: number, deps: RetentionDeps): Promise<RetentionRun> {
  const refusal = storesRefusal();
  if (refusal) return { refused: refusal, why: "stores" };
  const work = worklist(deps.sessions());
  await classify(work, deps);
  const summary = emptySummary(deps.now(), mode, limit, deps.paceMs);
  const due = work.filter((w) => w.overdueMs !== undefined).sort((a, b) => a.dueMs! - b.dueMs! || a.root.localeCompare(b.root));
  const batches = new Map<string, Promise<ChainBatch | null>>();
  let attempts = 0;
  for (const w of due) {
    const why = (await blocked(w, deps, batches)) ?? (attempts >= limit ? "overLimit" : null);
    if (why) {
      w.item.reason = why;
      continue;
    }
    w.item.action = "erase";
    summary.socUploads += w.item.chunks;
    if (!erase) {
      attempts++;
      continue;
    }
    if (attempts++ > 0) await deps.sleep(deps.paceMs);
    let outcome: EraseOutcome | null = null;
    try {
      outcome = await deps.erase(w.root, { by: "retention", rule: w.rule! });
    } catch (err) {
      console.error(`[retention] order ${w.item.rootPrefix}… erase failed:`, (err as Error).message);
    }
    const done = outcome?.kind === "deleted-before-store" || (outcome?.kind === "burned" && outcome.record.state === "burned");
    if (done) {
      w.item.reason = "erased";
      console.log(`[retention] order ${w.item.rootPrefix}… erased: ${w.item.retainMonths} months after ${w.item.chainEnd} (event ${w.item.eventId?.slice(0, 8)})`);
    } else {
      w.item.action = "skip";
      w.item.reason = outcome?.kind === "in-flight" ? "inFlight" : "eraseFailed";
    }
  }

  let oldest: number | null = null;
  let oldestBacklog: number | null = null;
  for (const w of work) {
    const r = w.item.reason;
    if (w.item.action === "wait") summary.notDue++;
    if (w.overdueMs !== undefined) {
      summary.due++;
      if (r === "erased") summary.erased++;
      else if (r === "overLimit") {
        summary.backlog++;
        oldestBacklog = Math.max(oldestBacklog ?? 0, w.overdueMs);
      } else if (r !== "batchDead" && r !== "batchUnlisted") oldest = Math.max(oldest ?? 0, w.overdueMs);
      if (w.item.action === "erase" && r !== "erased") summary.wouldErase++;
    }
    if (r && (UNDETERMINED as string[]).includes(r)) {
      summary.undeterminable[r as Undetermined]++;
      summary.undeterminable.total++;
    } else if (r && (SKIPS as string[]).includes(r)) {
      summary.skipped[r as Skip]++;
    }
  }
  summary.oldestOverdueDays = days(oldest);
  summary.oldestBacklogDays = days(oldestBacklog);
  return { refused: null, summary, items: work.map((w) => w.item) };
}

let defaultDeps: RetentionDeps = liveRetentionDeps;
let running = false;
let lastRun: RetentionSummary | null = null;
let lastRefusal: { at: string; reason: string } | null = null;
let bootAt = Date.now();
/** Completed runs in a row that met a batch bee does not list. A refused run leaves it; a restart resets it. */
let unlistedStreak = 0;

/**
 * A run in the configured mode: the daily timer and `POST .../retention/run`.
 * Single-flight. Off refuses; dry run decides and erases nothing.
 */
export async function runOrderRetention(
  opts: { limit?: number; mode?: RetentionMode; deps?: RetentionDeps } = {},
): Promise<RetentionRun> {
  const config = retentionConfig();
  const mode = opts.mode ?? config.mode;
  const deps = opts.deps ?? defaultDeps;
  if (mode === "off") return { refused: "ORDER_RETENTION_SWEEP is off", why: "off" };
  if (running) return { refused: "a retention run is already in progress", why: "busy" };
  running = true;
  try {
    const run = await sweep(mode, mode === "live", opts.limit ?? config.limit, deps);
    if (run.refused !== null) {
      lastRefusal = { at: new Date(deps.now()).toISOString(), reason: run.refused };
      console.error(`[retention] run refused: ${run.refused}`);
    } else {
      lastRun = run.summary;
      const s = run.summary;
      unlistedStreak = s.skipped.batchUnlisted > 0 ? unlistedStreak + 1 : 0;
      console.log(
        `[retention] ${mode} run: due ${s.due}, erased ${s.erased}, would erase ${s.wouldErase}, not due ${s.notDue}, ` +
          `backlog ${s.backlog}, undeterminable ${s.undeterminable.total}, oldest overdue ${s.oldestOverdueDays ?? "-"} d`,
      );
    }
    return run;
  } finally {
    running = false;
  }
}

/** What a run in the configured mode would do, erasing nothing. Health is not touched. */
export async function previewOrderRetention(
  opts: { limit?: number; deps?: RetentionDeps } = {},
): Promise<RetentionRun> {
  const config = retentionConfig();
  return sweep(config.mode, false, opts.limit ?? config.limit, opts.deps ?? defaultDeps);
}

/**
 * `/api/health` `orderRetention`. Counts only: the endpoint is public. Red when
 * a store is unreadable, no run has completed in 48 h (unless off), the config
 * is not understood, or - live only - an order someone can act on is over 7 days
 * past its due date, the backlog the limit holds back is over 14 days past due,
 * or a batch holding due orders was unlisted in 3 runs in a row. Undeterminable
 * orders and dead batches are reported, never red.
 */
export function orderRetentionHealth(nowMs: number = Date.now()) {
  const { mode, limit, configError } = retentionConfig();
  const refusal = storesRefusal();
  const sinceRun = nowMs - (lastRun ? Date.parse(lastRun.at) : bootAt);
  const overdue = lastRun?.oldestOverdueDays ?? 0;
  const backlogDays = lastRun?.oldestBacklogDays ?? 0;
  const checks = {
    stores: refusal === null ? { ok: true } : { ok: false, reason: refusal },
    ran: mode === "off" || sinceRun < NO_RUN_ALARM_MS ? { ok: true } : { ok: false, reason: lastRun ? "no run in 48 h" : "no run since boot, 48 h ago" },
    overdue: mode !== "live" || overdue <= OVERDUE_ALARM_DAYS ? { ok: true } : { ok: false, reason: `an order is ${overdue} days past its due date` },
    backlog:
      mode !== "live" || backlogDays <= BACKLOG_ALARM_DAYS
        ? { ok: true }
        : { ok: false, reason: `the per-run limit has held an order back ${backlogDays} days past its due date` },
    batchUnlisted:
      mode !== "live" || unlistedStreak < UNLISTED_ALARM_RUNS
        ? { ok: true }
        : { ok: false, reason: `a batch holding due orders was not listed by bee in ${unlistedStreak} runs in a row` },
    config: configError ? { ok: false, reason: "ORDER_RETENTION_SWEEP or ORDER_RETENTION_LIMIT not recognised" } : { ok: true },
  };
  return {
    ok: Object.values(checks).every((c) => c.ok),
    mode,
    limit,
    lastRunAt: lastRun?.at ?? null,
    lastRefusal,
    due: lastRun?.due ?? null,
    erased: lastRun?.erased ?? null,
    wouldErase: lastRun?.wouldErase ?? null,
    notDue: lastRun?.notDue ?? null,
    skipped: lastRun?.skipped ?? null,
    undeterminable: lastRun?.undeterminable ?? null,
    oldestOverdueDays: lastRun?.oldestOverdueDays ?? null,
    backlog: lastRun?.backlog ?? null,
    oldestBacklogDays: lastRun?.oldestBacklogDays ?? null,
    unlistedStreak,
    checks,
  };
}

/** Test seam only. */
export function _resetOrderRetentionForTests(nowMs: number = Date.now(), deps: RetentionDeps = liveRetentionDeps): void {
  defaultDeps = deps;
  running = false;
  lastRun = null;
  lastRefusal = null;
  bootAt = nowMs;
  unlistedStreak = 0;
}
