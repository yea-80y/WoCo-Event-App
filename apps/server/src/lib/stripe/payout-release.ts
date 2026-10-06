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
import { BALANCE_SHORT_ALARM_DAYS, holdCeilingAt } from "./payout-policy.js";
import { pendingScheduleHeals, retryPendingScheduleHeals } from "./payout-schedule.js";
import {
  getEntry,
  listHeld,
  markManyReleased,
  markVoid,
  setNetAmount,
  type PayoutLedgerEntry,
} from "./payout-ledger.js";
import { OPEN_DISPUTE_STATUSES } from "./dispute-status.js";
import { cancellationGate, isSaleRefundSettled } from "../event/cancellations.js";
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
   * entry held rather than guessing. `held` means the sale's worth is not final
   * yet — a dispute is still open, or a refund has not moved money yet (#701) —
   * so the entry stays held until it is.
   */
  resolveNet(entry: PayoutLedgerEntry): Promise<ResolvedNet | null>;
  /** Aggregate available balance for a currency, minor units. */
  availableBalance(stripeAccountId: string, currency: string): Promise<number | null>;
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
}

export type ResolvedNet = { net: number; currency: string } | { held: "dispute" | "refund" };

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
  /** The account's debts are larger than everything due: nothing can be paid. */
  owes?: boolean;
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
  // in `charge.amount_refunded` is not documented. Skipping it resolved the
  // sale POSITIVE and paid out the very balance the refund was waiting on, so
  // anything without a balance transaction that is not failed or cancelled
  // (including a status we do not know) holds the sale.
  //
  // A refund that FAILED after its debit posted keeps that debit as
  // `balance_transaction` and gets the reversal as `failure_balance_transaction`
  // (stripe-node Refund). Netting the debit alone would void the sale — a
  // terminal state — with the money back in the organiser's balance and nothing
  // left watching it. So both are netted, and a failure whose reversal has not
  // posted yet holds, like a won dispute awaiting its reinstatement.
  const btIdOf = (b: string | Stripe.BalanceTransaction | null | undefined): string | undefined =>
    typeof b === "string" ? b : b?.id;
  for await (const r of s.refunds.list({ charge: charge.id, limit: 100 }, opts)) {
    const gone = r.status === "failed" || r.status === "canceled";
    const rBtId = btIdOf(r.balance_transaction);
    if (!rBtId) {
      if (gone) continue;
      return { held: "refund" };
    }
    const rBt = await s.balanceTransactions.retrieve(rBtId, {}, opts);
    net += rBt.net; // negative
    if (gone) {
      const fBtId = btIdOf(r.failure_balance_transaction);
      if (!fBtId) return { held: "refund" };
      const fBt = await s.balanceTransactions.retrieve(fBtId, {}, opts);
      net += fBt.net; // positive
    }
  }

  // Disputes (#645 part C). Each carries zero, one or two balance transactions:
  // the withdrawal (amount + dispute fee, negative) when it became a
  // chargeback, and the reinstatement (positive) if it was won. While one is
  // still open the sale's worth is unknown — the sweep holds it rather than
  // paying out money the buyer's bank may be about to take back. A lost
  // dispute's withdrawal takes the net to zero or below, and the existing void
  // branch retires the entry.
  if (charge.disputed) {
    for await (const d of s.disputes.list({ charge: charge.id, limit: 100 }, opts)) {
      // Open: `warning_*` too — an inquiry moves no money but can escalate.
      if (OPEN_DISPUTE_STATUSES.has(d.status)) return { held: "dispute" };
      // A WON dispute whose reinstatement has not posted yet shows only the
      // withdrawal. Netting that would void a sale the organiser won, and the
      // void is terminal — so it waits, like an open one.
      if (d.status === "won" && d.balance_transactions.some((b) => b.net < 0)
          && !d.balance_transactions.some((b) => b.net > 0)) {
        return { held: "dispute" };
      }
      for (const dBt of d.balance_transactions) {
        // Every transaction on this account's balance settles in its own
        // currency; one that does not cannot be summed, so decide nothing.
        if (dBt.currency.toLowerCase() !== bt.currency.toLowerCase()) return null;
        net += dBt.net;
      }
    }
  }
  return { net, currency: bt.currency.toLowerCase() };
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

  async availableBalance(stripeAccountId, currency) {
    try {
      const s = getStripe();
      const balance = await s.balance.retrieve({}, { stripeAccount: stripeAccountId });
      const row = balance.available.find((a) => a.currency === currency.toLowerCase());
      return row?.amount ?? 0;
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
    markManyReleased(intent.sessionIds, payoutId, { forcedSessionIds: intent.forcedSessionIds });
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
    // A set holding a sale of a cancelled event (#644) is stale: its sum was
    // fixed before the refunds. Asked per EVENT — the per-sale hold lifts once a
    // refund settles, minutes after a cancellation, and replaying then would pay
    // the refunded sale. Clearing the intent now would drop the key that makes a
    // replay safe for the rest of the set, so the group waits: once the window
    // passes the intent is abandoned below and every sale is re-resolved fresh.
    const cancelled = intent.sessionIds.filter((id) => {
      const eventId = getEntry(id)?.eventId;
      return !!eventId && gateway.eventCancelled?.(eventId) === true;
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
 * it: a negative net is a debt (#781), a due positive is payable, a zero on a
 * due sale voids. An unresolvable or unsettled net stays held, never guessed at.
 */
async function readNets(
  candidates: Candidate[],
  gateway: PayoutGateway,
  currency: string,
  outcome: ReleaseOutcome,
  debts: ReadNet[],
  positives: ReadNet[],
): Promise<{ debtUnread: string[] }> {
  const debtUnread: string[] = [];
  for (const c of candidates) {
    const { entry } = c;
    const resolved = await gateway.resolveNet(entry);
    if (resolved === null) {
      if (c.payable) outcome.deferred.push(entry.sessionId);
      if ((entry.netAmount ?? 0) < 0) debtUnread.push(entry.sessionId);
      continue;
    }
    if ("held" in resolved) {
      // Never voided here: `markVoid` is terminal, a won dispute gives the money
      // back, and a pending refund may yet fail. Held until it is final (the
      // ceiling alarm still runs). Any recheck flag stays, so it is read again.
      if (c.payable) outcome.deferred.push(entry.sessionId);
      console.warn(
        `[payout-release] ${entry.sessionId}: ` +
          (resolved.held === "dispute" ? "dispute open" : "refund not settled") +
          " — held until it is final",
      );
      continue;
    }
    const { net, currency: settledIn } = resolved;
    setNetAmount(entry.sessionId, net, settledIn);
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
      // Already taken from the pooled balance: carried as a debt, never voided.
      debts.push({ ...c, net });
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
  return { debtUnread };
}

/**
 * Debts first, then due sales oldest-first while the running sum fits the
 * available balance. `total` is the payout; `rest` are the due sales that did
 * not fit.
 */
function selectForPayout(
  debts: ReadNet[],
  positives: ReadNet[],
  available: number,
): { chosen: ReadNet[]; rest: ReadNet[]; total: number } {
  let total = sumNets(debts);
  const chosen: ReadNet[] = [];
  for (const p of positives) {
    if (total + p.net > available) break;
    chosen.push(p);
    total += p.net;
  }
  return { chosen, rest: positives.slice(chosen.length), total };
}

/**
 * The not-yet-due sales of a group whose due sales do not fit are read at most
 * this often. It is the backstop for a lost recheck flag, so a day's delay in
 * netting a debt is the whole cost, and reading a large festival's sales every
 * hour while a gig's last-minute takings are still pending is not.
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
  // out an already-released entry is the worst bug available here.
  entries = entries.filter((e) => e.status === "held");
  if (entries.length === 0) return outcome;

  const country = await gateway.accountCountry(stripeAccountId);

  // Which entries to read from Stripe this sweep, and which of them may be PAID.
  // A due entry (event over, or the ceiling reached) may be paid. Any other entry
  // is read only when it may carry a debt — a refund or dispute flagged it, or
  // its last known net was below zero (#781). Netting a debt early can only
  // lower a payout, and a positive net that is not due is never paid.
  const toRead: Candidate[] = [];
  const notDue: PayoutLedgerEntry[] = [];
  for (const entry of entries.slice().sort(byAge)) {
    // A cancelled event's takings fund its refunds (#644): held until every
    // refund is settled, and never forced out by the hold ceiling — paying the
    // organiser the balance a buyer's refund is waiting on is the one outcome
    // worse than a late payout. `heldPastCeiling` still counts them.
    if (entry.eventId && gateway.cancellationHold?.(entry.eventId, entry.sessionId)) {
      outcome.deferred.push(entry.sessionId);
      continue;
    }
    const eventDue = nowMs >= new Date(entry.releaseAfter).getTime();
    const ceiling = holdCeilingAt(entry.recordedAt, country);
    const ceilingHit = nowMs >= new Date(ceiling).getTime();
    // Past the hold above, a cancelled event's sale has had its refund settle.
    // It is read at once so the fees kept on that refund are netted straight
    // away. A positive remainder (an operator resolved the row: the buyer was
    // made whole another way) still waits for its date like any other sale.
    const cancelled = !!entry.eventId && gateway.eventCancelled?.(entry.eventId) === true;
    if (eventDue || ceilingHit) {
      toRead.push({
        entry,
        payable: true,
        forced: ceilingHit && !eventDue,
        dueSince: eventDue ? entry.releaseAfter : ceiling,
      });
    } else if (cancelled || entry.recheck || (entry.netAmount ?? 0) < 0) {
      toRead.push({ entry, payable: false, forced: false });
    } else {
      notDue.push(entry);
    }
  }
  if (toRead.length === 0) return outcome;

  const debts: ReadNet[] = [];
  const positives: ReadNet[] = [];
  const { debtUnread } = await readNets(toRead, gateway, currency, outcome, debts, positives);
  if (positives.length === 0) {
    if (debts.length > 0) {
      console.log(
        `[payout-release] ${stripeAccountId} ${currency}: ${debts.length} debt(s) wait for the next due sale`,
      );
    }
    return outcome;
  }
  if (debtUnread.length > 0) {
    // A sale known to be below zero could not be read this sweep. Paying without
    // it would spend another event's takings by that much, so wait an hour.
    outcome.error = "a known debt could not be read";
    outcome.deferred.push(...positives.map((p) => p.entry.sessionId));
    console.warn(
      `[payout-release] ${stripeAccountId} ${currency}: payout held — known debt(s) ${debtUnread.join(", ")} ` +
        `could not be read this sweep`,
    );
    return outcome;
  }
  if (debts.length > 0 && sumNets(debts) + sumNets(positives) <= 0) {
    // The debts outweigh everything due, so no selection can pay anything. The
    // sales stay held until new takings cover the debt.
    outcome.owes = true;
    outcome.deferred.push(...positives.map((p) => p.entry.sessionId));
    console.warn(
      `[payout-release] ${stripeAccountId} ${currency}: debts of ${-sumNets(debts)} exceed the ` +
        `${sumNets(positives)} due — nothing payable until new sales cover them`,
    );
    return outcome;
  }

  const available = await gateway.availableBalance(stripeAccountId, currency);
  if (available === null) {
    outcome.error = "balance unavailable";
    outcome.deferred.push(...positives.map((p) => p.entry.sessionId));
    return outcome;
  }

  // Select BEFORE paying. Every debt first: that money has already left the
  // balance, so paying the due sales in full would spend another event's held
  // takings (#781). Then due sales oldest-first while they still fit inside the
  // settled balance. Anything that doesn't fit stays held for the next sweep
  // (funds in `pending` haven't settled yet — that is normal, not an error).
  let selection = selectForPayout(debts, positives, available);
  if (selection.rest.length > 0 && notDue.length > 0 && shortfallScanDue(stripeAccountId, currency, nowMs)) {
    // Something due does not fit. A debt on a sale that is not due yet would
    // explain it, and its recheck flag (set by the refund webhook) may have been
    // lost. Read those sales once a day as the backstop.
    const known = debts.length;
    await readNets(
      notDue.map((entry) => ({ entry, payable: false, forced: false })),
      gateway,
      currency,
      outcome,
      debts,
      positives,
    );
    if (debts.length > known) selection = selectForPayout(debts, positives, available);
  }
  const { chosen, rest, total } = selection;
  const paying = chosen.length > 0 && total > 0;
  const unpaid = paying ? rest : positives;
  outcome.deferred.push(...unpaid.map((p) => p.entry.sessionId));
  const shortSince = unpaid.map((p) => p.dueSince).filter((d): d is string => !!d).sort()[0];
  if (shortSince) outcome.shortSince = shortSince;

  if (!paying) {
    console.log(
      `[payout-release] ${stripeAccountId} ${currency}: ${positives.length} due but ` +
        `available=${available} — deferring to next sweep`,
    );
    return outcome;
  }

  const selected = [...debts, ...chosen];
  const sessionIds = selected.map((p) => p.entry.sessionId);
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
  };
  if (!saveIntent(intent)) {
    // No journal, no payout. Paying with the intent only in memory would reopen
    // the exact double-payout window the journal exists to close: a crash before
    // `markManyReleased` leaves Stripe paid, disk silent, and the next sweep free
    // to re-select a set that has since grown — a different key, a second payout.
    outcome.error = "payout intent journal unwritable";
    outcome.deferred.push(...sessionIds);
    console.error(
      `[payout-release] ${stripeAccountId} ${currency}: intent journal did not persist — ` +
        `deferring ${sessionIds.length} sale(s). Funds stay held; see /api/health.`,
    );
    return outcome;
  }

  try {
    const payoutId = await gateway.createPayout(payoutArgsFor(intent));

    // One write for the whole set: a per-entry loop interrupted half way would
    // leave already-paid entries "held", i.e. selectable again under a new key.
    markManyReleased(sessionIds, payoutId, { forcedSessionIds: intent.forcedSessionIds });
    clearIntent(stripeAccountId, currency);
    outcome.released.push(...sessionIds);
    outcome.debts.push(...debts.map((d) => d.entry.sessionId));
    outcome.amount += total;
    outcome.payoutId = payoutId;

    console.log(
      `[payout-release] Paid out ${total} ${currency} to ${stripeAccountId} ` +
        `(payout=${payoutId}, sales=${chosen.length}` +
        (debts.length > 0 ? `, debts netted=${debts.length} (${-sumNets(debts)})` : "") +
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
    outcome.deferred.push(...sessionIds);
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
  // recovery still runs.
  for (const intent of listIntents()) {
    const key = `${intent.stripeAccountId}|${intent.currency}`;
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
    // A debt holds no funds, so Stripe's limit on holding them does not apply (#781).
    if (typeof entry.netAmount === "number" && entry.netAmount <= 0) continue;
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

function recordGroupAlarms(outcomes: ReleaseOutcome[], now: Date): void {
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
} {
  const running = timer !== null;
  // Two-and-a-half missed hourly runs. Measured from boot until the first run
  // completes, so a job that never runs at all still trips the alarm.
  const since = health.lastRunAt ?? health.startedAt;
  const stale = running && Date.now() - new Date(since).getTime() > RELEASE_INTERVAL_MS * 2.5;
  const breached = heldPastCeiling();
  const heals = pendingScheduleHeals().length;
  return {
    // `accountsOwing` is left out: only the organiser selling again clears it,
    // so it would hold the whole section red for months with nothing to do.
    ok: !stale && breached.count === 0 && heals === 0 && groupAlarms.balanceShort === 0,
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
  };
}

/** Test seam — forget the shortfall-scan clock and the last sweep's alarms. */
export function __resetSweepStateForTests(): void {
  lastShortfallScan.clear();
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
