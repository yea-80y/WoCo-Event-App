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
 * Ordering invariant that keeps this safe under crashes: we choose the set of
 * entries FIRST, pay out exactly their sum, and only then mark them released. The
 * payout is created with an idempotency key derived from that set, so a crash
 * between the payout call and the ledger write re-selects the same set on the next
 * run, replays the same key, and Stripe returns the original payout instead of
 * making a second one.
 */

import type Stripe from "stripe";
import { createHash } from "node:crypto";
import { getStripe } from "./client.js";
import { holdCeilingAt } from "./payout-policy.js";
import {
  listHeld,
  markReleased,
  markVoid,
  setNetAmount,
  type PayoutLedgerEntry,
} from "./payout-ledger.js";

/** How often the job sweeps. Payout timing is measured in days — hourly is ample. */
const RELEASE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Everything the release engine needs from Stripe, behind an interface so the
 * decision logic can be tested without network access.
 */
export interface PayoutGateway {
  /**
   * Minor units actually credited to the connected account for this sale:
   * gross − Stripe processing − our application fee − refunds. Read from the
   * balance transaction, so it reflects what Stripe really did rather than what
   * we predicted. `null` means "couldn't determine" — the caller leaves the entry
   * held rather than guessing.
   */
  resolveNet(entry: PayoutLedgerEntry): Promise<number | null>;
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
  /** ISO-3166 alpha-2 of the business, which picks the hold ceiling. */
  accountCountry(stripeAccountId: string): Promise<string | undefined>;
}

export interface ReleaseOutcome {
  stripeAccountId: string;
  currency: string;
  /** Entries released in this run. */
  released: string[];
  /** Entries due but left held because the balance hadn't settled yet. */
  deferred: string[];
  voided: string[];
  amount: number;
  payoutId?: string;
  /** True when at least one released entry was forced out by the hold ceiling. */
  forcedByCeiling: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Live gateway
// ---------------------------------------------------------------------------

const countryCache = new Map<string, string | undefined>();

export const liveGateway: PayoutGateway = {
  async resolveNet(entry) {
    if (typeof entry.netAmount === "number") return entry.netAmount;
    if (!entry.paymentIntentId) return null;
    try {
      const s = getStripe();
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
      let net = bt.net;

      // Refunds each get their own (negative) balance transaction. Summing the
      // real transactions rather than subtracting refund.amount matters because
      // whether a refund returns the processing fee varies by region, and whether
      // it returns our application fee depends on refund_application_fee.
      if (charge.amount_refunded > 0) {
        const refunds = await s.refunds.list({ charge: charge.id, limit: 100 }, opts);
        for (const r of refunds.data) {
          const rBtId =
            typeof r.balance_transaction === "string"
              ? r.balance_transaction
              : r.balance_transaction?.id;
          if (!rBtId) continue;
          const rBt = await s.balanceTransactions.retrieve(rBtId, {}, opts);
          net += rBt.net; // negative
        }
      }
      return net;
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
    amount: 0,
    forcedByCeiling: false,
  };

  // Defensive: this is exported, so a caller could hand us a stale list. Paying
  // out an already-released entry is the worst bug available here.
  entries = entries.filter((e) => e.status === "held");
  if (entries.length === 0) return outcome;

  const country = await gateway.accountCountry(stripeAccountId);
  const nowMs = now.getTime();

  // Which entries are due, and why. The ceiling is a compliance deadline: past it
  // we must pay out even though the event hasn't happened.
  const due: Array<{ entry: PayoutLedgerEntry; forced: boolean }> = [];
  for (const entry of entries.slice().sort(byAge)) {
    const eventDue = nowMs >= new Date(entry.releaseAfter).getTime();
    const ceiling = holdCeilingAt(entry.recordedAt, country);
    const ceilingHit = nowMs >= new Date(ceiling).getTime();
    if (eventDue || ceilingHit) due.push({ entry, forced: ceilingHit && !eventDue });
  }
  if (due.length === 0) return outcome;

  // Resolve what each sale is actually worth, voiding anything a refund has
  // already emptied. An unresolvable entry stays held — never guessed at.
  const payable: Array<{ entry: PayoutLedgerEntry; net: number; forced: boolean }> = [];
  for (const { entry, forced } of due) {
    const net = await gateway.resolveNet(entry);
    if (net === null) {
      outcome.deferred.push(entry.sessionId);
      continue;
    }
    if (net !== entry.netAmount) setNetAmount(entry.sessionId, net);
    if (net <= 0) {
      markVoid(entry.sessionId, "no net proceeds — refunded or fees exceeded takings");
      outcome.voided.push(entry.sessionId);
      continue;
    }
    payable.push({ entry, net, forced });
  }
  if (payable.length === 0) return outcome;

  const available = await gateway.availableBalance(stripeAccountId, currency);
  if (available === null) {
    outcome.error = "balance unavailable";
    outcome.deferred.push(...payable.map((p) => p.entry.sessionId));
    return outcome;
  }

  // Select BEFORE paying: take entries oldest-first while they still fit inside
  // the settled balance. Anything that doesn't fit stays held for the next sweep
  // (funds in `pending` haven't settled yet — that is normal, not an error).
  const selected: typeof payable = [];
  let total = 0;
  for (const p of payable) {
    if (total + p.net > available) break;
    selected.push(p);
    total += p.net;
  }
  const notSelected = payable.slice(selected.length);
  outcome.deferred.push(...notSelected.map((p) => p.entry.sessionId));

  if (selected.length === 0 || total <= 0) {
    console.log(
      `[payout-release] ${stripeAccountId} ${currency}: ${payable.length} due but ` +
        `available=${available} — deferring to next sweep`,
    );
    return outcome;
  }

  const sessionIds = selected.map((p) => p.entry.sessionId);
  const forced = selected.some((p) => p.forced);
  outcome.forcedByCeiling = forced;

  try {
    const payoutId = await gateway.createPayout({
      stripeAccountId,
      amount: total,
      currency,
      idempotencyKey: idempotencyKeyFor(sessionIds),
      description: forced
        ? "WoCo release (Stripe hold limit reached)"
        : "WoCo post-event release",
      metadata: {
        woco_sales: String(sessionIds.length),
        woco_first_session: sessionIds[0]!.slice(0, 60),
        ...(forced ? { woco_forced_by_hold_ceiling: "true" } : {}),
      },
    });

    for (const p of selected) {
      markReleased(p.entry.sessionId, payoutId, { forcedByCeiling: p.forced });
    }
    outcome.released = sessionIds;
    outcome.amount = total;
    outcome.payoutId = payoutId;

    console.log(
      `[payout-release] Paid out ${total} ${currency} to ${stripeAccountId} ` +
        `(payout=${payoutId}, sales=${sessionIds.length}${forced ? ", CEILING-FORCED" : ""})`,
    );
    if (forced) {
      console.warn(
        `[payout-release] ⚠️ ${stripeAccountId}: released BEFORE the event because Stripe's ` +
          `${country ?? "default"} hold ceiling was reached. Attendee funds are no longer held.`,
      );
    }
  } catch (err) {
    // Left held deliberately. Re-running re-selects the same set and replays the
    // same idempotency key, so a payout that actually succeeded is not duplicated.
    outcome.error = err instanceof Error ? err.message : String(err);
    outcome.deferred.push(...sessionIds);
    console.error(`[payout-release] Payout FAILED for ${stripeAccountId} ${currency}:`, err);
  }

  return outcome;
}

/** Group every held entry by account + currency and release what is due. */
export async function runReleaseSweep(
  gateway: PayoutGateway = liveGateway,
  now: Date = new Date(),
): Promise<ReleaseOutcome[]> {
  const held = listHeld();
  if (held.length === 0) return [];

  const groups = new Map<string, PayoutLedgerEntry[]>();
  for (const e of held) {
    const key = `${e.stripeAccountId}|${e.currency}`;
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
  }

  const outcomes: ReleaseOutcome[] = [];
  for (const [key, entries] of groups) {
    const [stripeAccountId, currency] = key.split("|") as [string, string];
    try {
      outcomes.push(await releaseForAccount(stripeAccountId, currency, entries, gateway, now));
    } catch (err) {
      console.error(`[payout-release] Sweep failed for ${key}:`, err);
    }
  }
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
export function payoutSweepHealth(): {
  running: boolean;
  lastRunAt: string | null;
  runs: number;
  stale: boolean;
  lastError: string | null;
} {
  const running = timer !== null;
  // Two-and-a-half missed hourly runs. Measured from boot until the first run
  // completes, so a job that never runs at all still trips the alarm.
  const since = health.lastRunAt ?? health.startedAt;
  const stale = running && Date.now() - new Date(since).getTime() > RELEASE_INTERVAL_MS * 2.5;
  return { running, lastRunAt: health.lastRunAt, runs: health.runs, stale, lastError: health.lastError };
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
