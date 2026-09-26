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
  updatedAt: string;
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

/** Row states that need no further work. */
const FINAL: ReadonlySet<CancelRefundStatus> = new Set(["done", "resolved", "abandoned"]);
/** Row states the payouts may treat as settled (the dispute path holds its own sale). */
const SETTLED: ReadonlySet<CancelRefundStatus> = new Set(["done", "resolved", "disputed"]);

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

/**
 * The money path's question. "unknown" while the file is unreadable: every
 * caller that sells refuses on it, one that has already been paid proceeds.
 */
export function cancellationGate(eventId: string): "open" | "cancelled" | "unknown" {
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
  Object.assign(row, patch, { updatedAt: now.toISOString() });
  return persist();
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

export function isRowFinal(row: CancelRefundRow): boolean {
  return FINAL.has(row.status);
}

/**
 * Whether every sale of the event is refunded or otherwise accounted for. The
 * payouts hold a cancelled event's takings until this is true (payout-release.ts).
 */
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
  /** The file exists but could not be read: every sale is refused. */
  fileUnreadable: boolean;
}

/** Counts only: this endpoint is public. The ops route has the rows. */
export function cancellationsStoreHealth(): CancellationsStoreHealth {
  ensureLoaded();
  let refundsOpen = 0;
  let waitingForFunds = 0;
  let abandoned = 0;
  for (const c of Object.values(store)) {
    for (const r of Object.values(c.refunds)) {
      if (!SETTLED.has(r.status)) refundsOpen++;
      if (r.status === "pending-funds") waitingForFunds++;
      if (r.status === "abandoned") abandoned++;
    }
  }
  return {
    ok: abandoned === 0 && waitingForFunds === 0 && !fileUnreadable,
    cancelledEvents: Object.keys(store).length,
    refundsOpen,
    waitingForFunds,
    abandoned,
    fileUnreadable: fileUnreadable !== null,
  };
}

/** Tests only — forget in-memory state so the next call reads the file afresh. */
export function __resetForTests(): void {
  store = {};
  loaded = false;
  fileUnreadable = null;
}
