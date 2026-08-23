/**
 * Production `RefundGateway` for the pending-refund retry (#367). Kept apart
 * from the decision logic so the retry can be tested without Stripe.
 */

import { getStripe } from "./client.js";
import { markVoid } from "./payout-ledger.js";
import type { RefundGateway } from "./pending-refunds.js";

export const liveRefundGateway: RefundGateway = {
  async findRefundBySession(paymentIntentId, connectedAccountId, sessionId) {
    try {
      const s = getStripe();
      // Direct charge: the refunds live on the connected account. 100 is the
      // API maximum and far beyond any one intent's refund count.
      const page = await s.refunds.list(
        { payment_intent: paymentIntentId, limit: 100 },
        connectedAccountId ? { stripeAccount: connectedAccountId } : undefined,
      );
      const found = page.data.find((r) => r.metadata?.sessionId === sessionId);
      return { refundId: found?.id ?? null };
    } catch (err) {
      // "Could not ask" is not "no": the caller skips this round.
      console.error(`[pending-refunds] could not list refunds for ${paymentIntentId}:`, err);
      return null;
    }
  },

  async createRefund(params, connectedAccountId, idempotencyKey) {
    const s = getStripe();
    const refund = await s.refunds.create(params, {
      ...(connectedAccountId ? { stripeAccount: connectedAccountId } : {}),
      idempotencyKey,
    });
    return { id: refund.id };
  },

  markPayoutVoid: markVoid,
};
