/**
 * Attendee gate — prove rightful possession of a purchased ticket to unlock
 * profile creation / sub-ENS / social actions. Design: docs/ATTENDEE_GATE_RESALE_PLAN.md §3.
 *
 *   GET  /api/attendee-gate/status       → { gated, via, bindings }
 *   POST /api/attendee-gate/token-info   → Route A: unauthenticated landing preview
 *   POST /api/attendee-gate/redeem       → Route A: email-CTA token → binding (one-shot)
 *
 * Route B (ticket link + purchase email → code) and /bind-wallet were deleted
 * with the v1 claim rail: both answered "which ClaimedTicket does this
 * account/email hold" from the v1 claims feeds, which on-chain tickets never
 * wrote — every v2 call already dead-ended. The v2 unlock path is the email
 * CTA below; a replacement recovery flow belongs to a new design keyed on the
 * contract (querySlotsOwnedV2 / sealed-order proof), not a resurrection.
 *
 * Security invariants:
 *  - The gate token is an HMAC minted at ticket-email send, to the VERIFIED
 *    purchase email only — possession of the link is the possession proof.
 *  - One edition unlocks exactly one account, ever (gate nullifier — separate
 *    namespace from door check-in).
 */

import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { getEvent } from "../lib/event/service.js";
import { checkAttendeeGate } from "../lib/gate/check.js";
import { verifyGateToken } from "../lib/gate/token.js";
import { bindTicket, getBindingsForParent, isTicketConsumed } from "../lib/gate/store.js";

export const attendeeGate = new Hono<AppEnv>();

const RATE_WINDOW_MS = 15 * 60 * 1000;

function clientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

/** Was this series sold (any price on its payment config)? Feeds the sybil
 *  weighting `paid` flag on the binding — never used for authorisation. */
async function seriesIsPaid(eventId: string, seriesId: string): Promise<boolean> {
  const ev = await getEvent(eventId).catch(() => null);
  const series = ev?.series.find((s) => s.seriesId === seriesId);
  return !!series && series.price > 0;
}

attendeeGate.get("/status", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const status = await checkAttendeeGate(parentAddress);
  const bindings = getBindingsForParent(parentAddress).map((b) => ({
    eventId: b.eventId,
    seriesId: b.seriesId,
    edition: b.edition,
    boundAt: b.boundAt,
  }));
  return c.json({ ok: true, data: { ...status, bindings } });
});

// ---------------------------------------------------------------------------
// Route A — email CTA token (minted at ticket-email send, lib/gate/token.ts)
// ---------------------------------------------------------------------------

// Unauthenticated preview for the signup landing page — shows "you're claiming
// ticket #N for <event>" BEFORE the user creates an account. Read-only; the
// token itself is unforgeable (HMAC), the limiter just caps probing volume.
const INFO_RATE_LIMIT = 30;
const infoAttempts = new Map<string, number[]>();

attendeeGate.post("/token-info", async (c) => {
  const ip = clientIp(c);
  const now = Date.now();
  const recent = (infoAttempts.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= INFO_RATE_LIMIT) {
    return c.json({ ok: false, error: "Too many attempts — try again later" }, 429);
  }
  recent.push(now);
  infoAttempts.set(ip, recent);

  const body = await c.req.json<{ token?: string }>().catch(() => null);
  if (!body?.token) return c.json({ ok: false, error: "token is required" }, 400);

  const verdict = verifyGateToken(body.token);
  if (!verdict.ok) {
    const msg =
      verdict.reason === "expired"
        ? "This link has expired — ask the organiser to resend your ticket email"
        : "This link is not valid";
    return c.json({ ok: false, error: msg }, verdict.reason === "expired" ? 410 : 400);
  }

  const { eventId, seriesId, edition } = verdict.payload;
  const ev = await getEvent(eventId).catch(() => null);
  return c.json({
    ok: true,
    data: {
      eventId,
      seriesId,
      edition,
      eventTitle: ev?.title,
      eventDate: ev?.startDate,
      eventLocation: ev?.location,
      seriesName: ev?.series.find((s) => s.seriesId === seriesId)?.name,
      consumed: isTicketConsumed(seriesId, edition),
    },
  });
});

/** Redeem the email-CTA token against the authed account. One-shot: the gate
 *  binding nullifier is the consumption record — first click wins (buyer
 *  forwarding the email is implicit consent, supports group buys). */
attendeeGate.post("/redeem", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const body = await c.req
    .json<{ token?: string; podPubKey?: string }>()
    .catch(() => null);
  if (!body?.token) return c.json({ ok: false, error: "token is required" }, 400);

  const verdict = verifyGateToken(body.token);
  if (!verdict.ok) {
    const msg =
      verdict.reason === "expired"
        ? "This link has expired — ask the organiser to resend your ticket email"
        : "This link is not valid";
    return c.json({ ok: false, error: msg }, verdict.reason === "expired" ? 410 : 400);
  }

  const { eventId, seriesId, edition, emailHash } = verdict.payload;
  const bound = bindTicket({
    seriesId,
    edition,
    eventId,
    parentAddress,
    emailHash,
    podPubKey: typeof body.podPubKey === "string" ? body.podPubKey : undefined,
    paid: await seriesIsPaid(eventId, seriesId),
    route: "email-link",
  });
  if (!bound) {
    return c.json({ ok: false, error: "This ticket has already unlocked an account" }, 409);
  }

  console.log(`[gate] bound ${seriesId}#${edition} → ${parentAddress} (email-link)`);
  return c.json({ ok: true, data: { gated: true, via: "ticket", eventId, seriesId, edition } });
});
