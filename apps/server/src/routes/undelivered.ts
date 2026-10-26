/**
 * The organiser's undelivered tickets (#983): list, open the held copy, resend.
 * The rules are in `lib/ticket-hold/resend.ts`; this file only speaks HTTP.
 *
 *   GET  /api/events/:id/undelivered
 *   GET  /api/events/:id/undelivered/:sessionId/copy
 *   POST /api/events/:id/undelivered/:sessionId/resend   { to, tickets: [{ edition, qrContent }], buyerName? }
 *   GET  /api/undelivered/summary                        (its own mount: one segment under
 *                                                         /api/events would hit the event route)
 */

import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { errorClass } from "../lib/http/error-class.js";
import { heldCopy, listUndelivered, resendTickets, undeliveredSummary, type ResendDeps, type Refusal } from "../lib/ticket-hold/resend.js";
import { liveResendDeps } from "../lib/ticket-hold/resend-live.js";

export function undeliveredRoutes(deps: ResendDeps = liveResendDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const fail = (c: { json: (b: unknown, s: number) => Response }, v: Refusal) =>
    c.json({ ok: false, error: v.error, code: v.code }, v.status);

  r.get("/:id/undelivered", requireAuth, async (c) => {
    try {
      const v = await listUndelivered(deps, c.req.param("id"), c.get("parentAddress"));
      return v.ok ? c.json(v) : fail(c, v);
    } catch (err) {
      console.error("[undelivered] list failed:", err);
      return c.json({ ok: false, error: "Could not load undelivered tickets" }, 500);
    }
  });

  r.get("/:id/undelivered/:sessionId/copy", requireAuth, async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      const v = await heldCopy(deps, c.req.param("id"), c.req.param("sessionId"), c.get("parentAddress"));
      return v.ok ? c.json(v) : fail(c, v);
    } catch (err) {
      console.error("[undelivered] copy failed:", err);
      return c.json({ ok: false, error: "Could not load the held tickets" }, 500);
    }
  });

  r.post("/:id/undelivered/:sessionId/resend", requireAuth, async (c) => {
    const body = await c.req.json<{ to?: unknown; tickets?: unknown; buyerName?: unknown }>().catch(() => null);
    if (!body) return c.json({ ok: false, error: "Expected a JSON body", code: "BAD_BODY" }, 400);
    try {
      const v = await resendTickets(deps, c.req.param("id"), c.req.param("sessionId"), c.get("parentAddress"), {
        to: body.to,
        tickets: body.tickets,
        buyerName: body.buyerName,
      });
      return v.ok ? c.json(v) : fail(c, v);
    } catch (err) {
      console.error("[undelivered] resend failed:", errorClass(err));
      return c.json({ ok: false, error: "Could not resend the tickets" }, 500);
    }
  });

  return r;
}

/** The dashboard index's badge: the caller's events with tickets that did not arrive. */
export function undeliveredSummaryRoutes(deps: ResendDeps = liveResendDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.get("/summary", requireAuth, (c) => c.json({ ok: true, data: undeliveredSummary(deps, c.get("parentAddress")) }));
  return r;
}
