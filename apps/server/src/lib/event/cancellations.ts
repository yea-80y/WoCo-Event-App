/**
 * Cancelled events and the refund of every sale (#644).
 *
 * Owner policy: tickets are refunded only when an event does not take place,
 * and then everyone is refunded. This store is the SERVER's answer to "is this
 * event cancelled", and it is the only answer the money path reads: checkout,
 * seat holds and fulfilment refuse a cancelled event from here, never from the
 * event feed (which, for a Phase B event, the organiser signs and could re-sign
 * without the flag). The feed's `cancelledAt` is display only.
 *
 * One row per sale being refunded, keyed by Checkout Session id. A row's state
 * is refreshed from Stripe on every pass (cancellation-refunds.ts); "settled"
 * is DERIVED from the rows, never stored, because a sale can still arrive after
 * the cancellation (a checkout paid in the window before its session expired)
 * and must un-settle the event until it too is refunded.
 *
 * MUST SURVIVE RESTARTS. Losing it would let a cancelled event sell again and
 * forget which buyers are still owed. A file that exists but cannot be read is
 * never overwritten (the onchain-events.json lesson, #424), and while it is
 * unreadable every sale FAILS CLOSED (`cancellationGate` answers "unknown"):
 * selling a ticket to an event that may be cancelled is worse than a short
 * outage, and /api/health alarms until an operator restores the file.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../marketing/persist.js";

const DATA_DIR = join(process.cwd(), ".data");
const STORE_FILE = join(DATA_DIR, "event-cancellations.json");

export type CancelRefundStatus =
  /** Not refunded yet, or a refund Stripe is still processing. */
  | "pending"
  /** A refund Stripe holds for `insufficient_funds`: the organiser's balance is short. */
  | "pending-funds"
  /** A refund waiting on the buyer (`requires_action`). */
  | "requires-action"
  /** Refunded in full, or nothing left to refund (a lost chargeback already returned it). */
  | "done"
  /** An open chargeback: Stripe refuses a refund while it runs; the dispute path handles it. */
  | "disputed"
  /** The last attempt errored; retried on the next pass. */
  | "failed"
  /** Retries exhausted — alarmed until an operator resolves it. */
  | "abandoned"
  /** An operator confirmed the buyer was made whole another way. */
  | "resolved";

export interface CancelRefundRow {
  sessionId: string;
  paymentIntentId: string;
  /** The organiser's connected account the charge lives on. */
  account: string;
  status: CancelRefundStatus;
  /** Create errors counted toward `abandoned`. */
  attempts: number;
  /** Refunds this job has created for the sale (a failed one is re-created). */
  created: number;
  refundId?: string;
  /** Minor units: the charge, and what is refunded or in flight, as last read. */
  charged?: number;
  refunded?: number;
  currency?: string;
  lastError?: string;
  /** When the sale joined the cancellation — the overdue alarm counts from here. */
  createdAt?: string;
  updatedAt: string;
  /** When the row last became `done`. A card refund can still fail for weeks after. */
  doneAt?: string;
  resolvedBy?: string;
}

export interface EventCancellation {
  eventId: string;
  cancelledAt: string;
  /** `organiser:{address}` or `ops:{name}`. */
  by: string;
  /**
   * Whether our application fee goes back to the organiser with each refund.
   * Captured once, at cancellation: every refund of the event follows it, and a
   * replayed create must carry the same value or Stripe rejects the key.
   */
  feeReturned: boolean;
  refunds: Record<string, CancelRefundRow>;
}

/** Row states no pass touches again (an operator or the alarm owns them). */
const FINAL: ReadonlySet<CancelRefundStatus> = new Set(["resolved", "abandoned"]);
/**
 * A `done` refund is re-read once a day for this long: Stripe says a refund can
 * fail up to 30 days after it was requested, and a failure puts the money back
 * with the organiser while the buyer has none. A `refund.failed` webhook reopens
 * the row straight away; this re-read is the backstop that needs no webhook.
 */
export const DONE_RECHECK_WINDOW_MS = 35 * 24 * 60 * 60_000;
export const DONE_RECHECK_EVERY_MS = 24 * 60 * 60_000;
/**
 * A row parked on a visible open chargeback is re-read this often: a chargeback
 * runs for weeks, and each dispute webhook reopens the row at once anyway.
 */
export const DISPUTED_RECHECK_EVERY_MS = 6 * 60 * 60_000;
/**
 * Row states whose sale may be paid out: refunded, or resolved by an operator.
 * NOT `disputed`: a chargeback the organiser later WINS gives the money back to
 * their balance and the buyer is then refunded from it (the pass refunds a won
 * dispute) — so the sale's takings stay held until the row is done.
 */
const SETTLED: ReadonlySet<CancelRefundStatus> = new Set(["done", "resolved"]);
/** A refund row not settled after this long is alarmed (disputes excepted: they run for months). */
export const ROW_OVERDUE_MS = 7 * 24 * 60 * 60_000;

let store: Record<string, EventCancellation> = {};
let loaded = false;
let fileUnreadable: string | null = null;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  let raw: string;
  try {
    raw = readFileSync(STORE_FILE, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    fileUnreadable = err instanceof Error ? err.message : String(err);
    console.error(`[cancellations] ${STORE_FILE} exists but cannot be read — ALL SALES REFUSED until restored:`, err);
    return;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not a JSON object");
    store = parsed as Record<string, EventCancellation>;
    const n = Object.keys(store).length;
    if (n > 0) console.log(`[cancellations] Loaded ${n} cancelled event(s)`);
  } catch (err) {
    store = {};
    fileUnreadable = err instanceof Error ? err.message : String(err);
    console.error(
      `[cancellations] ${STORE_FILE} is not readable JSON — it will NOT be overwritten, and ALL SALES ARE REFUSED until it is restored:`,
      err,
    );
  }
}

function persist(): boolean {
  if (fileUnreadable) return false;
  return writeJsonAtomic(STORE_FILE, store, "event-cancellations", { pretty: true });
}

export type CancellationGate = "open" | "cancelled" | "unknown";

/**
 * The money path's question. "unknown" while the file is unreadable: every
 * caller that sells refuses on it, one that has already been paid proceeds.
 */
export function cancellationGate(eventId: string): CancellationGate {
  ensureLoaded();
  if (fileUnreadable) return "unknown";
  return store[eventId] ? "cancelled" : "open";
}

export function getCancellation(eventId: string): EventCancellation | undefined {
  ensureLoaded();
  return store[eventId];
}

export function listCancellations(): EventCancellation[] {
  ensureLoaded();
  return Object.values(store);
}

/**
 * Record a cancellation. Idempotent: a second call returns the existing record
 * (`created: false`) and changes nothing — the fee policy captured first stands.
 * `null` when it could not be persisted: the caller must refuse, because a
 * cancellation that only lives in memory would be forgotten by a restart while
 * the refunds it started carry on.
 */
export function recordCancellation(input: {
  eventId: string;
  by: string;
  feeReturned: boolean;
  now?: Date;
}): { created: boolean; cancellation: EventCancellation } | null {
  ensureLoaded();
  if (fileUnreadable) return null;
  const existing = store[input.eventId];
  if (existing) return { created: false, cancellation: existing };
  const cancellation: EventCancellation = {
    eventId: input.eventId,
    cancelledAt: (input.now ?? new Date()).toISOString(),
    by: input.by,
    feeReturned: input.feeReturned,
    refunds: {},
  };
  store[input.eventId] = cancellation;
  if (!persist()) {
    delete store[input.eventId];
    return null;
  }
  return { created: true, cancellation };
}

/** Add a sale to a cancellation's refunds, once. Returns false when the event is not cancelled. */
export function addRefundRow(
  eventId: string,
  sale: { sessionId: string; paymentIntentId: string; account: string },
  now: Date = new Date(),
): boolean {
  ensureLoaded();
  const c = store[eventId];
  if (!c) return false;
  if (!c.refunds[sale.sessionId]) {
    c.refunds[sale.sessionId] = {
      sessionId: sale.sessionId,
      paymentIntentId: sale.paymentIntentId,
      account: sale.account,
      status: "pending",
      attempts: 0,
      created: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    persist();
  }
  return true;
}

/** Apply a pass's findings to one row. Returns whether the write reached disk. */
export function updateRefundRow(
  eventId: string,
  sessionId: string,
  patch: Partial<Omit<CancelRefundRow, "sessionId" | "paymentIntentId" | "account">>,
  now: Date = new Date(),
): boolean {
  ensureLoaded();
  const row = store[eventId]?.refunds[sessionId];
  if (!row) return false;
  const becameDone = patch.status === "done" && row.status !== "done";
  Object.assign(row, patch, { updatedAt: now.toISOString() }, becameDone ? { doneAt: now.toISOString() } : {});
  return persist();
}

/**
 * Something happened on this sale's charge (a refund failed, a dispute moved):
 * make the next pass look at it again, whatever it last concluded. The pass
 * recomputes from Stripe, so reopening a sale that is still fine costs one read.
 */
export function reopenRefundRow(eventId: string, sessionId: string, now: Date = new Date()): boolean {
  ensureLoaded();
  const row = store[eventId]?.refunds[sessionId];
  if (!row || row.status === "resolved") return false;
  if (row.status !== "done" && row.status !== "abandoned" && row.status !== "disputed") return true;
  Object.assign(row, { status: "pending" as const, updatedAt: now.toISOString() });
  persist();
  return true;
}

/**
 * The feed as every API response should carry it: the server's record of a
 * cancellation wins over whatever the (organiser-signed) feed says, so an
 * ordinary edit re-signed without the field cannot drop the banner.
 */
export function withCancellation<T extends { eventId: string; cancelledAt?: string }>(feed: T): T {
  const c = getCancellation(feed.eventId);
  return c ? { ...feed, cancelledAt: c.cancelledAt } : feed;
}

/** An operator confirms the buyer was made whole another way. Clears the alarm for that row. */
export function resolveRefundRow(
  eventId: string,
  sessionId: string,
  by: string,
  now: Date = new Date(),
): "resolved" | "none" | "not-persisted" {
  ensureLoaded();
  const row = store[eventId]?.refunds[sessionId];
  if (!row) return "none";
  Object.assign(row, { status: "resolved" as const, resolvedBy: by, updatedAt: now.toISOString() });
  return persist() ? "resolved" : "not-persisted";
}

/** Whether a pass should look at this row now. */
export function isRowDue(row: CancelRefundRow, now: Date = new Date()): boolean {
  if (FINAL.has(row.status)) return false;
  const t = now.getTime();
  // Parked on a chargeback we could see (no lastError). One parked because
  // Stripe refused a create (lastError set) stays due every pass, so it reaches
  // `abandoned` and the alarm rather than waiting quietly.
  if (row.status === "disputed" && !row.lastError) return t - Date.parse(row.updatedAt) >= DISPUTED_RECHECK_EVERY_MS;
  if (row.status !== "done") return true;
  const doneAt = row.doneAt ? Date.parse(row.doneAt) : Date.parse(row.updatedAt);
  return t - doneAt < DONE_RECHECK_WINDOW_MS && t - Date.parse(row.updatedAt) >= DONE_RECHECK_EVERY_MS;
}

/**
 * Whether ONE sale of a cancelled event may be paid out (payout-release.ts). A
 * sale with no row yet is NOT settled: a pass may not have reached it (a large
 * event, a sale paid seconds ago), and "no row" must never read as "refunded".
 */
export function isSaleRefundSettled(eventId: string, sessionId: string): boolean {
  ensureLoaded();
  const row = store[eventId]?.refunds[sessionId];
  return !!row && SETTLED.has(row.status);
}

/** Whether every sale of the event is refunded or otherwise accounted for (progress view). */
export function isCancellationSettled(eventId: string): boolean {
  ensureLoaded();
  const c = store[eventId];
  if (!c) return true;
  return Object.values(c.refunds).every((r) => SETTLED.has(r.status));
}

export interface CancellationProgress {
  cancelledAt: string;
  feeReturned: boolean;
  sales: number;
  done: number;
  inProgress: number;
  waitingForFunds: number;
  waitingForBuyer: number;
  disputed: number;
  needsAttention: number;
  settled: boolean;
  /** Minor units per currency: charged, and refunded or in flight. */
  totals: Record<string, { charged: number; refunded: number }>;
}

/** Counts and totals for the organiser's progress view. No buyer data. */
export function cancellationProgress(eventId: string): CancellationProgress | null {
  ensureLoaded();
  const c = store[eventId];
  if (!c) return null;
  const rows = Object.values(c.refunds);
  const totals: CancellationProgress["totals"] = {};
  for (const r of rows) {
    if (!r.currency) continue;
    const t = (totals[r.currency] ??= { charged: 0, refunded: 0 });
    t.charged += r.charged ?? 0;
    t.refunded += r.refunded ?? 0;
  }
  const count = (...s: CancelRefundStatus[]) => rows.filter((r) => s.includes(r.status)).length;
  return {
    cancelledAt: c.cancelledAt,
    feeReturned: c.feeReturned,
    sales: rows.length,
    done: count("done", "resolved"),
    inProgress: count("pending", "failed"),
    waitingForFunds: count("pending-funds"),
    waitingForBuyer: count("requires-action"),
    disputed: count("disputed"),
    needsAttention: count("abandoned"),
    settled: isCancellationSettled(eventId),
    totals,
  };
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export interface CancellationsStoreHealth {
  ok: boolean;
  cancelledEvents: number;
  refundsOpen: number;
  /** Refunds Stripe holds because the organiser's balance is short — buyers still out of pocket. */
  waitingForFunds: number;
  /** Retries exhausted — someone paid and has not been refunded. */
  abandoned: number;
  /** Not refunded a week after joining the cancellation (disputes excepted). */
  overdue: number;
  /** The file exists but could not be read: every sale is refused. */
  fileUnreadable: boolean;
}

/** Counts only: this endpoint is public. The ops route has the rows. */
export function cancellationsStoreHealth(): CancellationsStoreHealth {
  ensureLoaded();
  let refundsOpen = 0;
  let waitingForFunds = 0;
  let abandoned = 0;
  let overdue = 0;
  const now = Date.now();
  for (const c of Object.values(store)) {
    for (const r of Object.values(c.refunds)) {
      if (!SETTLED.has(r.status)) refundsOpen++;
      if (r.status === "pending-funds") waitingForFunds++;
      if (r.status === "abandoned") abandoned++;
      const since = Date.parse(r.createdAt ?? r.updatedAt);
      if (!SETTLED.has(r.status) && r.status !== "disputed" && now - since > ROW_OVERDUE_MS) overdue++;
    }
  }
  return {
    ok: abandoned === 0 && waitingForFunds === 0 && overdue === 0 && !fileUnreadable,
    cancelledEvents: Object.keys(store).length,
    refundsOpen,
    waitingForFunds,
    abandoned,
    overdue,
    fileUnreadable: fileUnreadable !== null,
  };
}

/** Tests only — forget in-memory state so the next call reads the file afresh. */
export function __resetForTests(): void {
  store = {};
  loaded = false;
  fileUnreadable = null;
}
