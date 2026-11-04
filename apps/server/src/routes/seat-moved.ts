/**
 * POST /api/events/:id/seat-moved  { seriesId, slots: number[], to }
 *
 * After an organiser changes tickets' seats, email their buyer the new seats. The rules
 * are in `lib/seating/seat-moved.ts`; this file only speaks HTTP and wires the stores.
 */

import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { FEATURES } from "@woco/shared";
import { requireAuth } from "../middleware/auth.js";
import { getRecordedFeedSigner } from "../lib/event/feed-signer-record.js";
import { getEvent } from "../lib/event/service.js";
import { listSalesForEvent } from "../lib/stripe/ticket-sales.js";
import { getOrderRecord } from "../lib/attendee-batch/ledger.js";
import { hashEmail } from "../lib/event/claim-service.js";
import { currentTicketSeats } from "../lib/seating/ticket-seats.js";
import { seatMoved, seatMovedState, type SeatMovedDeps } from "../lib/seating/seat-moved.js";
import { sendSeatChangedEmail } from "./tickets.js";
import { errorClass } from "../lib/http/error-class.js";

export const liveSeatMovedDeps: SeatMovedDeps = {
  recordedCreator: (eventId) => getRecordedFeedSigner(eventId)?.creatorAddress.toLowerCase() ?? null,
  seatedAllowed: () => FEATURES.seatedEventsAllowed,
  event: async (eventId) => getEvent(eventId),
  saleOf: (eventId, seriesId, onChainEventId, slot) =>
    listSalesForEvent(eventId).find(
      (s) => s.seriesId === seriesId && s.onChainEventId?.toLowerCase() === onChainEventId && s.slots.includes(slot) && !s.tampered,
    ) ?? null,
  order: (orderRef) => {
    const r = getOrderRecord(orderRef);
    return r ? { ...(r.emailHash ? { emailHash: r.emailHash } : {}), erased: !!r.burnedAt || !!r.erasedBy } : null;
  },
  hashEmail,
  currentSeats: (a) => currentTicketSeats(a),
  send: (a) => sendSeatChangedEmail(a),
  now: () => Date.now(),
};

export function seatMovedRoutes(deps: SeatMovedDeps = liveSeatMovedDeps, state = seatMovedState()): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.post("/:id/seat-moved", requireAuth, async (c) => {
    const body = (c.get("body") as Record<string, unknown> | undefined) ?? (await c.req.json<Record<string, unknown>>().catch(() => null));
    if (!body || typeof body !== "object") return c.json({ ok: false, error: "Expected a JSON body", code: "BAD_BODY" }, 400);
    try {
      const v = await seatMoved(deps, state, c.req.param("id"), c.get("parentAddress") as string, body);
      return v.ok ? c.json({ ok: true, data: v.data }) : c.json({ ok: false, error: v.error, code: v.code }, v.status);
    } catch (err) {
      console.error("[seat-moved] failed:", errorClass(err));
      return c.json({ ok: false, error: "Could not send the email" }, 500);
    }
  });
  return r;
}
