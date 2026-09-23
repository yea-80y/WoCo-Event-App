/**
 * The Stripe side of checkout provenance (#645): the two reads the classifier
 * needs, and the refund a tampered session gets. Kept apart from the pure
 * classifier so its verdict logic is testable without Stripe.
 */

import type Stripe from "stripe";
import { getStripe } from "./client.js";
import type { ProvenanceReads } from "./checkout-provenance.js";
import { idempotencyKeyFor, recordPendingRefund } from "./pending-refunds.js";

/** Stripe's answer for a fee that is not this platform's: missing, or not ours to read. */
function isNotOurs(err: unknown): boolean {
  const e = err as { code?: string; type?: string; statusCode?: number } | null;
  return (
    e?.code === "resource_missing" ||
    e?.statusCode === 404 ||
    e?.statusCode === 403 ||
    e?.type === "StripePermissionError"
  );
}

export const liveProvenanceReads: ProvenanceReads = {
  async applicationFeeIdForPaymentIntent(paymentIntentId, account) {
    const s = getStripe();
    const pi = await s.paymentIntents.retrieve(
      paymentIntentId,
      { expand: ["latest_charge"] },
      { stripeAccount: account },
    );
    let charge = pi.latest_charge;
    if (!charge) return null;
    if (typeof charge === "string") {
      charge = await s.charges.retrieve(charge, {}, { stripeAccount: account });
    }
    const fee = (charge as Stripe.Charge).application_fee;
    if (!fee) return null;
    return typeof fee === "string" ? fee : fee.id;
  },

  async retrievePlatformFee(feeId) {
    try {
      // Platform key, no Stripe-Account header: Stripe returns only fees this
      // platform collected. Anyone else's fee id is "missing" to us.
      const fee = await getStripe().applicationFees.retrieve(feeId);
      return { amount: fee.amount, account: typeof fee.account === "string" ? fee.account : fee.account.id };
    } catch (err) {
      if (isNotOurs(err)) return null;
      throw err;
    }
  },
};

/**
 * Refund a session we created but that was altered after creation. The buyer
 * paid for something we will not issue, so they get everything back, our fee
 * included. The account comes from the webhook event, never from metadata - the
 * metadata is exactly what failed its check. A refund Stripe refuses joins the
 * pending-refund queue, with the same idempotency key, so it is retried rather
 * than lost.
 */
export async function refundTamperedSession(input: {
  sessionId: string;
  paymentIntentId: string;
  account: string;
  reason: string;
  metadata: Record<string, string>;
}): Promise<void> {
  try {
    await getStripe().refunds.create(
      { payment_intent: input.paymentIntentId, refund_application_fee: true },
      { stripeAccount: input.account, idempotencyKey: idempotencyKeyFor(input.sessionId) },
    );
    console.error(
      `[checkout-provenance] REFUNDED tampered session ${input.sessionId} on ${input.account}: ${input.reason}`,
    );
  } catch (err) {
    console.error(`[checkout-provenance] refund of tampered session ${input.sessionId} failed - queued:`, err);
    recordPendingRefund({
      sessionId: input.sessionId,
      paymentIntentId: input.paymentIntentId,
      connectedAccountId: input.account,
      reason: `tampered checkout session: ${input.reason}`,
      metadata: input.metadata,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
