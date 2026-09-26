/**
 * Refund events -> ticket voids (#645 part C).
 *
 * `charge.refunded`, `refund.updated` and `refund.failed` arrive on the Connected-accounts webhook
 * for EVERY charge on every connected account: our ticket sales, and under
 * `stripe_dashboard.type = full` the organiser's own sales too. This decides
 * which are ours and moves the sale record (ticket-sales.ts) to match Stripe.
 *
 * Nothing here issues a refund. It only reads Stripe and records what it finds.
 *
 * WHICH ARE OURS. A payment intent in the sale record is ours: the record is
 * written only for a session that passed the provenance check. Otherwise the
 * charge's application fee decides, exactly as for checkout (checkout-provenance.ts):
 *   - no fee on the charge                -> foreign (an organiser's own sale)
 *   - a fee this platform cannot read     -> foreign
 *   - OUR fee, but no sale record yet     -> retry: the record is written when
 *     the paid session is consumed, and a refund can race that (a session left
 *     `unverifiable` keeps retrying). A 500 makes Stripe redeliver.
 *
 * ORDER-FREE. The handler never trusts the event body for amounts. It re-reads
 * the charge and its refunds and applies the TOTAL, so a replayed, late or
 * reordered event lands the sale where a fresh read would.
 *
 * The refunded total counts `pending` and `succeeded` refunds. A refund that
 * fails or is cancelled drops out, which lifts a void it caused. Stripe's
 * statuses are `pending`, `requires_action`, `succeeded`, `failed`, `canceled`
 * (stripe-node Refund.status); `requires_action` is money that has not started
 * back, so it does not void a ticket yet. A cancellation and a
 * requires_action -> succeeded move arrive only as `refund.updated`, which is
 * why that event is handled too.
 */

import {
  applyRefundState,
  getSaleByPaymentIntent,
  isPersisting,
  type RefundStateChange,
  type TicketSale,
} from "./ticket-sales.js";

export interface LatestCharge {
  id: string;
  /** Minor units charged. */
  amount: number;
  /** `application_fee_amount > 0`: the charge asked for a fee (it may not exist yet, #666). */
  feeRequested: boolean;
  feeId: string | null;
}

/** The Stripe reads. Each throws on a transport failure. */
export interface SaleRefundReads {
  /** The payment intent's latest charge on `account`; null when it has none. */
  latestCharge(paymentIntentId: string, account: string): Promise<LatestCharge | null>;
  /** Every refund on the charge, all pages. */
  refundsForCharge(chargeId: string, account: string): Promise<Array<{ amount: number; status: string | null }>>;
  /** Our fee by id, platform key; null when it is not this platform's. */
  retrievePlatformFee(feeId: string): Promise<{ amount: number; account: string } | null>;
}

export interface SaleRefundStore {
  getSaleByPaymentIntent(paymentIntentId: string): TicketSale | undefined;
  applyRefundState(sessionId: string, refunded: number, charged: number): RefundStateChange | null;
  /** False while the record file is unreadable: a state applied now would not survive a restart. */
  persisting(): boolean;
}

const liveStore: SaleRefundStore = { getSaleByPaymentIntent, applyRefundState, persisting: isPersisting };

export type RefundEventOutcome =
  | {
      kind: "applied";
      sessionId: string;
      refunded: number;
      charged: number;
      change: RefundStateChange;
      /** Minted slots on the sale. A void on a sale with none voids no ticket. */
      slots: number;
    }
  | { kind: "foreign"; reason: string }
  /**
   * Answer 500: Stripe redelivers, and nothing was decided. `awaitingRecord` =
   * the charge carries OUR fee and only the sale record is missing.
   */
  | { kind: "retry"; reason: string; awaitingRecord?: true };

const COUNTED_STATUSES = new Set(["pending", "succeeded"]);

export function refundedTotal(refunds: Array<{ amount: number; status: string | null }>): number {
  let total = 0;
  for (const r of refunds) if (r.status && COUNTED_STATUSES.has(r.status)) total += r.amount;
  return total;
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : "read failed";
}

/** A payment intent with no sale record: an organiser's own sale, or ours arriving early. */
async function classifyUnrecorded(
  paymentIntentId: string,
  account: string,
  reads: SaleRefundReads,
): Promise<RefundEventOutcome> {
  try {
    const charge = await reads.latestCharge(paymentIntentId, account);
    if (!charge) return { kind: "foreign", reason: "payment intent has no charge" };
    if (!charge.feeId) {
      return charge.feeRequested
        ? { kind: "retry", reason: "application fee not created yet" }
        : { kind: "foreign", reason: "no application fee on the charge" };
    }
    const fee = await reads.retrievePlatformFee(charge.feeId);
    if (!fee) return { kind: "foreign", reason: "application fee is not this platform's" };
    return { kind: "retry", reason: "our fee, but no sale record yet", awaitingRecord: true };
  } catch (err) {
    return { kind: "retry", reason: errName(err) };
  }
}

/**
 * One reconcile at a time per payment intent. Two refunds made seconds apart
 * deliver two events; run concurrently, the one that READ first could APPLY
 * last and write an older total over a newer one. Chained, each reads after
 * the previous one applied. A link waits at most for its predecessor's Stripe
 * reads, each bounded by stripe-node's default 80 s request timeout
 * (`client.ts` sets none; DEFAULT_TIMEOUT in stripe.core.js).
 */
const inFlight = new Map<string, Promise<RefundEventOutcome>>();

export function reconcileRefundEvent(
  input: { paymentIntentId: string; account: string },
  reads: SaleRefundReads,
  store: SaleRefundStore = liveStore,
): Promise<RefundEventOutcome> {
  const key = input.paymentIntentId;
  const previous = inFlight.get(key);
  const run = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() =>
    reconcileOnce(input, reads, store),
  );
  inFlight.set(key, run);
  void run
    .finally(() => {
      if (inFlight.get(key) === run) inFlight.delete(key);
    })
    .catch(() => undefined);
  return run;
}

async function reconcileOnce(
  input: { paymentIntentId: string; account: string },
  reads: SaleRefundReads,
  store: SaleRefundStore,
): Promise<RefundEventOutcome> {
  const sale = store.getSaleByPaymentIntent(input.paymentIntentId);
  if (!sale) {
    const outcome = await classifyUnrecorded(input.paymentIntentId, input.account, reads);
    noteOutcome(input.paymentIntentId, outcome);
    return outcome;
  }
  if (sale.connectedAccountId !== input.account) {
    // Payment intent ids are unique across Stripe, so this is not a path we
    // expect; the record's account is the one the sale was verified on.
    const outcome: RefundEventOutcome = { kind: "foreign", reason: "event account is not the sale's account" };
    noteOutcome(input.paymentIntentId, outcome);
    return outcome;
  }
  if (!store.persisting()) {
    // The record file is unreadable (ticket-sales.ts). A void applied now would
    // live in memory only and vanish when the operator restores the file and
    // restarts. Stripe redelivers for about three days while /api/health is
    // red; an outage longer than that loses the void (the ticket stays valid).
    return { kind: "retry", reason: "sale record not persisting" };
  }

  let charge: LatestCharge | null;
  let refunded: number;
  try {
    charge = await reads.latestCharge(input.paymentIntentId, input.account);
    if (!charge) return { kind: "retry", reason: "recorded sale has no charge" };
    refunded = refundedTotal(await reads.refundsForCharge(charge.id, input.account));
  } catch (err) {
    return { kind: "retry", reason: errName(err) };
  }

  const change = store.applyRefundState(sale.sessionId, refunded, charge.amount);
  if (!change) return { kind: "retry", reason: "sale record vanished" };
  // Applied in memory but not on disk (a full disk, a failed write): answer as
  // not applied, so Stripe redelivers and the next attempt writes it again.
  if (!change.persisted) return { kind: "retry", reason: "sale record not written" };
  const outcome: RefundEventOutcome = {
    kind: "applied",
    sessionId: sale.sessionId,
    refunded,
    charged: charge.amount,
    change,
    slots: sale.slots.length,
  };
  noteOutcome(input.paymentIntentId, outcome);
  return outcome;
}

// ---------------------------------------------------------------------------
// Event dedupe
// ---------------------------------------------------------------------------

/**
 * Event ids already applied. In memory only, on purpose: every handler here
 * recomputes from Stripe's totals, so re-applying a redelivered event after a
 * restart lands the same state and costs two reads. The set exists to spare
 * those reads for the duplicate deliveries Stripe makes while we are up. An id
 * is marked only AFTER it was applied — a `retry` must stay retryable.
 */
const applied = new Map<string, number>();
/** Stripe retries for up to three days; past that an id cannot come back. */
const APPLIED_TTL_MS = 4 * 24 * 60 * 60_000;
const APPLIED_MAX = 20_000;

export function alreadyApplied(eventId: string, now = Date.now()): boolean {
  const at = applied.get(eventId);
  return at !== undefined && now - at < APPLIED_TTL_MS;
}

export function noteApplied(eventId: string, now = Date.now()): void {
  applied.set(eventId, now);
  if (applied.size <= APPLIED_MAX) return;
  for (const [id, at] of applied) {
    if (now - at >= APPLIED_TTL_MS || applied.size > APPLIED_MAX) applied.delete(id);
    else break;
  }
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

const counts = { foreign: 0, voided: 0, unvoided: 0 };

/**
 * Payment intents carrying OUR fee whose sale record has not appeared, with
 * the time of the first attempt. Keyed rather than counted, like checkout
 * provenance's `unresolved`: a counter either never alarms or alarms for ever
 * after one race. In memory — a restart forgets, and Stripe's next retry puts
 * it back.
 */
const awaitingSince = new Map<string, number>();

/** A refund on our sale with no record for this long is not a race any more. */
export const AWAITING_ALARM_MS = 60 * 60_000;

function noteOutcome(paymentIntentId: string, outcome: RefundEventOutcome): void {
  if (outcome.kind === "retry" && outcome.awaitingRecord) {
    if (!awaitingSince.has(paymentIntentId)) awaitingSince.set(paymentIntentId, Date.now());
    return;
  }
  awaitingSince.delete(paymentIntentId);
  if (outcome.kind === "foreign") counts.foreign++;
  // A sale with no slots (a tampered session, a shop order, a sale that minted
  // nothing) voids no ticket; counting it would read as a ticket refund.
  if (outcome.kind === "applied" && outcome.slots > 0) {
    if (outcome.change.voided) counts.voided++;
    if (outcome.change.unvoided) counts.unvoided++;
  }
}

/**
 * `/api/health` section. The alarm is a refund on one of our sales that has
 * waited AWAITING_ALARM_MS for its sale record: that ticket stays valid at the
 * door. Foreign refunds are an organiser's own sales and are only counted.
 * Counts only — this endpoint is public.
 */
export function saleRefundEventsHealth(now = Date.now()): {
  ok: boolean;
  foreign: number;
  voided: number;
  unvoided: number;
  awaitingRecord: number;
  stuck: number;
} {
  let stuck = 0;
  for (const since of awaitingSince.values()) if (now - since >= AWAITING_ALARM_MS) stuck++;
  return { ok: stuck === 0, ...counts, awaitingRecord: awaitingSince.size, stuck };
}

/** Tests only. */
export function _resetSaleRefundStateForTest(): void {
  counts.foreign = 0;
  counts.voided = 0;
  counts.unvoided = 0;
  awaitingSince.clear();
  applied.clear();
  inFlight.clear();
}
