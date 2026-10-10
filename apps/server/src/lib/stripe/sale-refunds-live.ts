/**
 * The Stripe side of the refund handlers (#645 part C). Kept apart from the
 * decision logic in sale-refunds.ts so that is testable without Stripe.
 */

import { getStripe } from "./client.js";
import { liveProvenanceReads, readLatestCharge } from "./checkout-provenance-live.js";
import type { SaleRefundReads } from "./sale-refunds.js";

export const liveSaleRefundReads: SaleRefundReads = {
  latestCharge: readLatestCharge,

  async refundsForCharge(chargeId, account) {
    const out: Array<{ amount: number; status: string | null }> = [];
    // Every page: a total that missed a page could read a full refund as partial.
    for await (const r of getStripe().refunds.list({ charge: chargeId, limit: 100 }, { stripeAccount: account })) {
      out.push({ amount: r.amount, status: r.status });
    }
    return out;
  },

  retrievePlatformFee: liveProvenanceReads.retrievePlatformFee,

  async disputesForCharge(chargeId, account) {
    const out: Array<{ status: string }> = [];
    for await (const d of getStripe().disputes.list({ charge: chargeId, limit: 100 }, { stripeAccount: account })) {
      out.push({ status: d.status });
    }
    return out;
  },
};
