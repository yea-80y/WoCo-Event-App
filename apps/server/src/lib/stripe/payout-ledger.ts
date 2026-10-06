/**
 * Payout ledger — which organiser takings are held, and when each may be released.
 *
 * Connected accounts run on `interval: "manual"` (see payout-policy.ts), so Stripe
 * never moves organiser money on its own. This ledger is what decides that it
 * moves at all: one entry per paid Checkout Session, carrying the date its funds
 * become releasable.
 *
 * Why per-charge and not just "pay out the balance": a connected account holds ONE
 * pooled balance across every event it sells. An organiser running a gig next week
 * and a festival in six months has both sets of takings in the same pot. Paying out
 * the available balance after the gig would hand over the festival's money too, and
 * a later cancellation would leave attendees unrefundable. The ledger is what makes
 * "release only what this event earned" expressible.
 *
 * File-backed JSON, same pattern as stripe-accounts.json / consumed-tx-hashes.json.
 * MUST survive restarts: losing it means either stranding organiser funds or
 * releasing them without knowing which event they belong to.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PayoutEntryStatus } from "@woco/shared";
import { writeJsonAtomic } from "../marketing/persist.js";

const DATA_DIR = join(process.cwd(), ".data");
const LEDGER_FILE = join(DATA_DIR, "stripe-payout-ledger.json");

// The organiser-facing view of this ledger is a shared type (the payouts screen
// reads it), and status is the one field both sides must agree on.
export type { PayoutEntryStatus };

export interface PayoutLedgerEntry {
  /** Stripe Checkout Session id — the natural idempotency key for a sale. */
  sessionId: string;
  stripeAccountId: string;
  /** Organiser's ETH address (lowercase) — the WoCo-side identity. */
  organiserAddress: string;
  /**
   * `reconciliation`: not a sale. The part of a payout that settled money the
   * balance gained or lost outside any sale (#781 part 2) — a chargeback after
   * an earlier payout, a debt Stripe recovered from the organiser's bank, a won
   * dispute. Written already released, with its payout.
   */
  kind: "event" | "shop" | "reconciliation";
  eventId?: string;
  seriesId?: string;
  shopId?: string;
  orderId?: string;
  /** Lowercase 3-letter ISO code of the CHARGE (presentment currency). */
  currency: string;
  /**
   * Lowercase ISO code the funds actually settled in, when it differs from
   * `currency` — Stripe converts a charge whose currency has no matching bank
   * account into the account's default currency. Set from the balance
   * transaction; release grouping, balance reads and the payout itself all use
   * this over `currency` once known. `netAmount` is in THIS currency.
   */
  settlementCurrency?: string;
  /** Minor units, `session.amount_total` — what the buyer paid, in `currency`. */
  grossAmount: number;
  /** PaymentIntent id; the route to the balance transaction that gives us net. */
  paymentIntentId?: string;
  /**
   * Minor units actually credited to the connected account: gross minus Stripe
   * processing minus our application fee, minus any refunds. Resolved from the
   * balance transaction and REFRESHED on every sweep while the entry is held —
   * a refund can land at any time before release, so this is a running record
   * for reporting, never a value the sweep trusts without re-reading Stripe.
   * Final only once the entry leaves "held".
   *
   * NEGATIVE once a refund or chargeback has taken more than the sale brought
   * in: Stripe keeps its processing fee on a refund, and our fee stays kept too
   * unless returned. That money has already left the pooled balance, so the
   * entry stays held and is netted into the account's next payout (#781).
   * Released with a negative net = the payout it was deducted from.
   */
  netAmount?: number;
  /**
   * Re-read from Stripe on the next sweep, whatever the release date (#781).
   * Set when a refund or dispute moves on the sale, so a debt is netted at the
   * next payout instead of waiting for its own event's date. A hint only: the
   * sweep still reads every amount from Stripe, and a lost flag delays a debt,
   * it never pays one out.
   */
  recheck?: boolean;
  recordedAt: string;
  /** Earliest release — event end + grace, or shop settle delay. */
  releaseAfter: string;
  status: PayoutEntryStatus;
  payoutId?: string;
  releasedAt?: string;
  /** Set with status "void": refunded or never claimable, nothing to pay out. */
  voidReason?: string;
  /**
   * True when Stripe's country hold ceiling forced release BEFORE the event.
   * Reconciliation flag: these are the sales where our attendee-protection story
   * does not hold, and they need to be visible rather than silent.
   */
  forcedByCeiling?: boolean;
}

/** sessionId → entry */
let store: Record<string, PayoutLedgerEntry> = {};
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    store = JSON.parse(readFileSync(LEDGER_FILE, "utf-8")) as Record<string, PayoutLedgerEntry>;
    const held = Object.values(store).filter((e) => e.status === "held").length;
    console.log(`[payout-ledger] Loaded ${Object.keys(store).length} entries (${held} held) from disk`);
  } catch {
    // No ledger yet — first run.
  }
}

function persist(): void {
  // 0600 + write-then-rename now come from writeJsonAtomic, which also fsyncs
  // (this file's own rename could survive a power cut with unwritten bytes) and
  // alarms on /api/health. A truncated ledger reads back as "no funds held" and
  // strands organiser money, so the guarantee matters more here than anywhere.
  writeJsonAtomic(LEDGER_FILE, store, "payout-ledger", { pretty: true });
}

/**
 * Record a sale as held funds. Idempotent on sessionId: the Stripe webhook can
 * deliver the same session twice (platform + connected endpoints, plus retries),
 * and a duplicate must never create a second claim on the same money.
 */
export function recordHeld(
  entry: Omit<PayoutLedgerEntry, "status" | "recordedAt"> & { recordedAt?: string },
): PayoutLedgerEntry {
  ensureLoaded();
  const existing = store[entry.sessionId];
  if (existing) return existing;

  const record: PayoutLedgerEntry = {
    ...entry,
    recordedAt: entry.recordedAt ?? new Date().toISOString(),
    currency: entry.currency.toLowerCase(),
    organiserAddress: entry.organiserAddress.toLowerCase(),
    status: "held",
  };
  store[entry.sessionId] = record;
  persist();
  return record;
}

export function getEntry(sessionId: string): PayoutLedgerEntry | undefined {
  ensureLoaded();
  return store[sessionId];
}

export function listHeld(): PayoutLedgerEntry[] {
  ensureLoaded();
  return Object.values(store).filter((e) => e.status === "held");
}

/** Every event sale recorded for an event, any status (#644). */
export function listEntriesForEvent(eventId: string): PayoutLedgerEntry[] {
  ensureLoaded();
  return Object.values(store).filter((e) => e.kind === "event" && e.eventId === eventId);
}

export function listByOrganiser(organiserAddress: string): PayoutLedgerEntry[] {
  ensureLoaded();
  const key = organiserAddress.toLowerCase();
  return Object.values(store)
    .filter((e) => e.organiserAddress === key)
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
}

/**
 * Record the latest resolved net (and, when the charge settled in a different
 * currency, which one), and clear any recheck flag: the sweep has just read the
 * sale. Reporting only — the sweep re-resolves from Stripe on every run
 * precisely so a refund landing between sweeps is never missed.
 */
export function setNetAmount(sessionId: string, netAmount: number, settlementCurrency?: string): void {
  ensureLoaded();
  const e = store[sessionId];
  if (!e) return;
  const currency = settlementCurrency && settlementCurrency !== e.currency ? settlementCurrency : e.settlementCurrency;
  if (e.netAmount === netAmount && e.settlementCurrency === currency && !e.recheck) return;
  e.netAmount = netAmount;
  if (currency) e.settlementCurrency = currency;
  delete e.recheck;
  persist();
}

/**
 * Ask the next sweep to re-read this sale from Stripe now, whatever its release
 * date (#781). Called when a refund or dispute moves on it. Returns false when
 * the ledger has no such sale (an organiser's own, or a shop order).
 */
export function flagForRecheck(sessionId: string): boolean {
  ensureLoaded();
  const e = store[sessionId];
  if (!e) return false;
  if (e.recheck) return true;
  e.recheck = true;
  persist();
  return true;
}

/**
 * Put a voided sale back under the sweep (#781). Before #781 a sale whose net
 * went below zero was voided, and that debt dropped out of the arithmetic while
 * Stripe had already taken it from the balance. Reopened, the sweep re-reads
 * the sale from Stripe and nets whatever it is really worth. Only a void can be
 * reopened: a released sale's money has left.
 */
export function reopenVoid(sessionId: string): PayoutLedgerEntry | null {
  ensureLoaded();
  const e = store[sessionId];
  if (!e || e.status !== "void") return null;
  e.status = "held";
  e.recheck = true;
  delete e.voidReason;
  persist();
  return e;
}

export function markReleased(
  sessionId: string,
  payoutId: string,
  opts: { forcedByCeiling?: boolean } = {},
): void {
  ensureLoaded();
  const e = store[sessionId];
  if (!e) return;
  e.status = "released";
  e.payoutId = payoutId;
  e.releasedAt = new Date().toISOString();
  if (opts.forcedByCeiling) e.forcedByCeiling = true;
  persist();
}

/**
 * Mark a whole payout's entry set released in ONE persisted write. A per-entry
 * loop can be interrupted half way, leaving already-paid entries "held" — a
 * partial set that would be paid a second time under a fresh idempotency key.
 */
export function markManyReleased(
  sessionIds: string[],
  payoutId: string,
  opts: { forcedSessionIds?: string[]; recon?: ReconRow } = {},
): void {
  ensureLoaded();
  const forced = new Set(opts.forcedSessionIds ?? []);
  const releasedAt = new Date().toISOString();
  // The reconciliation row is written in the SAME persist as the sales, so a
  // payout's rows always add up to what it paid.
  if (opts.recon && !store[opts.recon.id]) {
    const r = opts.recon;
    store[r.id] = {
      sessionId: r.id,
      stripeAccountId: r.stripeAccountId,
      organiserAddress: r.organiserAddress.toLowerCase(),
      kind: "reconciliation",
      currency: r.currency,
      grossAmount: 0,
      netAmount: r.amount,
      recordedAt: releasedAt,
      releaseAfter: releasedAt,
      status: "released",
    };
  }
  for (const sessionId of sessionIds) {
    const e = store[sessionId];
    if (!e) continue;
    e.status = "released";
    e.payoutId = payoutId;
    e.releasedAt = releasedAt;
    if (forced.has(sessionId)) e.forcedByCeiling = true;
  }
  persist();
}

/**
 * Void an entry whose sale came to exactly nothing. Voiding removes it from the
 * release schedule without pretending it was paid out. Never for a negative
 * net: that is a debt the next payout must carry (#781).
 */
export function markVoid(sessionId: string, reason: string): void {
  ensureLoaded();
  const e = store[sessionId];
  if (!e) return;
  e.status = "void";
  e.voidReason = reason.slice(0, 200);
  persist();
}

/** The money a payout settled that no sale accounts for (#781 part 2). */
export interface ReconRow {
  id: string;
  stripeAccountId: string;
  organiserAddress: string;
  /** Payout currency, lowercase. */
  currency: string;
  /** Signed minor units: negative = deducted, positive = paid out. */
  amount: number;
}

/** The organiser behind a connected account, from any entry it has. */
export function organiserForAccount(stripeAccountId: string): string | undefined {
  ensureLoaded();
  for (const e of Object.values(store)) if (e.stripeAccountId === stripeAccountId) return e.organiserAddress;
  return undefined;
}

/**
 * Every account + payout currency that has held or released money (#781 part 2).
 * The sweep visits each one, not only those with sales held: a chargeback after
 * the last payout, or a debt Stripe recovered from the bank, moves an account's
 * balance with nothing held.
 */
export function listAccountGroups(): Array<{ stripeAccountId: string; currency: string }> {
  ensureLoaded();
  const seen = new Map<string, { stripeAccountId: string; currency: string }>();
  for (const e of Object.values(store)) {
    if (e.status === "void") continue;
    const currency = e.settlementCurrency ?? e.currency;
    seen.set(`${e.stripeAccountId}|${currency}`, { stripeAccountId: e.stripeAccountId, currency });
  }
  return [...seen.values()];
}

/** Test seam — resets in-memory state so a fresh file is read. */
export function __resetForTests(): void {
  store = {};
  loaded = false;
}
