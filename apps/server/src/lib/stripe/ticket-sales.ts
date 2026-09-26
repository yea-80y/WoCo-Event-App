/**
 * Ticket-sale record (#645 part C) — which on-chain slots each paid Checkout
 * Session bought, and whether the money for them has gone back.
 *
 * Under `stripe_dashboard.type = full` an organiser can refund a buyer from their
 * own Stripe Dashboard, and a buyer can dispute the charge with their bank. Both
 * leave the minted tickets valid on chain: the contract has no per-slot void. So
 * the platform keeps its own answer to "is this ticket still paid for", and this
 * store is what it is keyed on.
 *
 * VOIDS KEY ON (onChainEventId, slot), NEVER on the orderRef (#661). The orderRef
 * is content-addressed and a buyer can supply someone else's, so a void keyed on
 * it would reach another buyer's tickets. A slot is what fulfilment itself minted
 * for this session, recorded from `batchClaimFor`'s own return value. A void
 * follows the slot, so it survives the ticket being transferred.
 *
 * Written in four steps, each by the only code that knows the fact:
 *   1. the webhook writes a STUB the moment a paid session is consumed — ours or
 *      tampered — carrying the payment intent, which is what refund and dispute
 *      events arrive keyed on;
 *   2. fulfilment appends the slots of each mint chunk as it lands, and records
 *      what it refunds itself (`autoRefunded`), so its own refund of an unfilled
 *      part is never read as the organiser's;
 *   3. the refund handlers (sale-refunds.ts) set or clear the void from Stripe's
 *      current totals — never from the event alone, so delivery order is moot;
 *   4. the dispute handlers do the same from the charge's current disputes: a
 *      chargeback (funds taken back by the bank) voids, a won one lifts it.
 *
 * MUST SURVIVE RESTARTS. Losing it fails OPEN on ticket validity: every refunded
 * ticket reads valid again at the door. The money side does not depend on it —
 * the payout sweep re-reads Stripe for every sale (payout-release.ts).
 *
 * A file that EXISTS but cannot be read is never overwritten (the #424 lesson
 * from onchain-events.json): records keep working in memory for this process,
 * nothing is persisted over the file, and /api/health alarms until an operator
 * restores it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../marketing/persist.js";

const DATA_DIR = join(process.cwd(), ".data");
const STORE_FILE = join(DATA_DIR, "ticket-sales.json");

export interface SaleVoid {
  at: string;
}

export interface TicketSale {
  /** Stripe Checkout Session id — one record per sale. */
  sessionId: string;
  paymentIntentId: string;
  /** From the webhook event's `account`, never from session metadata. */
  connectedAccountId: string;
  /** Absent on a tampered session: its metadata is exactly what failed the check. */
  eventId?: string;
  seriesId?: string;
  quantity: number;
  /** Minor units — what the buyer paid. */
  amountTotal: number;
  currency: string;
  recordedAt: string;
  /** Ours, altered after creation, refunded in full without fulfilment. */
  tampered?: true;
  /** The on-chain event fulfilment minted against (lowercase) — the server's own mint target. */
  onChainEventId?: string;
  /** `contractKey` of the contract minted on (#563). */
  contract?: string;
  /** Slots minted for this sale (edition = slot + 1). */
  slots: number[];
  /**
   * Minor units WE refunded or tried to (fulfilment's unfilled part, or a
   * tampered session in full). Recorded before the refund call, so the refund
   * event that follows is recognised as ours whatever order things land in.
   */
  autoRefunded?: number;
  /** Refunded amount (pending + succeeded) as last read from Stripe. */
  refunded?: number;
  refundCheckedAt?: string;
  /** Why this sale's slots are void. A void of any kind voids every slot. */
  voids?: { refund?: SaleVoid; dispute?: SaleVoid };
  /**
   * The charge's dispute state as last read from Stripe. `chargeback` = funds
   * withdrawn (open or lost) — voids; `inquiry` = a warning_* inquiry, no funds
   * moved — never voids. `needsResponse` = someone must answer it in Stripe.
   */
  dispute?: { state: "chargeback" | "inquiry" | "closed"; needsResponse: boolean; checkedAt: string };
  /**
   * A refund above our own that is not a full refund — the organiser refunded
   * part of an order. Voids nothing (no per-ticket refunds, owner policy
   * 2026-09-25); flagged and alarmed until acknowledged.
   */
  partialRefund?: { amount: number; seenAt: string };
  /** The partial refund an operator has looked at. A LARGER one alarms again. */
  partialRefundAcknowledged?: { amount: number; at: string; by: string };
}

let store: Record<string, TicketSale> = {};
/** paymentIntentId → sessionId. */
const byPaymentIntent = new Map<string, string>();
let loaded = false;
/** Why the file exists but could not be read, or null. */
let fileUnreadable: string | null = null;

function index(sale: TicketSale): void {
  byPaymentIntent.set(sale.paymentIntentId, sale.sessionId);
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  let raw: string;
  try {
    raw = readFileSync(STORE_FILE, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    fileUnreadable = err instanceof Error ? err.message : String(err);
    console.error(`[ticket-sales] ${STORE_FILE} exists but cannot be read — refund voids are OFF until restored:`, err);
    return;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not a JSON object");
    }
    store = parsed as Record<string, TicketSale>;
    for (const sale of Object.values(store)) index(sale);
    console.log(`[ticket-sales] Loaded ${Object.keys(store).length} sale records`);
  } catch (err) {
    store = {};
    fileUnreadable = err instanceof Error ? err.message : String(err);
    console.error(
      `[ticket-sales] ${STORE_FILE} exists but is not readable JSON — it will NOT be overwritten; ` +
        `refund voids are OFF until it is restored:`,
      err,
    );
  }
}

/** False while the file exists but could not be read: nothing written now survives a restart. */
export function isPersisting(): boolean {
  ensureLoaded();
  return fileUnreadable === null;
}

function persist(): void {
  if (fileUnreadable) return;
  writeJsonAtomic(STORE_FILE, store, "ticket-sales", { pretty: true });
}

export interface SaleStubInput {
  sessionId: string;
  paymentIntentId: string;
  connectedAccountId: string;
  eventId?: string;
  seriesId?: string;
  quantity: number;
  amountTotal: number;
  currency: string;
  tampered?: boolean;
  autoRefunded?: number;
}

/**
 * The record a paid session gets the moment the webhook consumes it. Idempotent
 * on sessionId: the session registry already guarantees one call per session,
 * and a second must never reset slots fulfilment has since appended.
 */
export function recordSaleStub(input: SaleStubInput): TicketSale {
  ensureLoaded();
  const existing = store[input.sessionId];
  if (existing) return existing;
  const sale: TicketSale = {
    sessionId: input.sessionId,
    paymentIntentId: input.paymentIntentId,
    connectedAccountId: input.connectedAccountId,
    ...(input.eventId ? { eventId: input.eventId } : {}),
    ...(input.seriesId ? { seriesId: input.seriesId } : {}),
    quantity: input.quantity,
    amountTotal: input.amountTotal,
    currency: input.currency.toLowerCase(),
    recordedAt: new Date().toISOString(),
    ...(input.tampered ? { tampered: true as const } : {}),
    slots: [],
    ...(input.autoRefunded !== undefined ? { autoRefunded: input.autoRefunded } : {}),
  };
  store[input.sessionId] = sale;
  index(sale);
  persist();
  return sale;
}

/**
 * Append the slots one mint chunk produced. Every chunk of a sale mints against
 * the same on-chain event; a chunk naming another is refused rather than
 * silently re-keying the slots already recorded.
 */
export function recordSaleSlots(
  sessionId: string,
  onChainEventId: string,
  contract: string,
  slots: number[],
): boolean {
  ensureLoaded();
  const sale = store[sessionId];
  if (!sale) {
    console.error(`[ticket-sales] slots for ${sessionId} with no sale record — voids cannot reach them`);
    return false;
  }
  const id = onChainEventId.toLowerCase();
  if (sale.onChainEventId && sale.onChainEventId !== id) {
    console.error(
      `[ticket-sales] ${sessionId}: chunk minted against ${id.slice(0, 10)}… but the sale is on ` +
        `${sale.onChainEventId.slice(0, 10)}… — slots NOT recorded`,
    );
    return false;
  }
  sale.onChainEventId = id;
  sale.contract = contract;
  for (const slot of slots) if (!sale.slots.includes(slot)) sale.slots.push(slot);
  persist();
  return true;
}

/** What we refunded ourselves. Only ever grows: one auto-refund per sale, replayed verbatim on retry. */
export function recordAutoRefund(sessionId: string, amount: number): void {
  ensureLoaded();
  const sale = store[sessionId];
  if (!sale) {
    console.error(`[ticket-sales] auto-refund for ${sessionId} with no sale record`);
    return;
  }
  if (sale.autoRefunded !== undefined && sale.autoRefunded >= amount) return;
  sale.autoRefunded = amount;
  persist();
}

export function getSale(sessionId: string): TicketSale | undefined {
  ensureLoaded();
  return store[sessionId];
}

export function getSaleByPaymentIntent(paymentIntentId: string): TicketSale | undefined {
  ensureLoaded();
  const sessionId = byPaymentIntent.get(paymentIntentId);
  return sessionId ? store[sessionId] : undefined;
}

export function isSaleVoid(sale: TicketSale): boolean {
  return !!(sale.voids?.refund || sale.voids?.dispute);
}

/** The state the refund handler moved a sale to. */
export interface RefundStateChange {
  voided: boolean;
  /** A refund void was lifted (the full refund failed or was cancelled). */
  unvoided: boolean;
  /** A partial refund above our own that no operator has acknowledged. */
  partialAlarm: boolean;
}

/**
 * Apply Stripe's CURRENT refund total for a sale's charge. Idempotent and
 * order-free: the same totals always produce the same state, so a replayed or
 * out-of-order event cannot move a sale anywhere a fresh read would not.
 *
 *   refunded >= charged            -> every slot void (covers cancellation)
 *   autoRefunded < refunded < charged -> partial: void nothing, flag + alarm
 *                                     (ticket sales only — a sale with an eventId)
 *   refunded <= autoRefunded       -> our own refund only: nothing to do
 */
export function applyRefundState(
  sessionId: string,
  refunded: number,
  charged: number,
  now: Date = new Date(),
): RefundStateChange | null {
  ensureLoaded();
  const sale = store[sessionId];
  if (!sale) return null;
  const at = now.toISOString();
  const wasVoid = !!sale.voids?.refund;
  const full = charged > 0 && refunded >= charged;

  sale.refunded = refunded;
  sale.refundCheckedAt = at;

  if (full && !wasVoid) {
    sale.voids = { ...sale.voids, refund: { at } };
  } else if (!full && wasVoid) {
    delete sale.voids!.refund;
    if (Object.keys(sale.voids!).length === 0) delete sale.voids;
  }

  // Only a ticket sale can be partly refunded in a way the door cares about; a
  // shop order or a tampered session (no eventId) never raises the flag.
  const ours = sale.autoRefunded ?? 0;
  if (!full && refunded > ours && sale.eventId) {
    if (sale.partialRefund?.amount !== refunded) sale.partialRefund = { amount: refunded, seenAt: at };
  } else {
    delete sale.partialRefund;
  }

  persist();
  return {
    voided: full && !wasVoid,
    unvoided: !full && wasVoid,
    partialAlarm: partialAlarmed(sale),
  };
}

function partialAlarmed(sale: TicketSale): boolean {
  if (!sale.partialRefund) return false;
  return sale.partialRefund.amount > (sale.partialRefundAcknowledged?.amount ?? 0);
}

/** The dispute view of one charge, reduced from Stripe's list (sale-refunds.ts). */
export interface DisputeReading {
  /** Any dispute whose funds are withdrawn and not given back: open chargeback, or lost. */
  chargeback: boolean;
  /** Any warning_* inquiry still open. */
  inquiry: boolean;
  /** Any dispute or inquiry waiting for evidence (needs_response / warning_needs_response). */
  needsResponse: boolean;
  /** Any dispute at all, open or closed. */
  any: boolean;
}

export interface DisputeStateChange {
  voided: boolean;
  /** A dispute void was lifted: the dispute was won (or withdrawn). */
  unvoided: boolean;
}

/**
 * Apply the charge's CURRENT disputes. Idempotent and order-free, like
 * `applyRefundState`. A chargeback voids every slot: the buyer's bank took the
 * money back, whatever the organiser does in Stripe. An inquiry voids nothing
 * (no funds move unless it escalates, which arrives as a status change).
 */
export function applyDisputeState(
  sessionId: string,
  reading: DisputeReading,
  now: Date = new Date(),
): DisputeStateChange | null {
  ensureLoaded();
  const sale = store[sessionId];
  if (!sale) return null;
  const at = now.toISOString();
  const wasVoid = !!sale.voids?.dispute;

  if (reading.chargeback && !wasVoid) {
    sale.voids = { ...sale.voids, dispute: { at } };
  } else if (!reading.chargeback && wasVoid) {
    delete sale.voids!.dispute;
    if (Object.keys(sale.voids!).length === 0) delete sale.voids;
  }

  if (reading.any) {
    sale.dispute = {
      state: reading.chargeback ? "chargeback" : reading.inquiry ? "inquiry" : "closed",
      needsResponse: reading.needsResponse,
      checkedAt: at,
    };
  } else {
    delete sale.dispute;
  }

  persist();
  return { voided: reading.chargeback && !wasVoid, unvoided: !reading.chargeback && wasVoid };
}

/**
 * An operator has looked at a partial refund. Clears the alarm for THIS amount
 * only; a later, larger partial refund alarms again. `by` is required for the
 * same reason as the other ops acknowledgements: an alarm cleared by nobody is
 * an alarm nobody owns.
 */
export function acknowledgePartialRefund(sessionId: string, by: string, now: Date = new Date()): boolean {
  ensureLoaded();
  const sale = store[sessionId];
  if (!sale?.partialRefund) return false;
  sale.partialRefundAcknowledged = { amount: sale.partialRefund.amount, at: now.toISOString(), by };
  persist();
  return true;
}

/**
 * Void slots of one on-chain event on one contract (`contractKey`), sorted.
 * The contract is required: a v2 event id is keccak(sponsor, nonce), so a
 * successor contract with the same sponsor can reuse it (#563). While the file
 * is unreadable this answers from what this process recorded since boot — fail
 * OPEN, with the health alarm up.
 */
export function voidedSlots(onChainEventId: string, contract: string): number[] {
  ensureLoaded();
  const id = onChainEventId.toLowerCase();
  const key = contract.toLowerCase();
  const out = new Set<number>();
  for (const sale of Object.values(store)) {
    if (sale.onChainEventId !== id || sale.contract !== key || !isSaleVoid(sale)) continue;
    for (const slot of sale.slots) out.add(slot);
  }
  return [...out].sort((a, b) => a - b);
}

export type SlotRefundState = "refunded" | "disputed" | "partial";

/**
 * Refund state per slot of one on-chain event on one contract, for the
 * organiser's orders view. `partial` marks every ticket of a partly refunded
 * order: the refund is on the order, not on a ticket, so which ticket it was
 * for is not known here. Contract required, as for `voidedSlots`.
 */
export function slotRefundStates(onChainEventId: string, contract: string): Map<number, SlotRefundState> {
  ensureLoaded();
  const id = onChainEventId.toLowerCase();
  const key = contract.toLowerCase();
  const out = new Map<number, SlotRefundState>();
  for (const sale of Object.values(store)) {
    if (sale.onChainEventId !== id || sale.contract !== key) continue;
    const state: SlotRefundState | null = sale.voids?.refund
      ? "refunded"
      : sale.voids?.dispute
        ? "disputed"
        : sale.partialRefund
          ? "partial"
          : null;
    if (state) for (const slot of sale.slots) out.set(slot, state);
  }
  return out;
}

/** Ops view: sales carrying a void, a partial refund or a dispute, newest first. */
export function listFlaggedSales(): TicketSale[] {
  ensureLoaded();
  return Object.values(store)
    .filter((s) => isSaleVoid(s) || s.partialRefund || s.dispute)
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export interface TicketSalesHealth {
  ok: boolean;
  records: number;
  voidedSales: number;
  /** Partial refunds above our own that no operator has acknowledged — the alarm. */
  partialRefunds: number;
  /** Disputes or inquiries waiting for evidence in Stripe — the alarm (a deadline runs). */
  disputesNeedingResponse: number;
  /** Chargebacks open or lost (tickets void). */
  chargebacks: number;
  /** Inquiries open (tickets still valid). */
  inquiries: number;
  /** The file exists but could not be read: voids are off and nothing is persisted. */
  fileUnreadable: boolean;
}

/** Counts only: this endpoint is public. The ops route has the records. */
export function ticketSalesHealth(): TicketSalesHealth {
  ensureLoaded();
  let voidedSales = 0;
  let partialRefunds = 0;
  let disputesNeedingResponse = 0;
  let chargebacks = 0;
  let inquiries = 0;
  for (const sale of Object.values(store)) {
    if (isSaleVoid(sale)) voidedSales++;
    if (partialAlarmed(sale)) partialRefunds++;
    if (sale.dispute?.needsResponse) disputesNeedingResponse++;
    if (sale.dispute?.state === "chargeback") chargebacks++;
    if (sale.dispute?.state === "inquiry") inquiries++;
  }
  return {
    ok: partialRefunds === 0 && disputesNeedingResponse === 0 && !fileUnreadable,
    records: Object.keys(store).length,
    voidedSales,
    partialRefunds,
    disputesNeedingResponse,
    chargebacks,
    inquiries,
    fileUnreadable: fileUnreadable !== null,
  };
}

/** Tests only — forget in-memory state so the next call reads the file afresh. */
export function __resetForTests(): void {
  store = {};
  byPaymentIntent.clear();
  loaded = false;
  fileUnreadable = null;
}
