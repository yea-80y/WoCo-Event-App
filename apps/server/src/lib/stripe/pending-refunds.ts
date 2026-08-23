/**
 * Auto-refunds that could not be created (#367).
 *
 * When fulfilment stops short of the tickets a buyer paid for it refunds the
 * unfilled part. If THAT Stripe call throws, the buyer is charged with no
 * ticket and — before this file — the only trace was a docker log line: the
 * payout-ledger entry stayed `held` (the organiser would be paid for tickets
 * never issued) and nothing on `/api/health` knew. This is the durable record
 * and the retry:
 *
 *   - `recordPendingRefund` is called by fulfilment the moment the refund call
 *     fails, with the exact params it tried, so the retry is a replay, not a
 *     re-derivation.
 *   - `retryPendingRefunds` runs on a timer. For each pending entry it first
 *     LISTS the payment intent's refunds and looks for one carrying our session
 *     id — a refund that landed while the response was lost must be recognised,
 *     not repeated — and only then creates, under the same idempotency key
 *     fulfilment used. `charge_already_refunded` is success (an operator did it
 *     from the dashboard).
 *   - A landed FULL refund voids the payout-ledger entry, exactly as fulfilment
 *     would have.
 *   - `pendingRefundsHealth` is on `/api/health`: a non-zero `pending` or
 *     `abandoned` is an alarm — somebody paid and has neither ticket nor money.
 *
 * Retries stop after MAX_ATTEMPTS (status `abandoned`) but the row stays and
 * the alarm stays up until an operator resolves it through the ops route —
 * silence is the one outcome this file exists to rule out.
 *
 * Idempotency keys at Stripe expire after 24 hours; the list-before-create is
 * what keeps a replay safe past that horizon (a second FULL refund is refused
 * by Stripe anyway; a second PARTIAL would not be).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Stripe } from "stripe";
import { writeJsonAtomic } from "../marketing/persist.js";

const DATA_DIR = join(process.cwd(), ".data");
const STORE_FILE = join(DATA_DIR, "pending-refunds.json");

/** Hourly would leave a buyer out of pocket for an hour over a blip; this is cheap. */
export const RETRY_INTERVAL_MS = 10 * 60 * 1000;
/** First run after boot — long enough to outlive a restart loop's thrash. */
const FIRST_RUN_DELAY_MS = 60 * 1000;
/** ~8 hours at the retry interval. Past this the row is `abandoned`, still alarmed. */
export const MAX_ATTEMPTS = 48;

export type PendingRefundStatus = "pending" | "done" | "abandoned" | "resolved";

export interface PendingRefund {
  /** Stripe Checkout Session id — the sale; one entry per session. */
  sessionId: string;
  paymentIntentId: string;
  /** Direct charge: the refund goes through the connected account. */
  connectedAccountId?: string;
  /** Minor units for a partial refund; absent = refund the whole intent. */
  amount?: number;
  /** `woco-autorefund-${sessionId}` — the same key fulfilment used. */
  idempotencyKey: string;
  /** Why fulfilment stopped (the `failureMessage` in the refund metadata). */
  reason: string;
  /** The refund metadata fulfilment built — replayed verbatim. */
  metadata: Record<string, string>;
  createdAt: string;
  attempts: number;
  lastAttemptAt?: string;
  lastError?: string;
  status: PendingRefundStatus;
  /** Set with `done`. */
  refundId?: string;
  /** Set with `done` / `resolved`. */
  settledAt?: string;
  /** Set with `resolved` — who, from the ops route. */
  resolvedBy?: string;
}

let store: Record<string, PendingRefund> = {};
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    store = JSON.parse(readFileSync(STORE_FILE, "utf-8")) as Record<string, PendingRefund>;
    const pending = Object.values(store).filter((e) => e.status === "pending").length;
    if (pending > 0) console.warn(`[pending-refunds] ${pending} auto-refund(s) still pending on disk — retry will run`);
  } catch {
    // No file yet — nothing has ever failed to refund.
  }
}

function persist(): boolean {
  return writeJsonAtomic(STORE_FILE, store, "pending-refunds", { pretty: true });
}

export function idempotencyKeyFor(sessionId: string): string {
  return `woco-autorefund-${sessionId}`;
}

export interface RecordPendingRefundInput {
  sessionId: string;
  paymentIntentId: string;
  connectedAccountId?: string;
  amount?: number;
  reason: string;
  metadata: Record<string, string>;
  error: string;
}

/**
 * Record a refund that could not be created. Idempotent per session: a second
 * call (fulfilment cannot run twice for one session, but be safe) updates the
 * error and leaves the attempt count alone. Never throws — it is the last
 * line of the error path.
 */
export function recordPendingRefund(input: RecordPendingRefundInput): PendingRefund {
  ensureLoaded();
  const now = new Date().toISOString();
  const existing = store[input.sessionId];
  const entry: PendingRefund = existing
    ? { ...existing, lastError: input.error.slice(0, 500) }
    : {
        sessionId: input.sessionId,
        paymentIntentId: input.paymentIntentId,
        ...(input.connectedAccountId ? { connectedAccountId: input.connectedAccountId } : {}),
        ...(input.amount !== undefined ? { amount: input.amount } : {}),
        idempotencyKey: idempotencyKeyFor(input.sessionId),
        reason: input.reason.slice(0, 200),
        metadata: input.metadata,
        createdAt: now,
        attempts: 0,
        lastError: input.error.slice(0, 500),
        status: "pending",
      };
  store[input.sessionId] = entry;
  console.error(
    `[pending-refunds] auto-refund for ${input.sessionId} could not be created ` +
      `(pi=${input.paymentIntentId}, amount=${input.amount ?? "full"}) — recorded for retry: ${input.error}`,
  );
  persist();
  return entry;
}

export function getPendingRefund(sessionId: string): PendingRefund | undefined {
  ensureLoaded();
  return store[sessionId];
}

export function listPendingRefunds(opts: { includeSettled?: boolean } = {}): PendingRefund[] {
  ensureLoaded();
  const all = Object.values(store).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return opts.includeSettled ? all : all.filter((e) => e.status === "pending" || e.status === "abandoned");
}

/** Operator says the buyer has been made whole another way (dashboard refund, bank transfer). */
export function resolvePendingRefund(sessionId: string, by: string): boolean {
  ensureLoaded();
  const e = store[sessionId];
  if (!e || e.status === "done" || e.status === "resolved") return false;
  e.status = "resolved";
  e.settledAt = new Date().toISOString();
  e.resolvedBy = by.slice(0, 100);
  persist();
  return true;
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

/** Everything the retry needs from Stripe, behind an interface (payout-release pattern). */
export interface RefundGateway {
  /**
   * Is there already a refund on this payment intent carrying our session id?
   * `{ refundId }` = yes; `{ refundId: null }` = definitively no; `null` =
   * could not ask — the caller skips this round rather than risk a duplicate.
   */
  findRefundBySession(
    paymentIntentId: string,
    connectedAccountId: string | undefined,
    sessionId: string,
  ): Promise<{ refundId: string | null } | null>;
  /** Create it. Rejects with the Stripe error; `code` is read for `charge_already_refunded`. */
  createRefund(
    params: Stripe.RefundCreateParams,
    connectedAccountId: string | undefined,
    idempotencyKey: string,
  ): Promise<{ id: string }>;
  /** A landed FULL refund has no proceeds to release. */
  markPayoutVoid(sessionId: string, reason: string): void;
}

export interface RetryOutcome {
  sessionId: string;
  result: "done" | "already-refunded" | "skipped-unverifiable" | "failed" | "abandoned";
  refundId?: string;
  error?: string;
}

function paramsFor(e: PendingRefund): Stripe.RefundCreateParams {
  return {
    payment_intent: e.paymentIntentId,
    reason: "requested_by_customer",
    refund_application_fee: true,
    metadata: e.metadata,
    ...(e.amount !== undefined ? { amount: e.amount } : {}),
  };
}

function settle(e: PendingRefund, refundId: string | undefined, gateway: RefundGateway): void {
  e.status = "done";
  e.settledAt = new Date().toISOString();
  if (refundId) e.refundId = refundId;
  if (e.amount === undefined) {
    try {
      gateway.markPayoutVoid(e.sessionId, `refunded (retry) — ${e.reason}`);
    } catch (err) {
      console.error(`[pending-refunds] markPayoutVoid threw for ${e.sessionId}:`, err);
    }
  }
}

/** One pass over every pending entry. Exported for the test and the ops route. */
export async function retryPendingRefunds(gateway: RefundGateway): Promise<RetryOutcome[]> {
  ensureLoaded();
  const outcomes: RetryOutcome[] = [];
  for (const e of Object.values(store)) {
    if (e.status !== "pending") continue;
    const now = new Date().toISOString();

    // 1. Did it land already? (A lost response, an operator, a previous retry
    //    that crashed between Stripe and persist.)
    const found = await gateway.findRefundBySession(e.paymentIntentId, e.connectedAccountId, e.sessionId);
    if (found === null) {
      outcomes.push({ sessionId: e.sessionId, result: "skipped-unverifiable" });
      continue;
    }
    if (found.refundId) {
      settle(e, found.refundId, gateway);
      outcomes.push({ sessionId: e.sessionId, result: "done", refundId: found.refundId });
      console.log(`[pending-refunds] ${e.sessionId}: refund ${found.refundId} had already landed`);
      persist();
      continue;
    }

    // 2. Create it, same key as the first attempt.
    e.attempts++;
    e.lastAttemptAt = now;
    try {
      const created = await gateway.createRefund(paramsFor(e), e.connectedAccountId, e.idempotencyKey);
      settle(e, created.id, gateway);
      outcomes.push({ sessionId: e.sessionId, result: "done", refundId: created.id });
      console.log(`[pending-refunds] ${e.sessionId}: refund ${created.id} created on retry ${e.attempts}`);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      const msg = err instanceof Error ? err.message : String(err);
      if (code === "charge_already_refunded") {
        // Nothing left to refund: somebody already made the buyer whole.
        settle(e, undefined, gateway);
        outcomes.push({ sessionId: e.sessionId, result: "already-refunded" });
        console.log(`[pending-refunds] ${e.sessionId}: charge already refunded — settled`);
      } else {
        e.lastError = msg.slice(0, 500);
        // A disputed charge cannot be refunded by anyone (Stripe:
        // `charge_disputed`, `refund_disputed_payment`) — the card network is
        // handling the buyer now. Retrying is noise; the row stays alarmed so
        // an operator sees it against the dispute.
        const terminal = code === "charge_disputed" || code === "refund_disputed_payment";
        if (terminal || e.attempts >= MAX_ATTEMPTS) {
          e.status = "abandoned";
          outcomes.push({ sessionId: e.sessionId, result: "abandoned", error: msg });
          console.error(`[pending-refunds] ${e.sessionId}: ABANDONED after ${e.attempts} attempts — operator must refund: ${msg}`);
        } else {
          outcomes.push({ sessionId: e.sessionId, result: "failed", error: msg });
          console.error(`[pending-refunds] ${e.sessionId}: retry ${e.attempts} failed: ${msg}`);
        }
      }
    }
    persist();
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// Timer + health
// ---------------------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;
const health = { lastRunAt: null as string | null, runs: 0, lastError: null as string | null };

export function startPendingRefundRetryJob(gateway: RefundGateway): void {
  if (timer) return;
  const tick = () => {
    // Nothing pending → no Stripe call at all. The common case.
    if (!listPendingRefunds().some((e) => e.status === "pending")) {
      health.lastRunAt = new Date().toISOString();
      health.runs++;
      return;
    }
    void retryPendingRefunds(gateway)
      .then(() => {
        health.lastRunAt = new Date().toISOString();
        health.runs++;
        health.lastError = null;
      })
      .catch((err) => {
        health.lastError = err instanceof Error ? err.message : String(err);
        console.error("[pending-refunds] retry sweep threw:", err);
      });
  };
  const first = setTimeout(() => {
    tick();
    timer = setInterval(tick, RETRY_INTERVAL_MS);
    timer.unref?.();
  }, FIRST_RUN_DELAY_MS);
  first.unref?.();
  // Mark running from the start so health reads "running" during the boot delay.
  timer = first as unknown as NodeJS.Timeout;
  console.log("[pending-refunds] auto-refund retry job started");
}

export interface PendingRefundsHealth {
  /** Either non-zero is an alarm: a buyer paid and has neither ticket nor money. */
  pending: number;
  abandoned: number;
  oldestPendingAt: string | null;
  running: boolean;
  lastRunAt: string | null;
  runs: number;
  lastError: string | null;
}

export function pendingRefundsHealth(): PendingRefundsHealth {
  ensureLoaded();
  const open = Object.values(store);
  const pending = open.filter((e) => e.status === "pending");
  const abandoned = open.filter((e) => e.status === "abandoned");
  const oldest = [...pending, ...abandoned].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  return {
    pending: pending.length,
    abandoned: abandoned.length,
    oldestPendingAt: oldest?.createdAt ?? null,
    running: timer !== null,
    lastRunAt: health.lastRunAt,
    runs: health.runs,
    lastError: health.lastError,
  };
}

/** Tests only. */
export function __resetForTests(): void {
  store = {};
  loaded = false;
  if (timer) {
    clearTimeout(timer);
    clearInterval(timer);
    timer = null;
  }
  health.lastRunAt = null;
  health.runs = 0;
  health.lastError = null;
}
