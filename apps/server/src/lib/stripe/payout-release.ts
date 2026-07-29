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
import { holdCeilingAt } from "./payout-policy.js";
import { pendingScheduleHeals, retryPendingScheduleHeals } from "./payout-schedule.js";
import {
  listHeld,
  markManyReleased,
  markVoid,
  setNetAmount,
  type PayoutLedgerEntry,
} from "./payout-ledger.js";
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
   * entry held rather than guessing.
   */
  resolveNet(entry: PayoutLedgerEntry): Promise<{ net: number; currency: string } | null>;
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
): Promise<{ net: number; currency: string } | null> {
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

  // Resolve what each sale is actually worth — fresh from Stripe EVERY sweep,
  // because a refund can land between sweeps and a cached net would pay it out
  // anyway. Voids anything a refund has already emptied; an unresolvable entry
  // stays held — never guessed at.
  const payable: Array<{ entry: PayoutLedgerEntry; net: number; forced: boolean }> = [];
  for (const { entry, forced } of due) {
    const resolved = await gateway.resolveNet(entry);
    if (resolved === null) {
      outcome.deferred.push(entry.sessionId);
      continue;
    }
    const { net, currency: settledIn } = resolved;
    if (net !== entry.netAmount || settledIn !== (entry.settlementCurrency ?? entry.currency)) {
      setNetAmount(entry.sessionId, net, settledIn);
    }
    if (settledIn !== currency) {
      // The charge settled in a different currency than this group is paying
      // (Stripe converted it into the account's default currency). The net is
      // in SETTLEMENT units and must be paid from the settlement balance —
      // defer; the next sweep regroups the entry under the recorded
      // settlementCurrency and releases it from the right pot.
      outcome.deferred.push(entry.sessionId);
      console.warn(
        `[payout-release] ${entry.sessionId}: charged in ${entry.currency} but settled ` +
          `in ${settledIn} — regrouping under the settlement currency next sweep`,
      );
      continue;
    }
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
  outcome.forcedByCeiling = outcome.forcedByCeiling || forced;

  // Journal the intent BEFORE Stripe is called. From here until clearIntent,
  // any crash or ambiguous failure leaves the exact set + key on disk, and the
  // next sweep settles THAT rather than re-deriving a set that may have grown.
  const intent: PayoutIntent = {
    stripeAccountId,
    currency,
    sessionIds,
    forcedSessionIds: selected.filter((p) => p.forced).map((p) => p.entry.sessionId),
    amount: total,
    idempotencyKey: idempotencyKeyFor(sessionIds),
    createdAt: now.toISOString(),
  };
  saveIntent(intent);

  try {
    const payoutId = await gateway.createPayout(payoutArgsFor(intent));

    // One write for the whole set: a per-entry loop interrupted half way would
    // leave already-paid entries "held", i.e. selectable again under a new key.
    markManyReleased(sessionIds, payoutId, { forcedSessionIds: intent.forcedSessionIds });
    clearIntent(stripeAccountId, currency);
    outcome.released.push(...sessionIds);
    outcome.amount += total;
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
    const ceiling = holdCeilingAt(entry.recordedAt, countryCache.get(entry.stripeAccountId));
    if (nowMs < new Date(ceiling).getTime()) continue;
    count++;
    if (!oldest || ceiling < oldest) oldest = ceiling;
  }
  return { count, oldestBreachedAt: oldest };
}

export function payoutSweepHealth(): {
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
} {
  const running = timer !== null;
  // Two-and-a-half missed hourly runs. Measured from boot until the first run
  // completes, so a job that never runs at all still trips the alarm.
  const since = health.lastRunAt ?? health.startedAt;
  const stale = running && Date.now() - new Date(since).getTime() > RELEASE_INTERVAL_MS * 2.5;
  const breached = heldPastCeiling();
  return {
    running,
    lastRunAt: health.lastRunAt,
    runs: health.runs,
    stale,
    lastError: health.lastError,
    heldPastCeiling: breached.count,
    oldestCeilingBreachAt: breached.oldestBreachedAt,
    pendingScheduleHeals: pendingScheduleHeals().length,
  };
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
