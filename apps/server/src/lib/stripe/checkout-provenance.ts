/**
 * Is this paid Checkout Session one WE created, unaltered? (#645)
 *
 * The webhook's "Connected accounts" endpoint delivers `checkout.session.completed`
 * for every session on every connected account, and fulfilment acts on the
 * session's metadata: which event to mint, how many tickets, for whom. That used
 * to be sound only because organisers had no Stripe Dashboard and no API keys
 * (`stripe_dashboard.type = "none"`), so nobody but us could create a session or
 * write its metadata. Under `full` an organiser has both. So trust now rests on
 * two things neither the organiser nor anyone else can produce:
 *
 *  1. PROVENANCE. We set `application_fee_amount` on every session we create, so
 *     every sale of ours carries an ApplicationFee object owned by our platform.
 *     `applicationFees.retrieve` with the platform key succeeds only for OUR fees,
 *     so a fee we can read, on the charge the session paid, proves the session
 *     came from this platform. No configuration is needed to know which platform
 *     we are. Stripe creates that object a few seconds AFTER it sends
 *     `checkout.session.completed` (#666), so a fee the charge requested but does
 *     not carry yet is waited for, never read as "not ours".
 *  2. INTEGRITY. A tag in `client_reference_id` - which Stripe does not let a
 *     session update change - is an HMAC over everything fulfilment acts on:
 *     the connected account, the currency and amounts, our fee, and every
 *     metadata field. Anything altered after creation fails it.
 *
 * Four verdicts, never collapsed (the same rule as ticket verification):
 *  - ours          -> fulfil.
 *  - foreign       -> not created by this platform. Ignore, count, NEVER refund:
 *                     it is the organiser's own sale, not ours to reverse.
 *  - tampered      -> created by us, altered after. Refund the buyer and alarm.
 *  - unverifiable  -> Stripe could not be asked, or has not created our fee yet.
 *                     Retry; decide nothing.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { setTimeout as defaultSleep } from "node:timers/promises";

export const CHECKOUT_TAG_PREFIX = "woco1.";

/** Everything the tag commits to, known when the session is created. */
export interface CheckoutTagFields {
  /** The connected account the session lives on. */
  account: string;
  /** ISO currency, compared lowercase. */
  currency: string;
  /** Minor units. With no tax, discounts or shipping, subtotal equals total. */
  amountSubtotal: number;
  amountTotal: number;
  /** Our application fee, minor units. */
  applicationFee: number;
  metadata: Record<string, string>;
}

function tagKey(): Buffer {
  // Derived from an existing mandatory secret (the server refuses to boot in
  // production without it, index.ts), domain-separated so a checkout tag can
  // never be confused with a payment quote signature.
  const secret = process.env.PAYMENT_QUOTE_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("PAYMENT_QUOTE_SECRET is missing or too short - checkout sessions cannot be tagged.");
  }
  return createHmac("sha256", secret).update("woco/checkout-tag/v1").digest();
}

function canonical(f: CheckoutTagFields): string {
  // An empty value is left out on both sides: Stripe documents "" as the way to
  // REMOVE a metadata key, so a key we send empty may come back absent, and the
  // two must tag alike or every such sale would read as tampered.
  const meta = Object.keys(f.metadata)
    .filter((k) => f.metadata[k] !== "")
    .sort()
    .map((k) => [k, f.metadata[k]]);
  return JSON.stringify([
    "woco/checkout-tag/v1",
    f.account,
    f.currency.toLowerCase(),
    f.amountSubtotal,
    f.amountTotal,
    f.applicationFee,
    meta,
  ]);
}

export function signCheckoutTag(f: CheckoutTagFields): string {
  return CHECKOUT_TAG_PREFIX + createHmac("sha256", tagKey()).update(canonical(f)).digest("hex");
}

export function verifyCheckoutTag(tag: string | null | undefined, f: CheckoutTagFields): boolean {
  if (typeof tag !== "string" || !tag.startsWith(CHECKOUT_TAG_PREFIX)) return false;
  const expected = Buffer.from(signCheckoutTag(f));
  const got = Buffer.from(tag);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type ProvenanceVerdict =
  | { kind: "ours" }
  | { kind: "foreign"; reason: string }
  | { kind: "tampered"; reason: string }
  | { kind: "unverifiable"; reason: string };

/** The paid session, as the webhook delivers it. */
export interface PaidSessionView {
  id: string;
  client_reference_id: string | null;
  metadata: Record<string, string> | null;
  currency: string | null;
  amount_subtotal: number | null;
  amount_total: number | null;
  payment_intent: string | { id: string } | null;
}

/** The two Stripe reads the check needs. Throws on a transport failure. */
export interface ProvenanceReads {
  /**
   * The fee state of the charge the PaymentIntent settled with. `requested` is
   * `application_fee_amount > 0`, set when the charge is created; `feeId` is the
   * ApplicationFee, created seconds after `checkout.session.completed` (#666).
   */
  chargeFeeForPaymentIntent(paymentIntentId: string, account: string): Promise<{ requested: boolean; feeId: string | null }>;
  /** Our fee by id with the PLATFORM key; null when Stripe says it does not exist (not ours). */
  retrievePlatformFee(feeId: string): Promise<{ amount: number; account: string } | null>;
}

// 4.5 s of waits: with typical reads the ack lands inside Stripe's 10 s redirect window.
export const FEE_SETTLE_DELAYS_MS: readonly number[] = [1000, 1500, 2000];

/**
 * INVARIANT: every session this platform creates carries a non-zero application
 * fee (`MIN_APPLICATION_FEE_MINOR`, checkout-fees.ts; both create routes refuse
 * below it). A sale of ours with no fee would classify as foreign - charged,
 * never fulfilled, never refunded. Any future no-fee path (free events, a 100%
 * promotion) must change this check first.
 */
export async function classifyPaidSession(
  session: PaidSessionView,
  eventAccount: string | null | undefined,
  reads: ProvenanceReads,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<ProvenanceVerdict> {
  if (!eventAccount) {
    return { kind: "foreign", reason: "event has no connected account" };
  }
  const piId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
  if (!piId) return { kind: "foreign", reason: "session has no payment intent" };

  let fee: { amount: number; account: string } | null;
  try {
    let charge = await reads.chargeFeeForPaymentIntent(piId, eventAccount);
    for (const ms of FEE_SETTLE_DELAYS_MS) {
      if (charge.feeId || !charge.requested) break;
      await sleep(ms);
      charge = await reads.chargeFeeForPaymentIntent(piId, eventAccount);
    }
    // The fee object is the proof; `requested` only says whether to expect one.
    if (!charge.feeId) {
      return charge.requested
        ? { kind: "unverifiable", reason: "application fee not created yet" }
        : { kind: "foreign", reason: "no application fee on the charge" };
    }
    fee = await reads.retrievePlatformFee(charge.feeId);
  } catch (err) {
    return { kind: "unverifiable", reason: err instanceof Error ? err.name : "read failed" };
  }
  if (!fee) return { kind: "foreign", reason: "application fee is not this platform's" };

  // From here the sale is provably ours: our platform collected the fee on it.
  // The charge was read on eventAccount, so its fee is on eventAccount too; this
  // check is defence in depth, not a path we expect to see.
  if (fee.account !== eventAccount) {
    return { kind: "tampered", reason: "our fee was collected on a different account" };
  }
  const intact = verifyCheckoutTag(session.client_reference_id, {
    account: eventAccount,
    currency: session.currency ?? "",
    amountSubtotal: session.amount_subtotal ?? -1,
    amountTotal: session.amount_total ?? -1,
    applicationFee: fee.amount,
    metadata: session.metadata ?? {},
  });
  return intact ? { kind: "ours" } : { kind: "tampered", reason: "integrity tag does not match the session" };
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

const counts = { foreign: 0, tampered: 0, unverifiable: 0 };

/**
 * Sessions whose last verdict was `unverifiable`, keyed by session id, with the
 * time of the first one. Keyed rather than counted: a counter either never
 * alarms or alarms for ever after one transport blip. In memory like the
 * counters - a restart forgets, and Stripe's next retry puts it back.
 */
const unresolvedSince = new Map<string, number>();

/** Past the seat hold the buyer is a support case, whatever Stripe's retry interval. */
export const UNRESOLVED_ALARM_MS = 10 * 60_000;

export function noteProvenanceVerdict(sessionId: string, v: ProvenanceVerdict): void {
  if (v.kind !== "ours") counts[v.kind]++;
  if (v.kind === "unverifiable") {
    if (!unresolvedSince.has(sessionId)) unresolvedSince.set(sessionId, Date.now());
  } else {
    unresolvedSince.delete(sessionId);
  }
}

/**
 * `/api/health` section. Two alarms: a tampered session (one of ours altered
 * after creation), and a session left `unverifiable` for UNRESOLVED_ALARM_MS -
 * a buyer charged whose ticket waits on a Stripe retry (#666). Foreign sessions
 * are normal on `full` accounts (an organiser's own sales) and are counted, not
 * alarmed. Counts only: this endpoint is public, and the ids are in the log.
 */
export function checkoutProvenanceHealth(now = Date.now()): {
  ok: boolean;
  foreign: number;
  tampered: number;
  unverifiable: number;
  unresolved: number;
  stuck: number;
} {
  let stuck = 0;
  for (const since of unresolvedSince.values()) if (now - since >= UNRESOLVED_ALARM_MS) stuck++;
  return { ok: counts.tampered === 0 && stuck === 0, ...counts, unresolved: unresolvedSince.size, stuck };
}

/** Tests only. */
export function _resetProvenanceCountsForTest(): void {
  counts.foreign = 0;
  counts.tampered = 0;
  counts.unverifiable = 0;
  unresolvedSince.clear();
}
