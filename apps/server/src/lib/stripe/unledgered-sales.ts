/**
 * Unledgered sales (#805): charges that carry OUR application fee, so they are
 * WoCo sales, but that have no payout-ledger row.
 *
 * Such a sale's money sits in the organiser's balance with nothing to say whose
 * it is, and the release sweep's balance check (#781 part 2) would read it as a
 * surplus and pay it out after SURPLUS_SETTLE_DAYS, before the event and outside
 * any cancellation hold. It only happens after a failure: a webhook never
 * processed (an outage past Stripe's retries, a wrong signing secret), a crash
 * between consuming the session and recording it, a delayed payment method. In
 * each the buyer has no ticket either. So while one is open on an account, that
 * account's surplus is held, and /api/health pages.
 *
 * Found from the PLATFORM's application fees, not per account. One list covers
 * every connected account, including one whose every sale was missed (the sweep
 * never visits it, having nothing in the ledger), and an organiser's own payment
 * cannot appear: only a platform sets a fee, the same proof checkout-provenance.ts
 * relies on.
 *
 * A sale stops being open once it is ledgered (a late fulfilment) or refunded in
 * full. A disputed one stays open until an operator resolves it.
 *
 * File-backed: the scan cursor, the open set (it outlives the rescan window) and
 * what operators resolved. Losing the file costs one full rescan and re-opens
 * what was resolved; it never lets a surplus be paid.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../marketing/persist.js";
import { getStripe } from "./client.js";
import { getEntry, ledgeredPaymentIntents } from "./payout-ledger.js";
import { getSaleByPaymentIntent } from "./ticket-sales.js";

const DATA_DIR = join(process.cwd(), ".data");
const UNLEDGERED_FILE = join(DATA_DIR, "stripe-unledgered-charges.json");

/**
 * A sale younger than this holds its account's surplus but does not alarm: the
 * webhook records it within seconds. It must still hold, since a surplus that
 * shrinks in the same hour (a chargeback after payout) would let the new money
 * stand in for the part that left.
 */
export const UNLEDGERED_GRACE_S = 60 * 60;
/** Each scan re-reads fees from this far before the last one, covering the grace and clock skew. */
const RESCAN_OVERLAP_S = 2 * 24 * 60 * 60;

/** One of our application fees and the charge it was taken from. */
export interface FeeCharge {
  feeId: string;
  /** The connected account the charge is on. */
  account: string;
  /** When the fee was created, unix seconds. */
  created: number;
  chargeId: string;
  paymentIntentId: string | null;
  amount: number;
  amountRefunded: number;
  currency: string;
  /** Stripe returned the charge as a bare id, so nothing about it can be vouched for. */
  unreadable?: true;
}

export interface UnledgeredReads {
  /** Our fees created at or after `gte` (unix seconds; null = all), each with its charge. Throws on failure. */
  listFees(gte: number | null): AsyncIterable<FeeCharge>;
  /** One fee with its charge; null if it does not exist. Throws on failure. */
  getFee(feeId: string): Promise<FeeCharge | null>;
}

export interface OpenSale {
  account: string;
  feeId: string;
  paymentIntentId: string | null;
  currency: string;
  amount: number;
  created: number;
  unreadable?: true;
}

interface Store {
  /** Start of the last scan that completed, unix seconds. */
  cursor: number | null;
  /** chargeId → an unledgered sale. */
  open: Record<string, OpenSale>;
  /** chargeId → the operator who resolved it. */
  resolved: Record<string, { by: string; at: string; reason?: string }>;
}

let store: Store = { cursor: null, open: {}, resolved: {} };
let loaded = false;
let lastScanAt: string | null = null;
let lastError: string | null = null;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(readFileSync(UNLEDGERED_FILE, "utf-8")) as Partial<Store>;
    store = { cursor: raw.cursor ?? null, open: raw.open ?? {}, resolved: raw.resolved ?? {} };
  } catch {
    // Nothing scanned yet, or unreadable: the next scan is a full one.
  }
}

function persist(): void {
  writeJsonAtomic(UNLEDGERED_FILE, store, "unledgered-sales", { pretty: true });
}

/**
 * Whether a payment intent's sale is in the ledger, held or released: by its
 * payment intent, or through its sale record for a row written without one.
 * Nothing we wrote about a refund counts (a void row, `autoRefunded`, a tampered
 * session): each is recorded before or apart from the refund itself, and a refund
 * that never happened leaves the money in the balance. Only the charge's own
 * `amount_refunded` closes a sale that way.
 */
export function liveAccountedFor(): (paymentIntentId: string) => boolean {
  const ledgered = ledgeredPaymentIntents();
  return (paymentIntentId) => {
    if (ledgered.has(paymentIntentId)) return true;
    const sale = getSaleByPaymentIntent(paymentIntentId);
    const entry = sale ? getEntry(sale.sessionId) : undefined;
    return !!entry && entry.status !== "void";
  };
}

function classify(
  f: FeeCharge,
  accountedFor: (pi: string) => boolean,
  nowSec: number,
): "closed" | "young" | "open" {
  if (store.resolved[f.chargeId]) return "closed";
  if (!f.unreadable) {
    if (f.amountRefunded >= f.amount) return "closed";
    if (f.paymentIntentId && accountedFor(f.paymentIntentId)) return "closed";
  }
  return nowSec - f.created < UNLEDGERED_GRACE_S ? "young" : "open";
}

function toOpen(f: FeeCharge): OpenSale {
  return {
    account: f.account,
    feeId: f.feeId,
    paymentIntentId: f.paymentIntentId,
    currency: f.currency,
    amount: f.amount,
    created: f.created,
    ...(f.unreadable ? { unreadable: true as const } : {}),
  };
}

/**
 * Re-read our fees since the last scan, plus every sale still open from before
 * it, and return how many unledgered sales each connected account has. `null`
 * when any read failed: the caller holds every surplus, since a sale it could
 * not see may be in any of them.
 */
export async function scanUnledgeredSales(
  reads: UnledgeredReads,
  accountedFor: (paymentIntentId: string) => boolean,
  now: Date,
): Promise<Map<string, number> | null> {
  ensureLoaded();
  const nowSec = Math.floor(now.getTime() / 1000);
  const next: Record<string, OpenSale> = {};
  const young = new Map<string, number>();
  try {
    const seen = new Set<string>();
    for await (const f of reads.listFees(store.cursor === null ? null : store.cursor - RESCAN_OVERLAP_S)) {
      seen.add(f.chargeId);
      const state = classify(f, accountedFor, nowSec);
      if (state === "open") next[f.chargeId] = toOpen(f);
      else if (state === "young") young.set(f.account, (young.get(f.account) ?? 0) + 1);
    }
    // Older than the window: re-read each until it is ledgered or refunded. A
    // fee Stripe no longer returns stays open: unread is not resolved.
    for (const [chargeId, o] of Object.entries(store.open)) {
      if (seen.has(chargeId)) continue;
      const f = await reads.getFee(o.feeId);
      if (!f) next[chargeId] = o;
      else if (classify(f, accountedFor, nowSec) !== "closed") next[chargeId] = toOpen(f);
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    console.error("[unledgered-sales] Scan failed - every surplus is held this sweep:", err);
    return null;
  }

  const opened = Object.keys(next).filter((id) => !store.open[id]);
  for (const id of opened) {
    console.error(
      `[unledgered-sales] ⚠️ ${id} on ${next[id]!.account} carries our fee but has no payout-ledger row - ` +
        `the buyer may have no ticket. Its account's surplus is held until it is ledgered, refunded or resolved.`,
    );
  }
  store = { ...store, cursor: nowSec, open: next };
  persist();
  lastScanAt = now.toISOString();
  lastError = null;

  const byAccount = young;
  for (const o of Object.values(next)) byAccount.set(o.account, (byAccount.get(o.account) ?? 0) + 1);
  return byAccount;
}

export function listOpenUnledgeredSales(): Array<{ chargeId: string } & OpenSale> {
  ensureLoaded();
  return Object.entries(store.open).map(([chargeId, o]) => ({ chargeId, ...o }));
}

/**
 * An operator has dealt with an open sale another way: a chargeback the bank
 * decided, a buyer refunded by hand in part. It no longer holds the surplus.
 * Only an open sale can be resolved; this moves no money.
 */
export function resolveUnledgeredSale(chargeId: string, by: string, reason?: string): OpenSale | null {
  ensureLoaded();
  const open = store.open[chargeId];
  if (!open) return null;
  const { [chargeId]: _gone, ...rest } = store.open;
  store = {
    ...store,
    open: rest,
    resolved: { ...store.resolved, [chargeId]: { by, at: new Date().toISOString(), ...(reason ? { reason } : {}) } },
  };
  persist();
  return open;
}

/** Counts only: the health endpoint is public. */
export function unledgeredSalesHealth(): { open: number; lastScanAt: string | null; lastError: string | null } {
  ensureLoaded();
  return { open: Object.keys(store.open).length, lastScanAt, lastError };
}

export function feeChargeFrom(fee: import("stripe").Stripe.ApplicationFee): FeeCharge {
  const charge = fee.charge;
  const account = typeof fee.account === "string" ? fee.account : fee.account.id;
  // An id alone cannot say whether the sale was refunded or ledgered, so the
  // sale is open on its own account. Throwing would hold every account's
  // surplus for as long as Stripe keeps returning it this way.
  if (typeof charge === "string") {
    return {
      feeId: fee.id,
      account,
      created: fee.created,
      chargeId: charge,
      paymentIntentId: null,
      amount: 0,
      amountRefunded: 0,
      currency: fee.currency,
      unreadable: true,
    };
  }
  return {
    feeId: fee.id,
    account,
    created: fee.created,
    chargeId: charge.id,
    paymentIntentId:
      typeof charge.payment_intent === "string" ? charge.payment_intent : (charge.payment_intent?.id ?? null),
    amount: charge.amount,
    amountRefunded: charge.amount_refunded,
    currency: charge.currency,
  };
}

/** Platform key, no Stripe-Account header: Stripe returns only the fees this platform collected. */
export const liveUnledgeredReads: UnledgeredReads = {
  async *listFees(gte) {
    const params = {
      limit: 100,
      expand: ["data.charge"],
      ...(gte === null ? {} : { created: { gte } }),
    };
    for await (const fee of getStripe().applicationFees.list(params)) yield feeChargeFrom(fee);
  },
  async getFee(feeId) {
    try {
      return feeChargeFrom(await getStripe().applicationFees.retrieve(feeId, { expand: ["charge"] }));
    } catch (err) {
      if ((err as { code?: string }).code === "resource_missing") return null;
      throw err;
    }
  },
};

/** Test seam: forget memory so a fresh file is read. */
export function __resetForTests(): void {
  store = { cursor: null, open: {}, resolved: {} };
  loaded = false;
  lastScanAt = null;
  lastError = null;
}
