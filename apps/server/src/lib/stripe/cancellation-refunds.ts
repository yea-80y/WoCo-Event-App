/**
 * Refund every sale of a cancelled event (#644).
 *
 * A pass walks every cancelled event (event-cancellations.json), re-reads which
 * sales it has — every pass, so a sale paid in the window before its checkout
 * expired is still caught — and moves each one toward "refunded" from Stripe's
 * CURRENT state, never from what the last pass recorded:
 *
 *   open chargeback            -> `disputed` (Stripe refuses a refund while it
 *                                 runs; re-checked every pass, never abandoned)
 *   lost chargeback            -> `done` (the bank already returned the money)
 *   remaining = charged - (pending + succeeded + requires_action refunds)
 *   remaining <= 0             -> done / pending-funds / requires-action / pending
 *   remaining  > 0             -> create a refund for EXACTLY `remaining`
 *
 * The amount is always explicit: what Stripe does with an omitted amount on a
 * partly refunded charge is not documented in what we have. The idempotency
 * key carries the amount and the number of refunds that already failed, so a
 * replay within 24 h returns the same refund, a changed remainder is a new
 * request, and a refund that FAILED is re-created rather than replayed.
 *
 * The buyer gets the whole charge back (owner decision 2026-09-26, #644). Our
 * application fee follows the cancellation's `feeReturned`, captured once.
 * `reason` is always `requested_by_customer`: `fraudulent` would add the
 * buyer's card and email to Radar block lists.
 *
 * After a refund lands the sale's tickets are voided straight away through the
 * refund reconciler (sale-refunds.ts), so the door does not depend on the
 * `charge.refunded` webhook for a cancellation.
 */

import {
  addRefundRow,
  isRowFinal,
  listCancellations,
  updateRefundRow,
  type CancelRefundRow,
  type CancelRefundStatus,
} from "../event/cancellations.js";
import { CHARGEBACK_STATUSES } from "./dispute-status.js";

export interface CancellationCharge {
  id: string;
  amount: number;
  currency: string;
  disputed: boolean;
}

export interface CancellationRefundDeps {
  /** Every sale this server knows for the event (sale record ∪ payout ledger). */
  saleSessionsFor(eventId: string): Array<{ sessionId: string; paymentIntentId: string; account: string }>;
  /** The payment intent's latest charge on `account`; null when it has none. Throws on transport. */
  latestCharge(paymentIntentId: string, account: string): Promise<CancellationCharge | null>;
  /** Every refund on the charge, all pages. Throws on transport. */
  refundsForCharge(
    chargeId: string,
    account: string,
  ): Promise<Array<{ amount: number; status: string | null; pendingReason?: string | null }>>;
  /** Every dispute on the charge, all pages. Throws on transport. */
  disputesForCharge(chargeId: string, account: string): Promise<Array<{ status: string }>>;
  /** Rejects with the Stripe error (its `code` is read). */
  createRefund(
    params: { paymentIntentId: string; amount: number; feeReturned: boolean; eventId: string; sessionId: string },
    account: string,
    idempotencyKey: string,
  ): Promise<{ id: string; status: string | null; pendingReason?: string | null }>;
  /** Void the sale's tickets from Stripe's current state. Best effort: never relied on. */
  reconcile(paymentIntentId: string, account: string): Promise<void>;
}

/** Create errors on one sale before it is abandoned (and alarmed). */
export const MAX_ATTEMPTS = 24;
/** Refunds created for one sale before a failing one is abandoned (and alarmed). */
export const MAX_CREATES = 3;

const IN_FLIGHT = new Set(["pending", "succeeded", "requires_action"]);
const GONE = new Set(["failed", "canceled"]);
const OPEN_CHARGEBACK = new Set([...CHARGEBACK_STATUSES].filter((s) => s !== "lost"));

export function cancellationIdempotencyKey(sessionId: string, amount: number, failedBefore: number): string {
  return `woco-cancel-${sessionId}-${amount}-${failedBefore}`;
}

type RefundView = { amount: number; status: string | null; pendingReason?: string | null };

/** What a sale's refunds say, when nothing is left to create. */
function settledStatus(refunds: RefundView[]): CancelRefundStatus {
  if (refunds.some((r) => r.status === "pending" && r.pendingReason === "insufficient_funds")) return "pending-funds";
  if (refunds.some((r) => r.status === "requires_action")) return "requires-action";
  if (refunds.some((r) => r.status === "pending")) return "pending";
  return "done";
}

function createdStatus(r: { status: string | null; pendingReason?: string | null }): CancelRefundStatus {
  if (r.status === "succeeded") return "done";
  if (r.status === "requires_action") return "requires-action";
  if (r.status === "pending") return r.pendingReason === "insufficient_funds" ? "pending-funds" : "pending";
  return "failed";
}

function errCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; raw?: { code?: unknown } } | null;
  const code = e?.code ?? e?.raw?.code;
  return typeof code === "string" ? code : undefined;
}

function errMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

async function processRow(
  eventId: string,
  feeReturned: boolean,
  row: CancelRefundRow,
  deps: CancellationRefundDeps,
): Promise<CancelRefundStatus> {
  const set = (patch: Parameters<typeof updateRefundRow>[2]) => updateRefundRow(eventId, row.sessionId, patch);
  const voidNow = () => deps.reconcile(row.paymentIntentId, row.account).catch((err) => {
    console.warn(`[cancel-refunds] void of ${row.sessionId} deferred to the webhook:`, errMessage(err));
  });

  let charge: CancellationCharge | null;
  let refunds: RefundView[];
  try {
    charge = await deps.latestCharge(row.paymentIntentId, row.account);
    if (!charge) {
      set({ status: "failed", attempts: row.attempts + 1, lastError: "payment intent has no charge" });
      return "failed";
    }
    if (charge.disputed) {
      const disputes = await deps.disputesForCharge(charge.id, row.account);
      if (disputes.some((d) => OPEN_CHARGEBACK.has(d.status))) {
        set({ status: "disputed", charged: charge.amount, currency: charge.currency, lastError: undefined });
        return "disputed";
      }
      if (disputes.some((d) => d.status === "lost")) {
        set({ status: "done", charged: charge.amount, refunded: charge.amount, currency: charge.currency, lastError: undefined });
        return "done";
      }
    }
    refunds = await deps.refundsForCharge(charge.id, row.account);
  } catch (err) {
    // A read that failed decides nothing and is not an attempt at the money.
    set({ lastError: errMessage(err) });
    return row.status;
  }

  const inFlight = refunds.filter((r) => r.status && IN_FLIGHT.has(r.status)).reduce((a, r) => a + r.amount, 0);
  const failedBefore = refunds.filter((r) => r.status && GONE.has(r.status)).length;
  const remaining = charge.amount - inFlight;

  if (remaining <= 0) {
    const status = settledStatus(refunds);
    set({ status, charged: charge.amount, refunded: inFlight, currency: charge.currency, lastError: undefined });
    if (status === "done") await voidNow();
    return status;
  }

  if (row.created >= MAX_CREATES) {
    set({ status: "abandoned", charged: charge.amount, refunded: inFlight, currency: charge.currency, lastError: `${row.created} refunds created and ${remaining} still not refunded` });
    return "abandoned";
  }

  try {
    const refund = await deps.createRefund(
      { paymentIntentId: row.paymentIntentId, amount: remaining, feeReturned, eventId, sessionId: row.sessionId },
      row.account,
      cancellationIdempotencyKey(row.sessionId, remaining, failedBefore),
    );
    const status = createdStatus(refund);
    set({
      status,
      created: row.created + 1,
      refundId: refund.id,
      charged: charge.amount,
      refunded: inFlight + remaining,
      currency: charge.currency,
      lastError: undefined,
    });
    if (status === "done") await voidNow();
    return status;
  } catch (err) {
    const code = errCode(err);
    if (code === "charge_already_refunded") {
      // Refunded some other way (the organiser's Dashboard) since the read: the
      // next pass re-reads and settles it. Not an attempt.
      set({ status: "pending", lastError: code });
      return "pending";
    }
    if (code === "charge_disputed" || code === "refund_disputed_payment") {
      set({ status: "disputed", lastError: code });
      return "disputed";
    }
    const attempts = row.attempts + 1;
    const status: CancelRefundStatus = attempts >= MAX_ATTEMPTS ? "abandoned" : "failed";
    set({ status, attempts, lastError: code ? `${code}: ${errMessage(err)}` : errMessage(err) });
    console.error(`[cancel-refunds] refund of ${row.sessionId} (${eventId}) failed — ${status}:`, errMessage(err));
    return status;
  }
}

export interface CancellationPassOutcome {
  events: number;
  processed: number;
  byStatus: Partial<Record<CancelRefundStatus, number>>;
}

/** One pass over every cancelled event. Exported for tests and the ops route. */
export async function runCancellationPass(deps: CancellationRefundDeps): Promise<CancellationPassOutcome> {
  const outcome: CancellationPassOutcome = { events: 0, processed: 0, byStatus: {} };
  for (const cancellation of listCancellations()) {
    outcome.events++;
    for (const sale of deps.saleSessionsFor(cancellation.eventId)) addRefundRow(cancellation.eventId, sale);
    for (const row of Object.values(cancellation.refunds)) {
      if (isRowFinal(row)) continue;
      const status = await processRow(cancellation.eventId, cancellation.feeReturned, row, deps);
      outcome.processed++;
      outcome.byStatus[status] = (outcome.byStatus[status] ?? 0) + 1;
    }
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Job
// ---------------------------------------------------------------------------

/** Pending refunds and new late sales are picked up at this cadence. */
export const PASS_INTERVAL_MS = 10 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 60 * 1000;

let running: Promise<CancellationPassOutcome> | null = null;
let again = false;
let timer: ReturnType<typeof setInterval> | null = null;
const health = { startedAt: new Date().toISOString(), lastRunAt: null as string | null, lastError: null as string | null };

/**
 * Run a pass now. Passes never overlap: a call while one runs asks for one more
 * pass after it, so a cancellation made mid-pass is not left for the timer.
 */
export function kickCancellationRefunds(deps: CancellationRefundDeps): Promise<CancellationPassOutcome> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      let result: CancellationPassOutcome;
      do {
        again = false;
        result = await runCancellationPass(deps);
      } while (again);
      health.lastRunAt = new Date().toISOString();
      health.lastError = null;
      return result;
    } catch (err) {
      health.lastError = errMessage(err);
      console.error("[cancel-refunds] pass threw:", err);
      throw err;
    } finally {
      running = null;
    }
  })();
  return running;
}

export function startCancellationRefundJob(deps: CancellationRefundDeps): void {
  if (timer) return;
  const tick = () => {
    void kickCancellationRefunds(deps).catch(() => undefined);
  };
  setTimeout(tick, FIRST_RUN_DELAY_MS).unref?.();
  timer = setInterval(tick, PASS_INTERVAL_MS);
  timer.unref?.();
}

/** `stale` = the job is running but has not completed a pass for 2.5 intervals. */
export function cancellationJobHealth(): { running: boolean; lastRunAt: string | null; stale: boolean; lastError: string | null } {
  const since = health.lastRunAt ?? health.startedAt;
  const stale = timer !== null && Date.now() - new Date(since).getTime() > PASS_INTERVAL_MS * 2.5;
  return { running: timer !== null, lastRunAt: health.lastRunAt, stale, lastError: health.lastError };
}

/** Tests only. */
export function _resetCancellationJobForTest(): void {
  running = null;
  again = false;
}
