/** Production wiring for cancelEvent (#644). */

import { getStripe } from "../stripe/client.js";
import { setListed } from "./listing-state.js";
import { scheduleSnapshotRebuild } from "./directory-snapshot.js";
import { invalidateEventCache } from "./service.js";
import { kickCancellationRefunds } from "../stripe/cancellation-refunds.js";
import { liveCancellationRefundDeps } from "../stripe/cancellation-refunds-live.js";
import type { CancelEventDeps } from "./cancel-event.js";

export const liveCancelEventDeps: CancelEventDeps = {
  unlist(eventId) {
    setListed(eventId, false);
    scheduleSnapshotRebuild(eventId);
  },
  invalidateCaches(eventId) {
    invalidateEventCache(eventId);
  },
  kickRefunds() {
    void kickCancellationRefunds(liveCancellationRefundDeps).catch(() => undefined);
  },
  async expireOpenSessions(eventId, account) {
    const s = getStripe();
    let expired = 0;
    // Checkout Sessions live at most 24 hours, so older open ones cannot exist.
    // The extra 10 minutes covers clock skew between us and Stripe.
    const since = Math.floor(Date.now() / 1000) - 24 * 60 * 60 - 10 * 60;
    for await (const session of s.checkout.sessions.list(
      { status: "open", created: { gte: since }, limit: 100 },
      { stripeAccount: account },
    )) {
      if (session.metadata?.eventId !== eventId) continue;
      try {
        await s.checkout.sessions.expire(session.id, {}, { stripeAccount: account });
        expired++;
      } catch (err) {
        // Already completed or expired in the meantime: fulfilment refunds a paid one.
        console.warn(`[cancel-event] could not expire ${session.id}:`, err instanceof Error ? err.message : err);
      }
    }
    return expired;
  },
};
