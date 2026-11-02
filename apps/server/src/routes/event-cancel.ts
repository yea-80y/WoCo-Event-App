/**
 * Cancel an event and refund everyone (#644) — organiser routes, mounted under
 * /api/events:
 *
 *   POST /:id/cancel        { confirmTitle, chainCancels? }  cancel (one-way) and start the refunds;
 *                           a ledger2 event's signed cancels are checked first, then relayed
 *                           after the record (`lib/event/cancel-on-chain.ts`)
 *   GET  /:id/cancellation                   progress: counts and totals, no buyer data
 *
 * The id that keys every store is the ROUTE PARAM ownership was resolved
 * against, never a field of the feed body (#389). The organiser types the
 * event's name to confirm; the server checks it too, so a stray call cannot
 * cancel an event. The response carries the feed with `cancelledAt` for the
 * organiser to re-sign (Phase B); every API read overlays it anyway. The
 * organiser's window closes ORGANISER_CANCEL_WINDOW_DAYS after the event ends;
 * the ops route has none.
 */

import { Hono, type Context } from "hono";
import { ORGANISER_CANCEL_WINDOW_DAYS } from "@woco/shared";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { getEventForOwnerRead } from "../lib/event/service.js";
import { getStripeAccount } from "../lib/stripe/accounts.js";
import { cancelEvent, organiserCancelClosed } from "../lib/event/cancel-event.js";
import { liveCancelEventDeps } from "../lib/event/cancel-event-live.js";
import { cancellationGate, cancellationProgress, withCancellation } from "../lib/event/cancellations.js";
import { cancelEventWithChain } from "../lib/event/cancel-on-chain.js";
import { liveLedger2RelayDeps } from "../lib/event/ledger2-relay-live.js";
import { SlidingWindowLimiter } from "../lib/http/rate-limit.js";
import { refusalResponse } from "./ledger2-relay.js";

export const eventCancel = new Hono<AppEnv>();

/** The on-chain half's gas: its own budget, apart from capacity and date changes. */
const chainCancelLimit = new SlidingWindowLimiter([{ limit: 5, windowMs: 60 * 60_000 }]);

/** `fresh` only where the feed may go back to the organiser to sign (#657). */
async function loadOwned(c: Context<AppEnv>, eventId: string, opts: { fresh?: boolean } = {}) {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const { feed: event, resignable } = await getEventForOwnerRead(eventId, parentAddress, opts)
    .catch(() => ({ feed: null, resignable: false }));
  if (!event) return { error: c.json({ ok: false, error: "Event not found" }, 404) };
  if (event.creatorAddress.toLowerCase() !== parentAddress) {
    return { error: c.json({ ok: false, error: "Only the event organiser can cancel it" }, 403) };
  }
  return { event, parentAddress, resignable };
}

eventCancel.post("/:id/cancel", requireAuth, async (c) => {
  const eventId = c.req.param("id");
  const { event, parentAddress, resignable, error } = await loadOwned(c, eventId, { fresh: true });
  if (error) return error;
  if (event.deleted) return c.json({ ok: false, error: "This event was deleted" }, 409);
  if (organiserCancelClosed(event, cancellationGate(eventId), Date.now())) {
    return c.json(
      {
        ok: false,
        error: `This event ended more than ${ORGANISER_CANCEL_WINDOW_DAYS} days ago, so it can no longer be cancelled. You can still refund individual buyers from your Stripe Dashboard.`,
      },
      409,
    );
  }

  const body = (c.get("body") ?? {}) as { confirmTitle?: unknown; chainCancels?: unknown };
  // Compared the way a person reads it: a title pasted with a non-breaking space
  // or a different Unicode form is the same title.
  const norm = (s: string) => s.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (typeof body.confirmTitle !== "string" || norm(body.confirmTitle) !== norm(event.title)) {
    return c.json({ ok: false, error: "Type the event name exactly as it appears to confirm" }, 400);
  }

  // Ledger2 events also cancel on chain, by the organiser key's signatures. Signed
  // cancels are checked BEFORE the record is written (`cancel-on-chain.ts`).
  // Its own gas budget, which never refuses the cancellation itself: over it, the
  // record is written and the chain half waits for "Finish cancelling".
  const signed = Array.isArray(body.chainCancels) && body.chainCancels.length > 0;
  const chainAllowed = !signed || chainCancelLimit.peek(parentAddress);
  if (signed && chainAllowed) chainCancelLimit.record(parentAddress);
  const outcome = await cancelEventWithChain(
    {
      eventId,
      parent: parentAddress,
      seriesIds: event.series.map((s) => s.seriesId),
      chainCancels: body.chainCancels,
      chainAllowed,
      record: () =>
        cancelEvent(
          {
            eventId,
            by: `organiser:${parentAddress}`,
            organiserAccount: getStripeAccount(parentAddress)?.stripeAccountId,
            title: event.title,
          },
          liveCancelEventDeps,
        ),
    },
    liveLedger2RelayDeps,
  );
  if (outcome.kind === "refused") return refusalResponse(c, outcome.refusal);
  const result = outcome.recorded;
  if (!result.ok) {
    return c.json({ ok: false, error: "The cancellation could not be saved, so nothing has changed. Try again shortly." }, 503);
  }
  return c.json({
    ok: true,
    data: {
      eventId,
      created: result.created,
      ...(outcome.chain ? { chain: outcome.chain } : {}),
      progress: cancellationProgress(eventId),
      // The cancellation stands either way - it lives in the server's record. The
      // feed goes back for the organiser to re-sign only when it was read as the
      // head; otherwise their page shows the banner once a re-sign can (#657).
      ...(resignable ? { eventFeed: withCancellation(event) } : {}),
    },
  });
});

eventCancel.get("/:id/cancellation", requireAuth, async (c) => {
  const eventId = c.req.param("id");
  const { error } = await loadOwned(c, eventId);
  if (error) return error;
  const progress = cancellationProgress(eventId);
  return c.json({ ok: true, data: progress ? { cancelled: true, ...progress } : { cancelled: false } });
});
