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

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(process.cwd(), ".data");
const LEDGER_FILE = join(DATA_DIR, "stripe-payout-ledger.json");

export type PayoutEntryStatus = "held" | "released" | "void";

export interface PayoutLedgerEntry {
  /** Stripe Checkout Session id — the natural idempotency key for a sale. */
  sessionId: string;
  stripeAccountId: string;
  /** Organiser's ETH address (lowercase) — the WoCo-side identity. */
  organiserAddress: string;
  kind: "event" | "shop";
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
   */
  netAmount?: number;
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
  try {
    // 0700 applies to a fresh install only — mkdir is a no-op on an existing dir,
    // so it will not fight the current deployment's ownership.
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    // Write-then-rename: a crash mid-write must not leave a truncated ledger,
    // which would read back as "no funds held" and strand organiser money.
    // 0600 because this is commercially sensitive organiser financial data and has
    // no reason to be readable by other users on the host.
    const tmp = `${LEDGER_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(store, null, 2), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, LEDGER_FILE);
  } catch (err) {
    console.error("[payout-ledger] Failed to persist:", err);
  }
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

export function listByOrganiser(organiserAddress: string): PayoutLedgerEntry[] {
  ensureLoaded();
  const key = organiserAddress.toLowerCase();
  return Object.values(store)
    .filter((e) => e.organiserAddress === key)
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
}

/**
 * Record the latest resolved net (and, when the charge settled in a different
 * currency, which one). Reporting only — the sweep re-resolves from Stripe on
 * every run precisely so a refund landing between sweeps is never missed.
 */
export function setNetAmount(sessionId: string, netAmount: number, settlementCurrency?: string): void {
  ensureLoaded();
  const e = store[sessionId];
  if (!e) return;
  e.netAmount = netAmount;
  if (settlementCurrency && settlementCurrency !== e.currency) {
    e.settlementCurrency = settlementCurrency;
  }
  persist();
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
  opts: { forcedSessionIds?: string[] } = {},
): void {
  ensureLoaded();
  const forced = new Set(opts.forcedSessionIds ?? []);
  const releasedAt = new Date().toISOString();
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
 * Void an entry — refunded, or the claim failed and the money went back. Voiding
 * removes it from the release schedule without pretending it was paid out.
 */
export function markVoid(sessionId: string, reason: string): void {
  ensureLoaded();
  const e = store[sessionId];
  if (!e) return;
  e.status = "void";
  e.voidReason = reason.slice(0, 200);
  persist();
}

/** Test seam — resets in-memory state so a fresh file is read. */
export function __resetForTests(): void {
  store = {};
  loaded = false;
}
