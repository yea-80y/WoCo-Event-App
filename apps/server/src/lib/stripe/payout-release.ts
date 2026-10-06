/**
 * Post-event payout release.
 *
 * Connected accounts sit on `interval: "manual"`, so nothing leaves an organiser's
 * balance until this job releases it: after the event has happened, or at Stripe's
 * documented country hold ceiling, whichever comes first.
 *
 * The hard part is that a connected account has ONE pooled balance across every
 * event it has ever sold. "Pay out the available balance" would hand a festival's
 * advance takings to an organiser the week their unrelated gig finished. So the
 * amount released is always the sum of the ledger entries that are actually DUE —
 * never the raw balance.
 *
 * A refunded or charged-back sale can be worth LESS than nothing: Stripe keeps
 * its processing fee and the chargeback fee, and those come out of the same
 * pooled balance. Such a sale is a debt, netted into the account's next payout,
 * so the balance left behind always covers every sale still held (#781).
 *
 * The ledger cannot see everything that moves the balance: a chargeback after a
 * sale was paid out, a debt Stripe recovers by debiting the organiser's bank, a
 * dispute won after payout. So every sweep measures the balance (available +
 * pending) against the held ledger. A shortfall is netted from the next payout;
 * a surplus is the organiser's and is paid once it has lasted a week. Each lands
 * as a `reconciliation` row with its payout, so a payout's rows add up to it,
 * and nothing that moved outside a sale is deducted twice or kept (#781 part 2).
 *
 * Ordering invariant that keeps this safe under crashes: we choose the set of
 * entries FIRST, journal a payout INTENT (set + amount + idempotency key), pay
 * out exactly the journalled sum, and only then mark the set released — in one
 * write. A crash anywhere in that sequence leaves the intent on disk, and the
 * next sweep settles it before any new selection: confirm it against Stripe
 * (the payout happened — mark the original set), replay it verbatim while the
 * idempotency key is still live, or abandon it once the payout is provably
 * absent and the key has expired. The set is never rebuilt from "what is due
 * now", because that set can have grown — which is how a drifted key double-pays.
 */

import type Stripe from "stripe";
import { createHash } from "node:crypto";
import { getStripe } from "./client.js";
import { BALANCE_SHORT_ALARM_DAYS, SURPLUS_ALARM_DAYS, SURPLUS_SETTLE_DAYS, holdCeilingAt } from "./payout-policy.js";
import { pendingScheduleHeals, retryPendingScheduleHeals } from "./payout-schedule.js";
import {
  flagForRecheck,
  getEntry,
  listAccountGroups,
  listHeld,
  markManyReleased,
  markVoid,
  organiserForAccount,
  setNetAmount,
  type PayoutLedgerEntry,
  type ReconRow,
} from "./payout-ledger.js";
import { clearSurplus, listSurplusClocks, observeSurplus } from "./payout-surplus.js";
import { OPEN_DISPUTE_STATUSES } from "./dispute-status.js";
import { cancellationGate, getCancellation, isSaleRefundSettled } from "../event/cancellations.js";
import {
  clearIntent,
  getIntent,
  listIntents,
  saveIntent,
  type PayoutIntent,
} from "./payout-intents.js";

/** How often the job sweeps. Payout timing is measured in days — hourly is ample. */
const RELEASE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * How long a pending intent may be replayed with its original idempotency key.
 * Stripe expires keys after 24h; past this margin a replay would be a fresh
 * request, so the intent is abandoned instead and its entries re-enter normal
 * selection with freshly resolved nets.
 */
const REPLAY_WINDOW_MS = 20 * 60 * 60 * 1000;

/**
 * Everything the release engine needs from Stripe, behind an interface so the
 * decision logic can be tested without network access.
 */
export interface PayoutGateway {
  /**
   * What actually landed in the connected account for this sale: minor units of
   * gross − Stripe processing − our application fee − refunds, plus the currency
   * it SETTLED in (Stripe converts a charge with no matching bank account into
   * the account's default currency, so this can differ from the entry's
   * presentment currency). Read fresh from the balance transaction on EVERY
   * call — a refund can land at any moment before release, so a cached value is
   * never trusted. `null` means "couldn't determine" — the caller leaves the
   * entry held rather than guessing. `net` is always what has POSTED to the
   * balance; `unsettled` says it may still move — a dispute is open, or a refund
   * has not moved money yet (#701) — so a positive net is not paid until it is
   * settled, while a negative one is netted at once (#781 part 2).
   */
  resolveNet(entry: PayoutLedgerEntry): Promise<ResolvedNet | null>;
  /**
   * The account's balance in one currency, minor units: `available` can be paid
   * out now, `pending` is still settling. `null` = could not read it, including
   * a currency the balance has no row for — never "zero" (#781 part 2: a missing
   * row read as zero would look like the whole ledger's money had gone).
   */
  balance(stripeAccountId: string, currency: string): Promise<{ available: number; pending: number } | null>;
  createPayout(args: {
    stripeAccountId: string;
    amount: number;
    currency: string;
    idempotencyKey: string;
    description: string;
    metadata: Record<string, string>;
  }): Promise<string>;
  /**
   * Whether a payout journalled under `intentKey` actually reached Stripe.
   * `{ payoutId }` = found; `{ payoutId: null }` = definitively absent;
   * `null` = could not determine (lookup failed) — the caller must freeze the
   * group rather than risk paying the set twice.
   */
  findPayoutByIntent(
    stripeAccountId: string,
    intentKey: string,
    sinceIso: string,
  ): Promise<{ payoutId: string | null } | null>;
  /** ISO-3166 alpha-2 of the business, which picks the hold ceiling. */
  accountCountry(stripeAccountId: string): Promise<string | undefined>;
  /**
   * True while THIS sale must not be paid out: its event was cancelled and the
   * sale's refund is not settled (#644), or the cancellation record cannot be
   * read. Per sale, not per event: a sale the refund job has not reached yet has
   * no row, and a missing row must hold. Zero I/O. Optional so a gateway that
   * knows nothing of cancellations holds nothing.
   */
  cancellationHold?(eventId: string, sessionId: string): boolean;
  /**
   * True when the event is cancelled, or the cancellation record cannot be read
   * (#644). Per EVENT, unlike `cancellationHold`, which lifts once a sale's
   * refund settles: a payout journalled before the cancellation is stale for the
   * event whatever its refunds have done since. Zero I/O.
   */
  eventCancelled?(eventId: string): boolean;
  /**
   * True when the event was cancelled AFTER `sinceIso`, or the record cannot be
   * read. Asked of a journalled payout: only a cancellation that landed after
   * the set was chosen makes its sum stale. Falls back to `eventCancelled`.
   */
  cancelledAfter?(eventId: string, sinceIso: string): boolean;
}

export type ResolvedNet = { net: number; currency: string; unsettled?: "dispute" | "refund" };

export interface ReleaseOutcome {
  stripeAccountId: string;
  currency: string;
  /** Entries released in this run, debts netted into the payout included. */
  released: string[];
  /** Entries due but left held because the balance hadn't settled yet. */
  deferred: string[];
  voided: string[];
  /** Released entries whose net was negative: deducted from this payout (#781). */
  debts: string[];
  amount: number;
  payoutId?: string;
  /** True when at least one released entry was forced out by the hold ceiling. */
  forcedByCeiling: boolean;
  /**
   * When the oldest sale that is due but did not fit the balance became due.
   * Pending funds clear within days, so a sale still not fitting long after it
   * fell due means the balance is short of what the ledger says it holds (#781).
   */
  shortSince?: string;
  /** What is owed outweighs everything due: nothing can be paid. */
  owes?: boolean;
  /**
   * The balance against the held ledger (#781 part 2): below zero, money left
   * outside any sale; above zero, money arrived outside any sale.
   */
  rho?: number;
  /** The part of this payout no sale accounts for (its reconciliation row). */
  recon?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Live gateway
// ---------------------------------------------------------------------------

const countryCache = new Map<string, string | undefined>();

/**
 * Resolve what a sale is worth RIGHT NOW, straight from Stripe. Deliberately
 * ignores `entry.netAmount`: that cache once fed the sweep, which meant a refund
 * landing after first resolution was invisible and a refunded sale could still
 * be paid out at its pre-refund value. Exported (with the client injected) so a
 * test can pin exactly that.
 */
export async function resolveNetFromStripe(
  s: Stripe,
  entry: PayoutLedgerEntry,
): Promise<ResolvedNet | null> {
  if (!entry.paymentIntentId) return null;
  const opts = { stripeAccount: entry.stripeAccountId };
  const pi = await s.paymentIntents.retrieve(
    entry.paymentIntentId,
    { expand: ["latest_charge"] },
    opts,
  );
  const charge = pi.latest_charge as Stripe.Charge | null;
  if (!charge) return null;

  const btId =
    typeof charge.balance_transaction === "string"
      ? charge.balance_transaction
      : charge.balance_transaction?.id;
  if (!btId) return null;

  const bt = await s.balanceTransactions.retrieve(btId, {}, opts);
  // bt.net is gross minus BOTH fee_details entries — stripe_fee and
  // application_fee — i.e. exactly what landed in the organiser's balance.
  // bt.currency is the SETTLEMENT currency, which is what the payout must use.
  let net = bt.net;

  // Refunds each get their own (negative) balance transaction. Summing the
  // real transactions rather than subtracting refund.amount matters because
  // whether a refund returns the processing fee varies by region, and whether
  // it returns our application fee depends on refund_application_fee.
  //
  // Listed on every call, every page (#701). A refund still waiting to move
  // money — `pending` with `pending_reason: insufficient_funds`, or
  // `requires_action` — has no balance transaction yet, and whether it counts
  // in `charge.amount_refunded` is not documented. It marks the sale unsettled,
  // so a positive net is never paid out from under it (anything without a
  // balance transaction that is not failed or cancelled, including a status we
  // do not know).
  //
  // A refund that FAILED after its debit posted keeps that debit as
  // `balance_transaction` and gets the reversal as `failure_balance_transaction`
  // (stripe-node Refund). Both are netted; a failure whose reversal has not
  // posted yet is unsettled, like a won dispute awaiting its reinstatement.
  //
  // `net` is always what has POSTED (#781 part 2): the sweep compares the sum of
  // held nets with the real balance, so a net that leaves out money already
  // moved would read as an unexplained shortfall.
  let unsettled: "dispute" | "refund" | undefined;
  const btIdOf = (b: string | Stripe.BalanceTransaction | null | undefined): string | undefined =>
    typeof b === "string" ? b : b?.id;
  for await (const r of s.refunds.list({ charge: charge.id, limit: 100 }, opts)) {
    const gone = r.status === "failed" || r.status === "canceled";
    const rBtId = btIdOf(r.balance_transaction);
    if (!rBtId) {
      if (!gone) unsettled = "refund";
      continue;
    }
    const rBt = await s.balanceTransactions.retrieve(rBtId, {}, opts);
    net += rBt.net; // negative
    if (gone) {
      const fBtId = btIdOf(r.failure_balance_transaction);
      if (!fBtId) {
        unsettled = "refund";
        continue;
      }
      const fBt = await s.balanceTransactions.retrieve(fBtId, {}, opts);
      net += fBt.net; // positive
    }
  }

  // Disputes (#645 part C). Each carries zero, one or two balance transactions:
  // the withdrawal (amount + dispute fee, negative) when it became a
  // chargeback, and the reinstatement (positive) if it was won. Whatever has
  // posted is netted. While one is still open — or won with the reinstatement
  // not posted yet — the sale is unsettled: its posted withdrawal is a debt the
  // next payout carries, but a positive net is not paid out while the buyer's
  // bank may yet take more back.
  if (charge.disputed) {
    for await (const d of s.disputes.list({ charge: charge.id, limit: 100 }, opts)) {
      // Open: `warning_*` too — an inquiry moves no money but can escalate.
      if (OPEN_DISPUTE_STATUSES.has(d.status)) unsettled = "dispute";
      if (d.status === "won" && d.balance_transactions.some((b) => b.net < 0)
          && !d.balance_transactions.some((b) => b.net > 0)) {
        unsettled = "dispute";
      }
      for (const dBt of d.balance_transactions) {
        // Every transaction on this account's balance settles in its own
        // currency; one that does not cannot be summed, so decide nothing.
        if (dBt.currency.toLowerCase() !== bt.currency.toLowerCase()) return null;
        net += dBt.net;
      }
    }
  }
  return { net, currency: bt.currency.toLowerCase(), ...(unsettled ? { unsettled } : {}) };
}

/**
 * One currency of a connected account's balance. A currency with no row in
 * either list is `null` — unreadable — never zero: a group with sales held in
 * it would otherwise read as every penny gone (#781 part 2). Exported, with the
 * client injected, so a test can pin exactly that.
 */
export async function balanceFromStripe(
  s: Stripe,
  stripeAccountId: string,
  currency: string,
): Promise<{ available: number; pending: number } | null> {
  const balance = await s.balance.retrieve({}, { stripeAccount: stripeAccountId });
  const cur = currency.toLowerCase();
  const available = balance.available.find((a) => a.currency === cur);
  const pending = balance.pending.find((a) => a.currency === cur);
  if (!available && !pending) return null;
  return { available: available?.amount ?? 0, pending: pending?.amount ?? 0 };
}

export const liveGateway: PayoutGateway = {
  async resolveNet(entry) {
    try {
      return await resolveNetFromStripe(getStripe(), entry);
    } catch (err) {
      console.error(`[payout-release] Could not resolve net for ${entry.sessionId}:`, err);
      return null;
    }
  },

  async balance(stripeAccountId, currency) {
    try {
      return await balanceFromStripe(getStripe(), stripeAccountId, currency);
    } catch (err) {
      console.error(`[payout-release] Could not read balance for ${stripeAccountId}:`, err);
      return null;
    }
  },

  async createPayout({ stripeAccountId, amount, currency, idempotencyKey, description, metadata }) {
    const s = getStripe();
    const payout = await s.payouts.create(
      { amount, currency, description, metadata },
      { stripeAccount: stripeAccountId, idempotencyKey },
    );
    return payout.id;
  },

  async findPayoutByIntent(stripeAccountId, intentKey, sinceIso) {
    try {
      const s = getStripe();
      // One-hour margin behind the intent's own timestamp guards against clock
      // skew between us and Stripe. Payouts on a manual schedule are rare, so a
      // single page comfortably covers the window.
      const since = Math.floor(new Date(sinceIso).getTime() / 1000) - 3600;
      const payouts = await s.payouts.list(
        { created: { gte: since }, limit: 100 },
        { stripeAccount: stripeAccountId },
      );
      const found = payouts.data.find((p) => p.metadata?.woco_intent === intentKey);
      return { payoutId: found?.id ?? null };
    } catch (err) {
      console.error(`[payout-release] Could not search payouts for ${stripeAccountId}:`, err);
      return null;
    }
  },

  cancellationHold(eventId, sessionId) {
    const gate = cancellationGate(eventId);
    return gate === "unknown" || (gate === "cancelled" && !isSaleRefundSettled(eventId, sessionId));
  },

  eventCancelled(eventId) {
    return cancellationGate(eventId) !== "open";
  },

  cancelledAfter(eventId, sinceIso) {
    const gate = cancellationGate(eventId);
    if (gate === "open") return false;
    if (gate === "unknown") return true;
    return (getCancellation(eventId)?.cancelledAt ?? "") > sinceIso;
  },

  async accountCountry(stripeAccountId) {
    if (countryCache.has(stripeAccountId)) return countryCache.get(stripeAccountId);
    try {
      const s = getStripe();
      const account = await s.accounts.retrieve(stripeAccountId);
      const country = account.country ?? undefined;
      countryCache.set(stripeAccountId, country);
      return country;
    } catch (err) {
      console.error(`[payout-release] Could not read country for ${stripeAccountId}:`, err);
      return undefined;
    }
  },
};

// ---------------------------------------------------------------------------
// Decision logic
// ---------------------------------------------------------------------------

/** Stable ordering so a re-run after a crash selects the identical set. */
function byAge(a: PayoutLedgerEntry, b: PayoutLedgerEntry): number {
  return a.recordedAt.localeCompare(b.recordedAt) || a.sessionId.localeCompare(b.sessionId);
}

function idempotencyKeyFor(sessionIds: string[]): string {
  const digest = createHash("sha256").update(sessionIds.slice().sort().join("|")).digest("hex");
  return `woco-payout-${digest.slice(0, 40)}`;
}

function payoutArgsFor(intent: PayoutIntent): Parameters<PayoutGateway["createPayout"]>[0] {
  const forced = intent.forcedSessionIds.length > 0;
  return {
    stripeAccountId: intent.stripeAccountId,
    amount: intent.amount,
    currency: intent.currency,
    idempotencyKey: intent.idempotencyKey,
    description: forced
      ? "WoCo release (Stripe hold limit reached)"
      : "WoCo post-event release",
    metadata: {
      // The recovery handle: findPayoutByIntent matches on this after a crash.
      woco_intent: intent.idempotencyKey,
      woco_sales: String(intent.sessionIds.length),
      woco_first_session: intent.sessionIds[0]!.slice(0, 60),
      ...(forced ? { woco_forced_by_hold_ceiling: "true" } : {}),
    },
  };
}

function reconRowFor(intent: PayoutIntent): ReconRow | undefined {
  if (!intent.recon) return undefined;
  return {
    id: intent.recon.id,
    stripeAccountId: intent.stripeAccountId,
    organiserAddress: intent.recon.organiserAddress,
    currency: intent.currency,
    amount: intent.recon.amount,
  };
}

/**
 * Settle a pending intent for this account+currency. Nothing new may be paid for
 * the group until the intent is resolved — its entries are still "held", and a
 * fresh selection would include them in a NEW set under a NEW key.
 *
 * Returns true when the group may continue to normal selection, false when it
 * must stop this sweep (outcome.error explains why).
 */
async function settlePendingIntent(
  intent: PayoutIntent,
  gateway: PayoutGateway,
  nowMs: number,
  outcome: ReleaseOutcome,
): Promise<boolean> {
  const lookup = await gateway.findPayoutByIntent(
    intent.stripeAccountId,
    intent.idempotencyKey,
    intent.createdAt,
  );
  if (lookup === null) {
    // Couldn't ask Stripe whether the payout exists. Freeze the group: paying
    // anything now risks paying the journalled set twice.
    outcome.error = "pending payout intent: Stripe lookup failed";
    return false;
  }

  const markSettled = (payoutId: string): void => {
    markManyReleased(intent.sessionIds, payoutId, {
      forcedSessionIds: intent.forcedSessionIds,
      recon: reconRowFor(intent),
    });
    if ((intent.recon?.amount ?? 0) > 0) clearSurplus(intent.stripeAccountId, intent.currency);
    clearIntent(intent.stripeAccountId, intent.currency);
    outcome.released.push(...intent.sessionIds);
    outcome.amount += intent.amount;
    outcome.payoutId = payoutId;
    if (intent.forcedSessionIds.length > 0) outcome.forcedByCeiling = true;
  };

  if (lookup.payoutId) {
    // The payout happened — the crash was between the Stripe call and the
    // ledger write. Mark the ORIGINAL set, never a re-derived one.
    markSettled(lookup.payoutId);
    console.log(
      `[payout-release] Recovered intent ${intent.idempotencyKey} → payout ${lookup.payoutId} ` +
        `(${intent.sessionIds.length} sales marked released)`,
    );
    return true;
  }

  if (nowMs - new Date(intent.createdAt).getTime() < REPLAY_WINDOW_MS) {
    // A set holding a sale of an event cancelled AFTER the set was chosen (#644)
    // is stale: its sum was fixed before the refunds. Asked per EVENT — the
    // per-sale hold lifts once a refund settles, minutes after a cancellation,
    // and replaying then would pay the refunded sale. A cancellation from before
    // the set was chosen is already in its sum (#781 part 2: a cancelled event's
    // settled sale now rides in sets as a debt). Clearing the intent now would
    // drop the key that makes a replay safe for the rest of the set, so the group
    // waits: once the window passes the intent is abandoned below and every sale
    // is re-resolved fresh.
    const cancelled = intent.sessionIds.filter((id) => {
      const eventId = getEntry(id)?.eventId;
      if (!eventId) return false;
      return gateway.cancelledAfter
        ? gateway.cancelledAfter(eventId, intent.createdAt)
        : gateway.eventCancelled?.(eventId) === true;
    });
    if (cancelled.length > 0) {
      outcome.deferred.push(...intent.sessionIds);
      console.warn(
        `[payout-release] Intent ${intent.idempotencyKey} not replayed: ${cancelled.length} sale(s) belong to a ` +
          `cancelled event (or the cancellation record is unreadable). The group waits until the intent can be abandoned.`,
      );
      return false;
    }
    // Definitively absent and the idempotency key is still live: replay the
    // journalled request verbatim. If a concurrent duplicate somehow exists,
    // the key — not our bookkeeping — is what prevents a second payout.
    try {
      const payoutId = await gateway.createPayout(payoutArgsFor(intent));
      markSettled(payoutId);
      console.log(`[payout-release] Replayed intent ${intent.idempotencyKey} → payout ${payoutId}`);
      return true;
    } catch (err) {
      outcome.error = err instanceof Error ? err.message : String(err);
      outcome.deferred.push(...intent.sessionIds);
      console.error(`[payout-release] Intent replay FAILED (${intent.idempotencyKey}):`, err);
      return false;
    }
  }

  // Provably absent and past the replay window. Abandon: the entries are still
  // held and re-enter normal selection below with FRESHLY resolved nets — a
  // refund that landed while the intent was stuck must be re-read before any
  // new attempt at the money.
  clearIntent(intent.stripeAccountId, intent.currency);
  console.warn(
    `[payout-release] Abandoned expired intent ${intent.idempotencyKey} ` +
      `(${intent.sessionIds.length} sales return to normal selection)`,
  );
  return true;
}

/** An entry the sweep reads this run. `payable` = due, so a positive net may be paid. */
interface Candidate {
  entry: PayoutLedgerEntry;
  payable: boolean;
  forced: boolean;
  /** When it fell due — the start of the balance-short alarm's clock. */
  dueSince?: string;
}

type ReadNet = Candidate & { net: number };

const sumNets = (xs: ReadNet[]): number => xs.reduce((s, x) => s + x.net, 0);

/**
 * Read each candidate's net from Stripe — fresh EVERY sweep, because a refund
 * can land between sweeps and a cached net would pay it out anyway — and sort
 * it: a negative net is a debt (#781), a due settled positive is payable, a
 * settled zero on a due sale voids. A net that may still move (`unsettled`) is
 * netted if negative but never paid or voided, and stays flagged so it is read
 * again. An unresolvable net stays held, never guessed at.
 */
async function readNets(
  candidates: Candidate[],
  gateway: PayoutGateway,
  currency: string,
  outcome: ReleaseOutcome,
  debts: ReadNet[],
  positives: ReadNet[],
): Promise<{ debtUnread: string[]; neverRead: string[] }> {
  const debtUnread: string[] = [];
  const neverRead: string[] = [];
  for (const c of candidates) {
    const { entry } = c;
    const resolved = await gateway.resolveNet(entry);
    if (resolved === null) {
      if (c.payable) outcome.deferred.push(entry.sessionId);
      if ((entry.netAmount ?? 0) < 0) debtUnread.push(entry.sessionId);
      if (entry.netAmount === undefined) neverRead.push(entry.sessionId);
      continue;
    }
    const { net, currency: settledIn, unsettled } = resolved;
    setNetAmount(entry.sessionId, net, settledIn);
    if (unsettled) flagForRecheck(entry.sessionId);
    if (settledIn !== currency) {
      // The charge settled in a different currency than this group is paying
      // (Stripe converted it into the account's default currency). The net is
      // in SETTLEMENT units and must be paid from the settlement balance —
      // defer; the next sweep regroups the entry under the recorded
      // settlementCurrency and releases it from the right pot.
      if (c.payable) outcome.deferred.push(entry.sessionId);
      console.warn(
        `[payout-release] ${entry.sessionId}: charged in ${entry.currency} but settled ` +
          `in ${settledIn} — regrouping under the settlement currency next sweep`,
      );
      continue;
    }
    if (net < 0) {
      // Already taken from the pooled balance: carried as a debt, never voided —
      // even while a dispute is open, since its withdrawal has posted (#781 part 2).
      debts.push({ ...c, net });
    } else if (unsettled) {
      // Never paid or voided while it may still move: a won dispute gives money
      // back, a pending refund may yet fail. The ceiling alarm still runs.
      if (c.payable) {
        outcome.deferred.push(entry.sessionId);
        console.warn(
          `[payout-release] ${entry.sessionId}: ` +
            (unsettled === "dispute" ? "dispute open" : "refund not settled") +
            " — held until it is final",
        );
      }
    } else if (net === 0) {
      // Only a due sale is retired. One read early stays held: its event's date,
      // not a refund's timing, decides when the sale is finished with.
      if (c.payable) {
        markVoid(entry.sessionId, "no net proceeds — refunded in full");
        outcome.voided.push(entry.sessionId);
      }
    } else if (c.payable) {
      positives.push({ ...c, net });
    }
  }
  return { debtUnread, neverRead };
}

/**
 * Debts first — the sales below zero and the balance's own shortfall against the
 * ledger (`balanceDebt`, ≤ 0) — then due sales oldest-first while the running sum
 * fits the available balance. `total` is the payout before any surplus; `rest`
 * are the due sales that did not fit.
 */
function selectForPayout(
  debts: ReadNet[],
  positives: ReadNet[],
  available: number,
  balanceDebt: number,
): { chosen: ReadNet[]; rest: ReadNet[]; total: number } {
  let total = sumNets(debts) + balanceDebt;
  const chosen: ReadNet[] = [];
  for (const p of positives) {
    if (total + p.net > available) break;
    chosen.push(p);
    total += p.net;
  }
  return { chosen, rest: positives.slice(chosen.length), total };
}

/**
 * What the balance holds beyond (or short of) the held ledger, in one currency
 * (#781 part 2): available + pending, less every held sale's last read net.
 */
function ledgerGap(stripeAccountId: string, currency: string, bal: { available: number; pending: number }): number {
  let reserved = 0;
  for (const e of listHeld()) {
    if (e.stripeAccountId !== stripeAccountId || (e.settlementCurrency ?? e.currency) !== currency) continue;
    reserved += e.netAmount ?? e.grossAmount;
  }
  return bal.available + bal.pending - reserved;
}

/**
 * When the balance holds less than the ledger says, the group's not-yet-due
 * sales are re-read at most this often, so a refund whose recheck flag was lost
 * is netted with its sale named rather than as an unattributed shortfall. The
 * money is right either way; a day's delay in naming it is the whole cost, and
 * reading a large festival's sales every hour is not.
 */
const SHORTFALL_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const lastShortfallScan = new Map<string, number>();

function shortfallScanDue(stripeAccountId: string, currency: string, nowMs: number): boolean {
  const key = `${stripeAccountId}|${currency}`;
  const last = lastShortfallScan.get(key);
  if (last !== undefined && nowMs - last < SHORTFALL_SCAN_INTERVAL_MS) return false;
  lastShortfallScan.set(key, nowMs);
  return true;
}

/**
 * Release what is due for one connected account and currency.
 *
 * Exported for tests and for the manual admin trigger; the scheduled job calls
 * `runReleaseSweep`, which groups the ledger and calls this per group.
 */
export async function releaseForAccount(
  stripeAccountId: string,
  currency: string,
  entries: PayoutLedgerEntry[],
  gateway: PayoutGateway = liveGateway,
  now: Date = new Date(),
): Promise<ReleaseOutcome> {
  const outcome: ReleaseOutcome = {
    stripeAccountId,
    currency,
    released: [],
    deferred: [],
    voided: [],
    debts: [],
    amount: 0,
    forcedByCeiling: false,
  };

  const nowMs = now.getTime();

  // A pending intent MUST settle before any new selection: its entries are
  // still "held", and selecting them again would pay them under a second key.
  const pending = getIntent(stripeAccountId, currency);
  if (pending) {
    const proceed = await settlePendingIntent(pending, gateway, nowMs, outcome);
    if (!proceed) return outcome;
  }

  // Defensive: this is exported, so a caller could hand us a stale list — and
  // intent recovery above may have just released some of these entries. Paying
  // out an already-released entry is the worst bug available here. A group with
  // nothing held still runs: its balance can move with nothing held (#781 part 2).
  entries = entries.filter((e) => e.status === "held");

  const country = entries.length > 0 ? await gateway.accountCountry(stripeAccountId) : undefined;

  // Which entries to read from Stripe this sweep, and which of them may be PAID.
  // A due entry (event over, or the ceiling reached) may be paid. Any other entry
  // is read, never paid, when the ledger cannot vouch for its net: never read
  // before, flagged by a refund or dispute, last seen below zero, or a cancelled
  // event's settled sale (#781). Netting a debt early can only lower a payout.
  const toRead: Candidate[] = [];
  const notDue: PayoutLedgerEntry[] = [];
  for (const entry of entries.slice().sort(byAge)) {
    // A cancelled event's takings fund its refunds (#644): held until every
    // refund is settled, and never forced out by the hold ceiling — paying the
    // organiser the balance a buyer's refund is waiting on is the one outcome
    // worse than a late payout. `heldPastCeiling` still counts them.
    const refundHold = !!entry.eventId && gateway.cancellationHold?.(entry.eventId, entry.sessionId) === true;
    if (refundHold) outcome.deferred.push(entry.sessionId);
    const eventDue = nowMs >= new Date(entry.releaseAfter).getTime();
    const ceiling = holdCeilingAt(entry.recordedAt, country);
    const ceilingHit = nowMs >= new Date(ceiling).getTime();
    // Past the hold above, a cancelled event's sale has had its refund settle.
    // It is read at once so the fees kept on that refund are netted straight
    // away. A positive remainder (an operator resolved the row: the buyer was
    // made whole another way) still waits for its date like any other sale.
    const settledCancelled = !refundHold && !!entry.eventId && gateway.eventCancelled?.(entry.eventId) === true;
    if (!refundHold && (eventDue || ceilingHit)) {
      toRead.push({
        entry,
        payable: true,
        forced: ceilingHit && !eventDue,
        dueSince: eventDue ? entry.releaseAfter : ceiling,
      });
    } else if (
      settledCancelled || entry.recheck || entry.netAmount === undefined || entry.netAmount < 0
    ) {
      toRead.push({ entry, payable: false, forced: false });
    } else {
      notDue.push(entry);
    }
  }

  const debts: ReadNet[] = [];
  const positives: ReadNet[] = [];
  const { debtUnread, neverRead } = await readNets(toRead, gateway, currency, outcome, debts, positives);
  if (neverRead.length > 0 || debtUnread.length > 0) {
    // The ledger cannot vouch for what it holds: a sale never read has no net,
    // and a debt that could not be read may be larger now. Measuring the balance
    // against a guess would net the guess, so wait an hour.
    outcome.error = debtUnread.length > 0 ? "a known debt could not be read" : "a sale could not be read";
    outcome.deferred.push(...positives.map((p) => p.entry.sessionId));
    console.warn(
      `[payout-release] ${stripeAccountId} ${currency}: payout held — ` +
        `${[...debtUnread, ...neverRead].join(", ")} could not be read this sweep`,
    );
    return outcome;
  }

  const bal = await gateway.balance(stripeAccountId, currency);
  if (bal === null) {
    outcome.error = "balance unavailable";
    outcome.deferred.push(...positives.map((p) => p.entry.sessionId));
    return outcome;
  }

  // The balance against the ledger (#781 part 2). Every held sale's net is in the
  // balance, available or pending, so what is left over is money that moved
  // outside any sale: below zero, a chargeback or refund after an earlier payout,
  // or fees; above zero, a debt Stripe recovered from the organiser's bank, a
  // dispute won after payout, a top-up, an own payment. Pending money cancels
  // out, so settlement timing never reads as either.
  let rho = ledgerGap(stripeAccountId, currency, bal);
  if (rho < 0 && notDue.length > 0 && shortfallScanDue(stripeAccountId, currency, nowMs)) {
    // The balance holds less than the ledger says. A refund on a sale that is
    // not due yet would explain it with its sale named, and its recheck flag
    // (set by the webhook) may have been lost. Read those sales once a day.
    await readNets(
      notDue.map((entry) => ({ entry, payable: false, forced: false })),
      gateway,
      currency,
      outcome,
      debts,
      positives,
    );
    rho = ledgerGap(stripeAccountId, currency, bal);
  }
  outcome.rho = rho;

  // A surplus is the organiser's, paid once it has lasted SURPLUS_SETTLE_DAYS.
  const clock = observeSurplus(stripeAccountId, currency, rho, now);
  const surplusDue =
    clock && nowMs - new Date(clock.since).getTime() >= SURPLUS_SETTLE_DAYS * 86_400_000
      ? Math.min(clock.min, rho)
      : 0;

  const owed = sumNets(debts) + Math.min(0, rho);
  if (owed < 0 && owed + sumNets(positives) <= 0) {
    // What is owed outweighs everything due, so no selection can pay anything.
    // The sales stay held until new takings cover it.
    outcome.owes = true;
    outcome.deferred.push(...positives.map((p) => p.entry.sessionId));
    if (positives.length > 0) {
      console.warn(
        `[payout-release] ${stripeAccountId} ${currency}: ${-owed} owed exceeds the ` +
          `${sumNets(positives)} due — nothing payable until new sales cover it`,
      );
    }
    return outcome;
  }

  // Select BEFORE paying. Everything owed first: that money has already left the
  // balance, so paying the due sales in full would spend another event's held
  // takings (#781). Then due sales oldest-first while they still fit inside the
  // settled balance — anything that doesn't fit stays held (funds in `pending`
  // haven't settled yet; that is normal, not an error). A settled surplus last.
  const { chosen, rest, total: salesTotal } = selectForPayout(debts, positives, bal.available, Math.min(0, rho));
  const surplusPaid = surplusDue > 0 ? Math.max(0, Math.min(surplusDue, bal.available - salesTotal)) : 0;
  const total = salesTotal + surplusPaid;
  const paying = total > 0 && (chosen.length > 0 || surplusPaid > 0);
  const unpaid = paying ? rest : positives;
  outcome.deferred.push(...unpaid.map((p) => p.entry.sessionId));
  const shortSince = unpaid.map((p) => p.dueSince).filter((d): d is string => !!d).sort()[0];
  if (shortSince) outcome.shortSince = shortSince;

  if (!paying) {
    if (positives.length > 0) {
      console.log(
        `[payout-release] ${stripeAccountId} ${currency}: ${positives.length} due but ` +
          `available=${bal.available} — deferring to next sweep`,
      );
    }
    return outcome;
  }

  // The part of the payout no sale accounts for: what the balance lost (netted)
  // or gained (paid). Its own ledger row, so a payout's rows add up to it.
  const reconAmount = Math.min(0, rho) + surplusPaid;
  const recon =
    reconAmount !== 0
      ? {
          id: `recon_${stripeAccountId}_${currency}_${nowMs}`,
          amount: reconAmount,
          organiserAddress: entries[0]?.organiserAddress ?? organiserForAccount(stripeAccountId) ?? "",
        }
      : undefined;
  const selected = [...debts, ...chosen];
  const sessionIds = [...selected.map((p) => p.entry.sessionId), ...(recon ? [recon.id] : [])];
  const forced = chosen.some((p) => p.forced);
  outcome.forcedByCeiling = outcome.forcedByCeiling || forced;

  // Journal the intent BEFORE Stripe is called. From here until clearIntent,
  // any crash or ambiguous failure leaves the exact set + key on disk, and the
  // next sweep settles THAT rather than re-deriving a set that may have grown.
  const intent: PayoutIntent = {
    stripeAccountId,
    currency,
    sessionIds,
    forcedSessionIds: chosen.filter((p) => p.forced).map((p) => p.entry.sessionId),
    amount: total,
    idempotencyKey: idempotencyKeyFor(sessionIds),
    createdAt: now.toISOString(),
    ...(recon ? { recon } : {}),
  };
  if (!saveIntent(intent)) {
    // No journal, no payout. Paying with the intent only in memory would reopen
    // the exact double-payout window the journal exists to close: a crash before
    // `markManyReleased` leaves Stripe paid, disk silent, and the next sweep free
    // to re-select a set that has since grown — a different key, a second payout.
    outcome.error = "payout intent journal unwritable";
    outcome.deferred.push(...selected.map((p) => p.entry.sessionId));
    console.error(
      `[payout-release] ${stripeAccountId} ${currency}: intent journal did not persist — ` +
        `deferring ${selected.length} sale(s). Funds stay held; see /api/health.`,
    );
    return outcome;
  }

  try {
    const payoutId = await gateway.createPayout(payoutArgsFor(intent));

    // One write for the whole set: a per-entry loop interrupted half way would
    // leave already-paid entries "held", i.e. selectable again under a new key.
    markManyReleased(sessionIds, payoutId, { forcedSessionIds: intent.forcedSessionIds, recon: reconRowFor(intent) });
    if (surplusPaid > 0) clearSurplus(stripeAccountId, currency);
    clearIntent(stripeAccountId, currency);
    outcome.released.push(...sessionIds);
    outcome.debts.push(...debts.map((d) => d.entry.sessionId));
    outcome.amount += total;
    outcome.payoutId = payoutId;
    if (recon) outcome.recon = recon.amount;

    console.log(
      `[payout-release] Paid out ${total} ${currency} to ${stripeAccountId} ` +
        `(payout=${payoutId}, sales=${chosen.length}` +
        (debts.length > 0 ? `, debts netted=${debts.length} (${-sumNets(debts)})` : "") +
        (recon ? `, balance ${recon.amount < 0 ? "shortfall netted" : "surplus paid"}=${Math.abs(recon.amount)}` : "") +
        `${forced ? ", CEILING-FORCED" : ""})`,
    );
    if (forced) {
      console.warn(
        `[payout-release] ⚠️ ${stripeAccountId}: released BEFORE the event because Stripe's ` +
          `${country ?? "default"} hold ceiling was reached. Attendee funds are no longer held.`,
      );
    }
  } catch (err) {
    // Entries stay held and the intent stays journalled — deliberately. We
    // cannot know from a thrown error whether Stripe processed the payout
    // (timeouts and 5xx are ambiguous), so the next sweep settles the intent:
    // confirm, replay under the same key, or abandon once provably absent.
    outcome.error = err instanceof Error ? err.message : String(err);
    outcome.deferred.push(...selected.map((p) => p.entry.sessionId));
    console.error(`[payout-release] Payout FAILED for ${stripeAccountId} ${currency}:`, err);
  }

  return outcome;
}

/** Group every held entry by account + payout currency and release what is due. */
export async function runReleaseSweep(
  gateway: PayoutGateway = liveGateway,
  now: Date = new Date(),
): Promise<ReleaseOutcome[]> {
  const held = listHeld();

  const groups = new Map<string, PayoutLedgerEntry[]>();
  for (const e of held) {
    // Payout currency is where the money actually sits: the settlement
    // currency when Stripe converted the charge, the presentment currency
    // otherwise.
    const key = `${e.stripeAccountId}|${e.settlementCurrency ?? e.currency}`;
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
  }

  // A pending intent whose entries are all already settled (or otherwise gone)
  // would never be visited via held entries — give it an empty group so
  // recovery still runs. Likewise every account that has ever been paid, and
  // every running surplus clock (#781 part 2): a chargeback after the last
  // payout, or a debt Stripe recovered from the bank, moves a balance with
  // nothing held.
  const extra = [
    ...listIntents().map((i) => ({ stripeAccountId: i.stripeAccountId, currency: i.currency })),
    ...listAccountGroups(),
    ...listSurplusClocks(),
  ];
  for (const g of extra) {
    const key = `${g.stripeAccountId}|${g.currency}`;
    if (!groups.has(key)) groups.set(key, []);
  }
  if (groups.size === 0) return [];

  // Retry any manual-schedule correction that failed on an `account.updated`
  // webhook. Those are fire-and-forget by necessity (a webhook must answer
  // fast), so without a retry a transient Stripe error left the account on the
  // automatic schedule until another webhook happened to arrive.
  await retryPendingScheduleHeals().catch((err) => {
    console.error("[payout-release] Schedule-heal retry threw:", err);
  });

  const outcomes: ReleaseOutcome[] = [];
  for (const [key, entries] of groups) {
    const [stripeAccountId, currency] = key.split("|") as [string, string];
    try {
      outcomes.push(await releaseForAccount(stripeAccountId, currency, entries, gateway, now));
    } catch (err) {
      console.error(`[payout-release] Sweep failed for ${key}:`, err);
    }
  }
  recordGroupAlarms(outcomes, now);
  return outcomes;
}

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------

const health = {
  startedAt: new Date().toISOString(),
  lastRunAt: null as string | null,
  lastError: null as string | null,
  runs: 0,
};

/**
 * Liveness for the release sweep. A payout job that dies quietly is the classic
 * failure here — nobody notices until an organiser asks where their money is, or
 * funds breach Stripe's hold ceiling. `stale` is the alarm condition.
 *
 * Deliberately carries NO amounts: this is surfaced on the public health endpoint,
 * and organiser financials are not public.
 */
/**
 * Held entries that are already past the moment we were required to pay them
 * out. Non-zero means a net could not be resolved (or a payout kept failing) for
 * long enough to breach Stripe's documented ceiling — a compliance problem that
 * the 7-day safety margin cannot help with, because it only buys time against a
 * TRANSIENT block. Per-sweep error logs were the only signal before this.
 *
 * Synchronous, so it uses the country cache the sweep populates and falls back
 * to the default ceiling for an account it has not seen yet. That can only make
 * the alarm EARLY for a long-ceiling country (US, 730d) and never late for a
 * short one, which is the right direction for a compliance deadline.
 */
export function heldPastCeiling(now: Date = new Date()): { count: number; oldestBreachedAt: string | null } {
  const nowMs = now.getTime();
  let count = 0;
  let oldest: string | null = null;

  for (const entry of listHeld()) {
    // A debt holds no funds, so Stripe's limit on holding them does not apply (#781),
    // and nor does a sale in a group that owes more than it holds.
    if (typeof entry.netAmount === "number" && entry.netAmount <= 0) continue;
    if (owingGroups.has(`${entry.stripeAccountId}|${entry.settlementCurrency ?? entry.currency}`)) continue;
    const ceiling = holdCeilingAt(entry.recordedAt, countryCache.get(entry.stripeAccountId));
    if (nowMs < new Date(ceiling).getTime()) continue;
    count++;
    if (!oldest || ceiling < oldest) oldest = ceiling;
  }
  return { count, oldestBreachedAt: oldest };
}

/**
 * Per account+currency alarms from the last sweep (#781), rebuilt whole each
 * run so a group that has since paid out or emptied drops off. Counts only
 * leave this module: the health endpoint is public.
 */
let groupAlarms = { balanceShort: 0, oldestShortSince: null as string | null, accountsOwing: 0 };
/** `${account}|${currency}` the last sweep found owing — no funds behind their held sales. */
let owingGroups = new Set<string>();

function recordGroupAlarms(outcomes: ReleaseOutcome[], now: Date): void {
  owingGroups = new Set(outcomes.filter((o) => o.owes).map((o) => `${o.stripeAccountId}|${o.currency}`));
  const cutoff = now.getTime() - BALANCE_SHORT_ALARM_DAYS * 86_400_000;
  const short = outcomes
    .map((o) => o.shortSince)
    .filter((s): s is string => !!s && new Date(s).getTime() <= cutoff)
    .sort();
  groupAlarms = {
    balanceShort: short.length,
    oldestShortSince: short[0] ?? null,
    accountsOwing: outcomes.filter((o) => o.owes).length,
  };
}

export function payoutSweepHealth(): {
  /** False on any alarm below, so `/api/health/alarms` pages on it. */
  ok: boolean;
  running: boolean;
  lastRunAt: string | null;
  runs: number;
  stale: boolean;
  lastError: string | null;
  /** Count only, no amounts — this endpoint is public. */
  heldPastCeiling: number;
  oldestCeilingBreachAt: string | null;
  /** Accounts still on Stripe's automatic schedule after a failed correction. */
  pendingScheduleHeals: number;
  /**
   * Account+currency groups with a sale due for over BALANCE_SHORT_ALARM_DAYS
   * that does not fit the balance: it holds less than the ledger says (#781).
   */
  balanceShort: number;
  oldestBalanceShortSince: string | null;
  /** Groups whose debts outweigh everything due: nothing payable until new sales cover them. Counted, not an alarm. */
  accountsOwing: number;
  /**
   * Groups whose balance has held money no sale accounts for (#781 part 2) for
   * over SURPLUS_ALARM_DAYS without it being paid out: it should have gone after
   * SURPLUS_SETTLE_DAYS.
   */
  surplusOverdue: number;
} {
  const running = timer !== null;
  // Two-and-a-half missed hourly runs. Measured from boot until the first run
  // completes, so a job that never runs at all still trips the alarm.
  const since = health.lastRunAt ?? health.startedAt;
  const stale = running && Date.now() - new Date(since).getTime() > RELEASE_INTERVAL_MS * 2.5;
  const breached = heldPastCeiling();
  const heals = pendingScheduleHeals().length;
  const overdueCutoff = Date.now() - SURPLUS_ALARM_DAYS * 86_400_000;
  const surplusOverdue = listSurplusClocks().filter((c) => new Date(c.since).getTime() <= overdueCutoff).length;
  return {
    // `accountsOwing` is left out: only the organiser selling again clears it,
    // so it would hold the whole section red for months with nothing to do.
    ok: !stale && breached.count === 0 && heals === 0 && groupAlarms.balanceShort === 0 && surplusOverdue === 0,
    running,
    lastRunAt: health.lastRunAt,
    runs: health.runs,
    stale,
    lastError: health.lastError,
    heldPastCeiling: breached.count,
    oldestCeilingBreachAt: breached.oldestBreachedAt,
    pendingScheduleHeals: heals,
    balanceShort: groupAlarms.balanceShort,
    oldestBalanceShortSince: groupAlarms.oldestShortSince,
    accountsOwing: groupAlarms.accountsOwing,
    surplusOverdue,
  };
}

/** Test seam — forget the shortfall-scan clock and the last sweep's alarms. */
export function __resetSweepStateForTests(): void {
  lastShortfallScan.clear();
  owingGroups = new Set();
  groupAlarms = { balanceShort: 0, oldestShortSince: null, accountsOwing: 0 };
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the hourly sweep. Safe to call once at boot; no-op if already running. */
export function startPayoutReleaseJob(): void {
  if (timer) return;
  // No sweep at boot: a restart loop would hammer Stripe. The first runs an hour in.
  timer = setInterval(() => {
    void runReleaseSweep()
      .then(() => {
        health.lastRunAt = new Date().toISOString();
        health.runs++;
        health.lastError = null;
      })
      .catch((err) => {
        // lastRunAt is NOT advanced on failure — a job that runs but always throws
        // must read as stale, not healthy.
        health.lastError = err instanceof Error ? err.message : String(err);
        console.error("[payout-release] Sweep threw:", err);
      });
  }, RELEASE_INTERVAL_MS);
  timer.unref?.();
  console.log("[payout-release] Hourly post-event release sweep started");
}
