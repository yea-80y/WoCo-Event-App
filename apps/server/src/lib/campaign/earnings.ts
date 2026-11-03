/**
 * Referral earnings (#12, ToS §9): what each referrer is owed, derived on every
 * read and never stored. Inputs: the payout ledger (which sales, which event,
 * whether the organiser was paid), Stripe (the fee WoCo kept on each sale, its
 * refunds and disputes, the organiser payout's status), the referral
 * confirmation of each organiser, and the payout journal (earnings-journal.ts).
 *
 * The rules, from §9 (docs/REFERRAL_EARNINGS.md is the authority):
 *  - a sale earns only if its organiser's referral was confirmed before it was
 *    made, at the share in force on the sale date (`referralShareBp`);
 *  - the base is the platform fee WoCo kept: the ApplicationFee's `amount` less
 *    `amount_refunded`, in the fee's currency - NEVER the charge amount;
 *  - it is payable once the event is over AND the organiser's payout reads
 *    `paid` at Stripe; until then it is pending;
 *  - a sale refunded in full, or a chargeback lost, earns nothing (owner
 *    2026-11-03), even though WoCo keeps its fee on both; an open dispute is
 *    pending, never zero;
 *  - earnings are kept exact (minor units x 10 000) and rounded down once, at
 *    payout; the remainder stays owed. A reversal after a payout leaves the
 *    balance negative, carried against later earnings, never clawed back.
 *
 * Anything that cannot be read is pending and flagged, never a guess.
 */

import { referralShareBp, type ReferralConfirmationV1 } from "@woco/shared";
import type { PayoutLedgerEntry } from "../stripe/payout-ledger.js";
import { FALLBACK_RELEASE_DAYS } from "../stripe/payout-policy.js";
import { CHARGEBACK_STATUSES, OPEN_DISPUTE_STATUSES } from "../stripe/dispute-status.js";
import type { RecordRead } from "./issuer.js";
import { activeWithholds, type JournalEntry, type PayoutRecord } from "./earnings-journal.js";

/** Minor units x this = a numerator. */
export const NUMERATOR_SCALE = 10_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The Stripe facts one sale's earning is computed from. */
export interface SaleFacts {
  feeId: string;
  /** ApplicationFee.amount and .amount_refunded, minor units of `currency`. */
  feeAmount: number;
  feeRefunded: number;
  currency: string;
  /** The connected account the fee was collected on. */
  account: string;
  chargeAmount: number;
  chargeRefunded: number;
  /** Status of every dispute on the charge; empty when it has none. */
  disputes: string[];
}

export type SaleRead = { status: "found"; facts: SaleFacts } | { status: "unavailable"; reason: string };

/** Stripe Payout.status, or `unavailable` when it could not be read. */
export type PayoutStatus = "paid" | "pending" | "in_transit" | "failed" | "canceled" | "unavailable";

export interface EarningsReads {
  entries(): PayoutLedgerEntry[];
  journal(): readonly JournalEntry[];
  /** False while the journal file exists but cannot be read. */
  journalReadable(): boolean;
  confirmation(organiser: string): Promise<RecordRead<ReferralConfirmationV1>>;
  sale(entry: PayoutLedgerEntry): Promise<SaleRead>;
  payoutStatus(payoutId: string, account: string): Promise<PayoutStatus>;
  shareBp?(referrer: string, saleAt: string): number;
}

export type LineState = "payable" | "pending" | "withheld" | "zero";

export interface EarningLine {
  sessionId: string;
  referrer: string;
  referee: string;
  eventId?: string;
  saleAt: string;
  currency: string;
  state: LineState;
  reason: string;
  bp: number;
  feeId?: string;
  feeKept?: number;
  /** feeKept x bp; 0 when the fee is not known or the sale earns nothing. */
  numerator: number;
}

export interface ReferrerStatement {
  referrer: string;
  currency: string;
  /** Sums of line numerators, by state. */
  payableNumerator: number;
  pendingNumerator: number;
  withheldNumerator: number;
  paidMinor: number;
  /** payable - paid, in numerator units. Negative = a reversal carried forward. */
  owedNumerator: number;
  /** What a payout made now settles: owed rounded down, never below 0. */
  dueMinor: number;
  lines: EarningLine[];
}

export interface EarningsStatement {
  asOf: string;
  /** False when the journal is unreadable: `dueMinor` would ignore past payouts. */
  journalReadable: boolean;
  referrers: ReferrerStatement[];
  diagnostics: {
    /** Referees whose confirmation could not be read: their sales are unattributed this run. */
    confirmationsUnavailable: string[];
    /** Event sales with no organiser address on the ledger entry. */
    unattributedSales: string[];
    /** Organiser payouts Stripe reports failed or cancelled. */
    failedPayouts: string[];
    /** Sales whose Stripe facts could not be read. */
    unreadableSales: string[];
  };
}

/** True when `releaseAfter` is the no-event-date fallback, not "event end + grace". */
function isFallbackRelease(entry: PayoutLedgerEntry): boolean {
  return Date.parse(entry.releaseAfter) - Date.parse(entry.recordedAt) === FALLBACK_RELEASE_DAYS * DAY_MS;
}

function withheldBy(
  withholds: ReturnType<typeof activeWithholds>,
  referrer: string,
  referee: string,
  sessionId: string,
): string | null {
  for (const w of withholds) {
    if (
      (w.scope === "referrer" && w.key === referrer) ||
      (w.scope === "referee" && w.key === referee) ||
      (w.scope === "sale" && w.key === sessionId)
    ) {
      return w.id;
    }
  }
  return null;
}

/** Deterministic accrual order: payment time, then session id. */
function byAccrual(a: PayoutLedgerEntry, b: PayoutLedgerEntry): number {
  return a.recordedAt.localeCompare(b.recordedAt) || a.sessionId.localeCompare(b.sessionId);
}

export async function computeReferralEarnings(reads: EarningsReads, now: Date = new Date()): Promise<EarningsStatement> {
  const nowMs = now.getTime();
  const journal = reads.journal();
  const withholds = activeWithholds(journal);
  const shareBp = reads.shareBp ?? ((_referrer: string, saleAt: string) => referralShareBp(saleAt));
  const diagnostics: EarningsStatement["diagnostics"] = {
    confirmationsUnavailable: [],
    unattributedSales: [],
    failedPayouts: [],
    unreadableSales: [],
  };

  const confirmations = new Map<string, RecordRead<ReferralConfirmationV1>>();
  const payoutStatuses = new Map<string, PayoutStatus>();
  const lines: EarningLine[] = [];

  // Only ticket sales earn (§9): shop orders and reconciliation rows never do.
  const sales = reads.entries().filter((e) => e.kind === "event").sort(byAccrual);
  for (const entry of sales) {
    const referee = entry.organiserAddress;
    if (!referee) {
      diagnostics.unattributedSales.push(entry.sessionId);
      continue;
    }
    let conf = confirmations.get(referee);
    if (!conf) {
      conf = await reads.confirmation(referee);
      confirmations.set(referee, conf);
      if (conf.status === "unavailable") diagnostics.confirmationsUnavailable.push(referee);
    }
    if (conf.status !== "found") continue;
    const { referrer, confirmedAt } = conf.record;
    // Earnings accrue from the first sale AFTER the referral was confirmed.
    if (Date.parse(entry.recordedAt) < Date.parse(confirmedAt)) continue;
    const bp = shareBp(referrer, entry.recordedAt);
    if (bp <= 0) continue;

    const line: EarningLine = {
      sessionId: entry.sessionId,
      referrer,
      referee,
      ...(entry.eventId ? { eventId: entry.eventId } : {}),
      saleAt: entry.recordedAt,
      currency: entry.currency,
      state: "pending",
      reason: "",
      bp,
      numerator: 0,
    };
    lines.push(line);

    if (entry.status === "void") {
      line.state = "zero";
      line.reason = `sale void: ${entry.voidReason ?? "no reason recorded"}`;
      continue;
    }

    const sale = await reads.sale(entry);
    if (sale.status === "unavailable") {
      line.reason = `Stripe facts unreadable: ${sale.reason}`;
      diagnostics.unreadableSales.push(entry.sessionId);
      continue;
    }
    const f = sale.facts;
    line.feeId = f.feeId;
    line.currency = f.currency;
    if (f.account !== entry.stripeAccountId) {
      line.reason = "fee collected on a different account from the ledger entry";
      diagnostics.unreadableSales.push(entry.sessionId);
      continue;
    }
    if (f.chargeAmount > 0 && f.chargeRefunded >= f.chargeAmount) {
      line.state = "zero";
      line.reason = "refunded in full";
      continue;
    }
    // The one chargeback status that is not open (dispute-status.ts).
    if (f.disputes.some((s) => CHARGEBACK_STATUSES.has(s) && !OPEN_DISPUTE_STATUSES.has(s))) {
      line.state = "zero";
      line.reason = "chargeback lost";
      continue;
    }
    const feeKept = f.feeAmount - f.feeRefunded;
    if (feeKept <= 0) {
      line.state = "zero";
      line.reason = "platform fee returned";
      continue;
    }
    line.feeKept = feeKept;
    line.numerator = feeKept * bp;

    if (f.disputes.some((s) => OPEN_DISPUTE_STATUSES.has(s))) {
      line.reason = "dispute open";
      continue;
    }
    if (entry.status !== "released") {
      line.reason = "organiser not paid yet";
      continue;
    }
    if (typeof entry.netAmount !== "number") {
      line.reason = "organiser payout amount not resolved";
      continue;
    }
    if (entry.netAmount <= 0) {
      line.state = "zero";
      line.numerator = 0;
      line.reason = "released as a debt, not a sale";
      continue;
    }
    if (isFallbackRelease(entry)) {
      line.reason = "event date unknown - check the event has taken place";
      continue;
    }
    // A sale Stripe's hold ceiling forced out before the event waits for the event.
    if (Date.parse(entry.releaseAfter) > nowMs) {
      line.reason = "event not over";
      continue;
    }
    if (!entry.payoutId) {
      line.reason = "released with no payout id";
      continue;
    }
    let ps = payoutStatuses.get(entry.payoutId);
    if (!ps) {
      ps = await reads.payoutStatus(entry.payoutId, entry.stripeAccountId);
      payoutStatuses.set(entry.payoutId, ps);
      if (ps === "failed" || ps === "canceled") diagnostics.failedPayouts.push(entry.payoutId);
    }
    if (ps !== "paid") {
      line.reason = `organiser payout ${ps}`;
      continue;
    }
    const withhold = withheldBy(withholds, referrer, referee, entry.sessionId);
    if (withhold) {
      line.state = "withheld";
      line.reason = `withheld (${withhold})`;
      continue;
    }
    line.state = "payable";
    line.reason = "payable";
  }

  return { asOf: now.toISOString(), journalReadable: reads.journalReadable(), referrers: summarise(lines, journal), diagnostics };
}

export interface PayoutInput {
  referrer: string;
  currency: string;
  /** Must equal the statement's `dueMinor` for this referrer and currency, recomputed now. */
  amountMinor: number;
  network: string;
  asset: string;
  sentAmount: string;
  fxRate?: string;
  txHash: string;
  paidAt?: string;
  by: string;
  note?: string;
}

export type PayoutResult =
  | { ok: true; record: PayoutRecord }
  | { ok: false; status: 409 | 503; error: string };

let payoutQueue: Promise<unknown> = Promise.resolve();

/**
 * Record a payout the operator has ALREADY sent. The amount is checked against
 * a statement recomputed now, and the lines it settles are frozen into the
 * record by the server, never taken from the request. One at a time, so two
 * requests cannot both settle the same balance.
 */
export function recordReferralPayout(
  input: PayoutInput,
  deps: { reads: EarningsReads; append(entry: JournalEntry): boolean; newId(): string; now?: () => Date },
): Promise<PayoutResult> {
  const run = payoutQueue.then(() => recordOne(input, deps));
  payoutQueue = run.catch(() => undefined);
  return run;
}

async function recordOne(
  input: PayoutInput,
  deps: { reads: EarningsReads; append(entry: JournalEntry): boolean; newId(): string; now?: () => Date },
): Promise<PayoutResult> {
  if (!deps.reads.journalReadable()) {
    return { ok: false, status: 503, error: "The payout journal cannot be read - restore it before recording a payout" };
  }
  const txHash = input.txHash.toLowerCase();
  if (deps.reads.journal().some((e) => e.kind === "payout" && e.txHash.toLowerCase() === txHash)) {
    return { ok: false, status: 409, error: "A payout with that transaction is already recorded" };
  }
  const now = deps.now?.() ?? new Date();
  const statement = await computeReferralEarnings(deps.reads, now);
  const s = statement.referrers.find((r) => r.referrer === input.referrer && r.currency === input.currency);
  const due = s?.dueMinor ?? 0;
  if (!s || due <= 0) return { ok: false, status: 409, error: "Nothing is due to that referrer in that currency" };
  if (input.amountMinor !== due) {
    return { ok: false, status: 409, error: `Amount differs from what is due now (${due})` };
  }
  const record: PayoutRecord = {
    kind: "payout",
    id: deps.newId(),
    referrer: input.referrer,
    currency: input.currency,
    amountMinor: due,
    toAddress: input.referrer,
    network: input.network,
    asset: input.asset,
    sentAmount: input.sentAmount,
    ...(input.fxRate ? { fxRate: input.fxRate } : {}),
    txHash,
    paidAt: input.paidAt ?? now.toISOString(),
    recordedAt: now.toISOString(),
    by: input.by,
    ...(input.note ? { note: input.note } : {}),
    lines: s.lines
      .filter((l) => l.state === "payable")
      .map((l) => ({ sessionId: l.sessionId, feeId: l.feeId ?? "", numerator: l.numerator, feeKept: l.feeKept ?? 0, bp: l.bp })),
  };
  if (!deps.append(record)) return { ok: false, status: 503, error: "The payout could not be written - nothing was recorded" };
  return { ok: true, record };
}

function summarise(lines: EarningLine[], journal: readonly JournalEntry[]): ReferrerStatement[] {
  const out = new Map<string, ReferrerStatement>();
  const get = (referrer: string, currency: string): ReferrerStatement => {
    const k = `${referrer}:${currency}`;
    let s = out.get(k);
    if (!s) {
      s = {
        referrer,
        currency,
        payableNumerator: 0,
        pendingNumerator: 0,
        withheldNumerator: 0,
        paidMinor: 0,
        owedNumerator: 0,
        dueMinor: 0,
        lines: [],
      };
      out.set(k, s);
    }
    return s;
  };
  for (const l of lines) {
    const s = get(l.referrer, l.currency);
    s.lines.push(l);
    if (l.state === "payable") s.payableNumerator += l.numerator;
    else if (l.state === "pending") s.pendingNumerator += l.numerator;
    else if (l.state === "withheld") s.withheldNumerator += l.numerator;
  }
  for (const p of journal.filter((e): e is PayoutRecord => e.kind === "payout")) {
    get(p.referrer, p.currency).paidMinor += p.amountMinor;
  }
  for (const s of out.values()) {
    s.owedNumerator = s.payableNumerator - s.paidMinor * NUMERATOR_SCALE;
    s.dueMinor = s.owedNumerator > 0 ? Math.floor(s.owedNumerator / NUMERATOR_SCALE) : 0;
  }
  return [...out.values()].sort((a, b) => a.referrer.localeCompare(b.referrer) || a.currency.localeCompare(b.currency));
}
