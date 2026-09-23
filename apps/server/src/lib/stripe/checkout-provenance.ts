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
 *     we are.
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
 *  - unverifiable  -> Stripe could not be asked. Retry; decide nothing.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

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
  const meta = Object.keys(f.metadata)
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
  /** The ApplicationFee id on the charge the PaymentIntent settled with, or null when there is none. */
  applicationFeeIdForPaymentIntent(paymentIntentId: string, account: string): Promise<string | null>;
  /** Our fee by id with the PLATFORM key; null when Stripe says it does not exist (not ours). */
  retrievePlatformFee(feeId: string): Promise<{ amount: number; account: string } | null>;
}

export async function classifyPaidSession(
  session: PaidSessionView,
  eventAccount: string | null | undefined,
  reads: ProvenanceReads,
): Promise<ProvenanceVerdict> {
  if (!eventAccount) {
    return { kind: "foreign", reason: "event has no connected account" };
  }
  const piId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
  if (!piId) return { kind: "foreign", reason: "session has no payment intent" };

  let feeId: string | null;
  let fee: { amount: number; account: string } | null;
  try {
    feeId = await reads.applicationFeeIdForPaymentIntent(piId, eventAccount);
    if (!feeId) return { kind: "foreign", reason: "no application fee on the charge" };
    fee = await reads.retrievePlatformFee(feeId);
  } catch (err) {
    return { kind: "unverifiable", reason: err instanceof Error ? err.name : "read failed" };
  }
  if (!fee) return { kind: "foreign", reason: "application fee is not this platform's" };

  // From here the sale is provably ours: our platform collected the fee on it.
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

export function noteProvenanceVerdict(v: ProvenanceVerdict): void {
  if (v.kind !== "ours") counts[v.kind]++;
}

/**
 * `/api/health` section. A tampered session is the alarm: one of our sessions
 * was altered after creation. Foreign sessions are normal on `full` accounts (an
 * organiser's own sales) and are counted, not alarmed.
 */
export function checkoutProvenanceHealth(): { ok: boolean; foreign: number; tampered: number; unverifiable: number } {
  return { ok: counts.tampered === 0, ...counts };
}

/** Tests only. */
export function _resetProvenanceCountsForTest(): void {
  counts.foreign = 0;
  counts.tampered = 0;
  counts.unverifiable = 0;
}
