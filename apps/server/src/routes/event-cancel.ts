/**
 * Cancel an event and refund everyone (#644) — organiser routes, mounted under
 * /api/events:
 *
 *   POST /:id/cancel        { confirmTitle }  cancel (one-way) and start the refunds
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
import { getEventForOwner } from "../lib/event/service.js";
import { getStripeAccount } from "../lib/stripe/accounts.js";
import { cancelEvent, organiserCancelClosed } from "../lib/event/cancel-event.js";
import { liveCancelEventDeps } from "../lib/event/cancel-event-live.js";
import { cancellationGate, cancellationProgress, withCancellation } from "../lib/event/cancellations.js";

export const eventCancel = new Hono<AppEnv>();

async function loadOwned(c: Context<AppEnv>, eventId: string) {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const event = await getEventForOwner(eventId, parentAddress).catch(() => null);
  if (!event) return { error: c.json({ ok: false, error: "Event not found" }, 404) };
  if (event.creatorAddress.toLowerCase() !== parentAddress) {
    return { error: c.json({ ok: false, error: "Only the event organiser can cancel it" }, 403) };
  }
  return { event, parentAddress };
}

eventCancel.post("/:id/cancel", requireAuth, async (c) => {
  const eventId = c.req.param("id");
  const { event, parentAddress, error } = await loadOwned(c, eventId);
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

  const body = (c.get("body") ?? {}) as { confirmTitle?: unknown };
  // Compared the way a person reads it: a title pasted with a non-breaking space
  // or a different Unicode form is the same title.
  const norm = (s: string) => s.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (typeof body.confirmTitle !== "string" || norm(body.confirmTitle) !== norm(event.title)) {
    return c.json({ ok: false, error: "Type the event name exactly as it appears to confirm" }, 400);
  }

  const result = cancelEvent(
    {
      eventId,
      by: `organiser:${parentAddress}`,
      organiserAccount: getStripeAccount(parentAddress)?.stripeAccountId,
    },
    liveCancelEventDeps,
  );
  if (!result.ok) {
    return c.json({ ok: false, error: "The cancellation could not be saved, so nothing has changed. Try again shortly." }, 503);
  }
  return c.json({
    ok: true,
    data: {
      eventId,
      created: result.created,
      progress: cancellationProgress(eventId),
      eventFeed: withCancellation(event),
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
