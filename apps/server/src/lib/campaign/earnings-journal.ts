/**
 * The referral payout journal (#12): what WoCo has PAID referrers, and which
 * earnings it is holding back. Append-only; nothing is ever rewritten.
 *
 * Earnings themselves are not stored - they are derived on every read from the
 * payout ledger, Stripe and the referral confirmations (earnings.ts). A payout
 * entry freezes the lines it paid, so the record of what a referrer was paid for
 * survives any later change at Stripe; a later reversal shows up as a negative
 * balance on the next statement, never as an edit here.
 *
 * MUST SURVIVE RESTARTS. Losing it forgets every referral payout made, so the
 * next statement would offer to pay them all again. A file that EXISTS but
 * cannot be read is never overwritten: every write is refused, statements say
 * so, and /api/health `referralEarnings` alarms until it is restored.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../marketing/persist.js";

const DATA_DIR = join(process.cwd(), ".data");
const JOURNAL_FILE = join(DATA_DIR, "referral-payout-journal.json");

/** One sale's earning as it stood when a payout covered it. */
export interface PaidLine {
  sessionId: string;
  feeId: string;
  /** Fee kept x share bp: minor units x 10 000. */
  numerator: number;
  feeKept: number;
  bp: number;
}

export interface PayoutRecord {
  kind: "payout";
  id: string;
  /** The referrer paid, lowercase - the account address the confirmation names. */
  referrer: string;
  /** Currency of the sales the earnings came from (lowercase ISO). */
  currency: string;
  /** What was owed and settled, minor units of `currency`. */
  amountMinor: number;
  /** Where it went: always the referrer's own account address. */
  toAddress: string;
  network: string;
  /** The stablecoin sent, and how much of it (decimal string, as sent). */
  asset: string;
  sentAmount: string;
  /** Units of `asset` per 1 major unit of `currency`, when they differ. */
  fxRate?: string;
  txHash: string;
  paidAt: string;
  recordedAt: string;
  by: string;
  note?: string;
  /**
   * EVERY payable line at the time, earlier payouts' included: `amountMinor` is
   * their sum less everything paid before, rounded down. A full snapshot, so
   * each payout can be checked on its own.
   */
  lines: PaidLine[];
}

export type WithholdScope = "referrer" | "referee" | "sale";

export interface WithholdRecord {
  kind: "withhold";
  id: string;
  scope: WithholdScope;
  /** A referrer or referee address (lowercase), or a Checkout Session id. */
  key: string;
  reason: string;
  by: string;
  at: string;
}

export interface LiftRecord {
  kind: "lift";
  id: string;
  withholdId: string;
  reason: string;
  by: string;
  at: string;
}

export type JournalEntry = PayoutRecord | WithholdRecord | LiftRecord;

let entries: JournalEntry[] = [];
let loaded = false;
let fileUnreadable: string | null = null;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  let raw: string;
  try {
    raw = readFileSync(JOURNAL_FILE, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    fileUnreadable = err instanceof Error ? err.message : String(err);
    console.error(`[referral-journal] ${JOURNAL_FILE} exists but cannot be read - referral payouts are OFF until restored:`, err);
    return;
  }
  try {
    const parsed = JSON.parse(raw) as { entries?: unknown };
    if (!parsed || !Array.isArray(parsed.entries)) throw new Error("no entries array");
    entries = parsed.entries as JournalEntry[];
    console.log(`[referral-journal] Loaded ${entries.length} entries`);
  } catch (err) {
    entries = [];
    fileUnreadable = err instanceof Error ? err.message : String(err);
    console.error(
      `[referral-journal] ${JOURNAL_FILE} is not readable JSON - it will NOT be overwritten; referral payouts are OFF until restored:`,
      err,
    );
  }
}

export function journalEntries(): readonly JournalEntry[] {
  ensureLoaded();
  return entries;
}

/** False while the file exists but could not be read: a statement would forget payouts. */
export function journalReadable(): boolean {
  ensureLoaded();
  return fileUnreadable === null;
}

/**
 * Append one entry. Committed in memory only once it is on disk, so a refused
 * or failed write leaves nothing behind for a retry to trip over.
 */
export function appendJournal(entry: JournalEntry): boolean {
  ensureLoaded();
  if (fileUnreadable) return false;
  const next = [...entries, entry];
  if (!writeJsonAtomic(JOURNAL_FILE, { entries: next }, "referral-journal", { pretty: true })) return false;
  entries = next;
  return true;
}

/** Withholds not lifted. */
export function activeWithholds(list: readonly JournalEntry[] = journalEntries()): WithholdRecord[] {
  const lifted = new Set(list.filter((e): e is LiftRecord => e.kind === "lift").map((e) => e.withholdId));
  return list.filter((e): e is WithholdRecord => e.kind === "withhold" && !lifted.has(e.id));
}

export interface ReferralJournalHealth {
  ok: boolean;
  payouts: number;
  activeWithholds: number;
  fileUnreadable: boolean;
}

export function referralJournalHealth(): ReferralJournalHealth {
  ensureLoaded();
  return {
    ok: fileUnreadable === null,
    payouts: entries.filter((e) => e.kind === "payout").length,
    activeWithholds: activeWithholds(entries).length,
    fileUnreadable: fileUnreadable !== null,
  };
}

export function __resetJournalForTests(): void {
  entries = [];
  loaded = false;
  fileUnreadable = null;
}
