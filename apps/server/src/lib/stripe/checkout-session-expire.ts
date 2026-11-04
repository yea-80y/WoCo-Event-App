/**
 * Close a seated hold's Checkout Session at Stripe before its seats go back on sale
 * (docs/SEATING.md "Selling a seat"). Stripe's expire call works only on an `open`
 * session, after which it cannot be completed; on any failure the session is read
 * back, because "already expired" is a success here and "complete" is a sale.
 * Anything else (Stripe unreachable) is "error": the hold stays, nothing is released.
 */

import type { HoldCheckout, SessionExpiry } from "../event/reservation-store.js";
import { getStripe } from "./client.js";

export interface SessionApi {
  expire(sessionId: string, account: string): Promise<unknown>;
  status(sessionId: string, account: string): Promise<string | null | undefined>;
}

const liveApi: SessionApi = {
  expire: (id, account) => getStripe().checkout.sessions.expire(id, {}, { stripeAccount: account }),
  status: async (id, account) => (await getStripe().checkout.sessions.retrieve(id, {}, { stripeAccount: account })).status,
};

export async function expireCheckoutSession(c: HoldCheckout, api: SessionApi = liveApi): Promise<SessionExpiry> {
  try {
    await api.expire(c.sessionId, c.account);
    return "expired";
  } catch (err) {
    try {
      const status = await api.status(c.sessionId, c.account);
      if (status === "expired") return "expired";
      if (status === "complete") return "complete";
    } catch {
      // Unreachable twice: say so, release nothing.
    }
    console.warn(`[checkout-expire] could not close ${c.sessionId}:`, err instanceof Error ? err.message : String(err));
    return "error";
  }
}
