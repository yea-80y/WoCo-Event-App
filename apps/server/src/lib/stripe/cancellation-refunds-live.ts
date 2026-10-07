/**
 * Production wiring for the cancellation refunds (#644). Kept apart from the
 * pass logic in cancellation-refunds.ts so that is testable without Stripe.
 */

import { getStripe } from "./client.js";
import { readLatestCharge } from "./checkout-provenance-live.js";
import { liveSaleRefundReads } from "./sale-refunds-live.js";
import { reconcileChargeEvent } from "./sale-refunds.js";
import { listSalesForEvent } from "./ticket-sales.js";
import { listEntriesForEvent } from "./payout-ledger.js";
import type { CancellationRefundDeps } from "./cancellation-refunds.js";
import { setRefundNotice } from "../event/cancellations.js";
import { hashEmail } from "../event/claim-service.js";
import { getRecordedFeedSigner } from "../event/feed-signer-record.js";
import { suppressionSources } from "../marketing/suppression-store.js";
import { getFromAddress } from "../email/client.js";
import { sendEmail } from "../email/send.js";

export const liveCancellationRefundDeps: CancellationRefundDeps = {
  saleSessionsFor(eventId) {
    // Both stores, by session: the sale record is written at webhook consume,
    // the payout ledger at fulfilment before minting. Either alone can miss a
    // sale whose write failed; the union misses only a sale both failed on.
    const out = new Map<string, { sessionId: string; paymentIntentId: string; account: string }>();
    for (const s of listSalesForEvent(eventId)) {
      out.set(s.sessionId, { sessionId: s.sessionId, paymentIntentId: s.paymentIntentId, account: s.connectedAccountId });
    }
    for (const e of listEntriesForEvent(eventId)) {
      if (!out.has(e.sessionId) && e.paymentIntentId) {
        out.set(e.sessionId, { sessionId: e.sessionId, paymentIntentId: e.paymentIntentId, account: e.stripeAccountId });
      }
    }
    return [...out.values()];
  },

  async latestCharge(paymentIntentId, account) {
    const charge = await readLatestCharge(paymentIntentId, account);
    return charge ? { id: charge.id, amount: charge.amount, currency: charge.currency ?? "", disputed: charge.disputed } : null;
  },

  async refundsForCharge(chargeId, account) {
    const out: Array<{ amount: number; status: string | null; pendingReason?: string | null }> = [];
    for await (const r of getStripe().refunds.list({ charge: chargeId, limit: 100 }, { stripeAccount: account })) {
      out.push({ amount: r.amount, status: r.status, pendingReason: r.pending_reason ?? null });
    }
    return out;
  },

  async disputesForCharge(chargeId, account) {
    const out: Array<{ status: string; amount: number }> = [];
    for await (const d of getStripe().disputes.list({ charge: chargeId, limit: 100 }, { stripeAccount: account })) {
      out.push({ status: d.status, amount: d.amount });
    }
    return out;
  },

  async createRefund(params, account, idempotencyKey) {
    const refund = await getStripe().refunds.create(
      {
        payment_intent: params.paymentIntentId,
        amount: params.amount,
        reason: "requested_by_customer",
        refund_application_fee: params.feeReturned,
        // `sessionId` under exactly this key: the #367 retry job recognises a
        // refund of this session by it, so the two paths converge, never double.
        metadata: { woco_cancel: params.eventId, sessionId: params.sessionId },
      },
      { stripeAccount: account, idempotencyKey },
    );
    return { id: refund.id, status: refund.status, pendingReason: refund.pending_reason ?? null };
  },

  async reconcile(paymentIntentId, account) {
    await reconcileChargeEvent({ paymentIntentId, account }, liveSaleRefundReads);
  },

  notice: {
    // The address the buyer paid with, read from Stripe each time and never
    // kept (#798). Never `metadata.claimerEmail`: that is the unverified body
    // value, and #749 removes it.
    async buyerEmail(sessionId, account) {
      const session = await getStripe().checkout.sessions.retrieve(sessionId, {}, { stripeAccount: account });
      return session.customer_details?.email || session.customer_email || null;
    },
    hashEmail,
    suppressionSources,
    organiserOf: (eventId) => getRecordedFeedSigner(eventId)?.creatorAddress.toLowerCase() ?? "",
    async send(to, message, context) {
      await sendEmail(
        { from: getFromAddress(), to: [to], ...message },
        { priority: "transactional", addressFree: true, context },
      );
    },
    setNotice: (eventId, sessionId, notice) => {
      setRefundNotice(eventId, sessionId, notice);
    },
    now: () => new Date(),
  },
};
