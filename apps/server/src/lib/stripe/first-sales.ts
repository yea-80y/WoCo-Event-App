/**
 * When each Stripe connected account made its first paid sale through WoCo:
 * the start of its launch-rate clock (launch-rate.ts, Organiser Terms §6).
 *
 * Stripe is the record. A first sale is the earliest of OUR application fees on
 * the account that we have not returned in full: a failed mint, a refund Stripe
 * first refused, a tampered session and (if ever turned on) a cancellation with
 * the fee returned all hand the whole fee back, and none of those starts a
 * clock. A buyer's refund where we keep the fee still does. The platform fee
 * list has no account filter and lists newest first, so the whole list is read
 * and the earliest kept per account: incrementally each payout sweep (hourly),
 * and in full once a week, replacing the map, so a first sale whose fee was
 * returned after it was recorded drops out.
 *
 * This file is a cache of that read, never the only record: missing, unreadable,
 * the wrong shape or from the other key mode all read as empty and the next
 * sweep rebuilds it. Empty means the launch rate for every account, the failure
 * direction the owner chose (2026-11-25): we may undercharge, never overcharge.
 * It is written only after a scan completes, so a partial read is never kept.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Stripe from "stripe";
import { writeJsonAtomic } from "../marketing/persist.js";
import { getStripe } from "./client.js";
import { stripeKeyMode } from "./key-mode.js";
import { listAllEntries } from "./payout-ledger.js";

const DATA_DIR = join(process.cwd(), ".data");
const FIRST_SALES_FILE = join(DATA_DIR, "stripe-first-sales.json");

const DAY_S = 24 * 60 * 60;
/** Each incremental scan re-reads fees from this far before the last one, covering clock skew and late refunds. */
const RESCAN_OVERLAP_S = 2 * DAY_S;
/** How often the map is rebuilt from the whole fee list. */
export const FULL_REBUILD_S = 7 * DAY_S;
/** Health: red when no scan has completed for this long. */
const SCAN_STALE_S = DAY_S;
/** Health: red when no full rebuild has completed for this long. */
const FULL_STALE_S = 8 * DAY_S;
/** Health: a ledgered sale older than this with no first sale on record is one the scan missed. */
const UNCOVERED_AFTER_S = DAY_S;

/** One of our application fees, as the scan needs it. */
export interface FeeStart {
  feeId: string;
  /** The connected account the fee was collected on. */
  account: string;
  /** Unix seconds. */
  created: number;
  /** The fee's own amount and how much of it we returned, minor units. */
  amount: number;
  amountRefunded: number;
  livemode: boolean;
}

export interface FirstSaleReads {
  /** Our fees created at or after `gte` (unix seconds; null = all of them). Throws on failure. */
  listFees(gte: number | null): AsyncIterable<FeeStart>;
}

interface FirstSale {
  /** Unix seconds. */
  created: number;
  feeId: string;
}

interface Store {
  /** The key mode the map was read with: a file from the other mode is not ours to use. */
  livemode: boolean;
  /** Start of the last scan that completed, unix seconds. */
  cursor: number;
  /** Start of the last full rebuild that completed, unix seconds. */
  lastFullAt: number;
  /** A recorded first sale has since had its fee returned: rebuild in full next sweep. */
  fullDue: boolean;
  accounts: Record<string, FirstSale>;
}

let store: Store | null = null;
let loaded = false;
const bootAt = Math.floor(Date.now() / 1000);
let lastScanAt: number | null = null;
let lastError: string | null = null;

/** The server key's mode; null when it cannot be judged (key-mode.ts), and then nothing is read or kept. */
export function currentLivemode(key: string | undefined = process.env.STRIPE_SECRET_KEY): boolean | null {
  const mode = stripeKeyMode(key);
  return mode === "unknown" ? null : mode === "live";
}

function isStore(v: unknown): v is Store {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Partial<Store>;
  if (typeof s.livemode !== "boolean" || !Number.isSafeInteger(s.cursor) || !Number.isSafeInteger(s.lastFullAt)) return false;
  if (typeof s.fullDue !== "boolean" || typeof s.accounts !== "object" || s.accounts === null) return false;
  return Object.values(s.accounts).every(
    (a) => typeof a === "object" && a !== null && Number.isSafeInteger(a.created) && typeof a.feeId === "string",
  );
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw: unknown = JSON.parse(readFileSync(FIRST_SALES_FILE, "utf-8"));
    store = isStore(raw) ? raw : null;
  } catch {
    store = null;
  }
}

/** The store for this key mode, or null: none yet, or one written in the other mode. */
function storeFor(livemode: boolean | null): Store | null {
  ensureLoaded();
  return livemode !== null && store?.livemode === livemode ? store : null;
}

/**
 * When `account` made its first paid sale, epoch ms; null when none is on record,
 * which the launch rate reads as "not started" whatever the reason.
 */
export function firstSaleAtMs(account: string, livemode: boolean | null = currentLivemode()): number | null {
  const s = storeFor(livemode)?.accounts[account];
  return s ? s.created * 1000 : null;
}

const earlier = (f: FeeStart, cur: FirstSale | undefined) =>
  !cur || f.created < cur.created || (f.created === cur.created && f.feeId < cur.feeId);

/**
 * Read our fees since the last scan (all of them when a full rebuild is due) and
 * record the earliest kept one per account. Returns false when the read failed;
 * nothing is written then, and the previous map stays in use.
 */
export async function scanFirstSales(reads: FirstSaleReads, livemode: boolean | null, now: Date): Promise<boolean> {
  if (livemode === null) {
    lastError = "Stripe key mode unknown - first sales not read";
    return false;
  }
  const prev = storeFor(livemode);
  const nowSec = Math.floor(now.getTime() / 1000);
  const full = !prev || prev.fullDue || nowSec - prev.lastFullAt >= FULL_REBUILD_S;
  const next: Record<string, FirstSale> = full ? {} : { ...prev.accounts };
  // Accounts whose recorded first sale had its fee returned this scan. An
  // incremental read cannot see what is earliest among the rest, so they read
  // as not started (the launch rate) until the full rebuild this forces next
  // sweep, whatever order Stripe lists the fees in.
  const dropped = new Set<string>();
  try {
    for await (const f of reads.listFees(full ? null : prev.cursor - RESCAN_OVERLAP_S)) {
      if (f.livemode !== livemode) continue;
      if (f.amountRefunded >= f.amount) {
        // Returned in full: never a first sale.
        if (!full && prev.accounts[f.account]?.feeId === f.feeId) {
          dropped.add(f.account);
          delete next[f.account];
        }
        continue;
      }
      if (earlier(f, next[f.account])) next[f.account] = { created: f.created, feeId: f.feeId };
    }
    for (const account of dropped) delete next[account];
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    console.error("[first-sales] Scan failed - launch rates read the last complete scan:", err);
    return false;
  }
  store = {
    livemode,
    cursor: nowSec,
    lastFullAt: full ? nowSec : prev!.lastFullAt,
    fullDue: dropped.size > 0,
    accounts: next,
  };
  writeJsonAtomic(FIRST_SALES_FILE, store, "first-sales", { pretty: true });
  lastScanAt = nowSec;
  lastError = null;
  return true;
}

export interface FirstSalesHealth {
  ok: boolean;
  lastScanAt: string | null;
  lastFullAt: string | null;
  lastError: string | null;
  /** No scan has completed for a day while the payout sweep runs. */
  stale: boolean;
  /** No full rebuild for 8 days while the payout sweep runs. */
  fullOverdue: boolean;
  /**
   * Accounts with a ledgered sale over a day old and no first sale on record:
   * the scan missed it, and the account is on the launch rate for ever until it
   * is found. Counted only once a full rebuild has completed.
   */
  uncovered: number;
}

/**
 * Flags and times only: the health endpoint is public, and how many accounts have
 * sold is not its to say. `sweepRunning` = the payout sweep that drives the scan is on.
 */
export function firstSalesHealth(sweepRunning: boolean, now: Date = new Date(), livemode: boolean | null = currentLivemode()): FirstSalesHealth {
  const s = storeFor(livemode);
  const nowSec = Math.floor(now.getTime() / 1000);
  const stale = sweepRunning && nowSec - (lastScanAt ?? bootAt) > SCAN_STALE_S;
  const fullOverdue = sweepRunning && nowSec - (s?.lastFullAt ?? bootAt) > FULL_STALE_S;
  let uncovered = 0;
  if (s) {
    const missing = new Set<string>();
    for (const e of listAllEntries()) {
      // A row naming our fee is a sale the fee list must hold; void rows were refunded.
      if (!e.applicationFeeId || e.status === "void" || s.accounts[e.stripeAccountId]) continue;
      const at = Date.parse(e.recordedAt);
      if (Number.isFinite(at) && nowSec - at / 1000 > UNCOVERED_AFTER_S) missing.add(e.stripeAccountId);
    }
    uncovered = missing.size;
  }
  const iso = (sec: number | null | undefined) => (sec == null ? null : new Date(sec * 1000).toISOString());
  return {
    ok: !stale && !fullOverdue && uncovered === 0,
    lastScanAt: iso(lastScanAt),
    lastFullAt: iso(s?.lastFullAt),
    lastError,
    stale,
    fullOverdue,
    uncovered,
  };
}

export function feeStartFrom(fee: Stripe.ApplicationFee): FeeStart {
  return {
    feeId: fee.id,
    account: typeof fee.account === "string" ? fee.account : fee.account.id,
    created: fee.created,
    amount: fee.amount,
    amountRefunded: fee.amount_refunded,
    livemode: fee.livemode,
  };
}

/** Platform key, no Stripe-Account header: Stripe returns only the fees this platform collected. */
export const liveFirstSaleReads: FirstSaleReads = {
  async *listFees(gte) {
    const params = { limit: 100, ...(gte === null ? {} : { created: { gte } }) };
    for await (const fee of getStripe().applicationFees.list(params)) yield feeStartFrom(fee);
  },
};

/** Test seam: forget memory so a fresh file is read. */
export function __resetForTests(): void {
  store = null;
  loaded = false;
  lastScanAt = null;
  lastError = null;
}
