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
import { clientIp } from "../lib/http/client-ip.js";

export const attendeeGate = new Hono<AppEnv>();

const RATE_WINDOW_MS = 15 * 60 * 1000;


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

  // `podPubKey` arrives in an UNAUTHENTICATED body (possession of the emailed
  // link is the proof here, not a session), and until now was stored verbatim —
  // any string at all. It is validated for SHAPE before it is recorded, because
  // the certificate rail turns this field into permanent, publicly-readable,
  // issuer-signed statements with no v1 revocation (#172), and a certificate
  // signed over garbage cannot be taken back.
  //
  // Shape only. It still is NOT proved to be this account's POD identity — that
  // is #345, and it needs a possession challenge, not a regex.
  //
  // A malformed key does NOT fail the redeem. The unlock is what the attendee
  // came for and what the one-shot nullifier is spent on; the key is an
  // accessory that a broken client can get wrong. But it is not dropped
  // silently either — `podKeyRecorded` says what happened, so a client can tell
  // the difference between "recorded" and "gone", which matters because the
  // nullifier is now spent and nothing backfills the key onto an existing
  // binding.
  const rawPodPubKey = typeof body.podPubKey === "string" ? body.podPubKey.toLowerCase() : undefined;
  const podPubKey = rawPodPubKey && /^[0-9a-f]{64}$/.test(rawPodPubKey) ? rawPodPubKey : undefined;
  if (rawPodPubKey && !podPubKey) {
    console.warn(`[gate] redeem for ${seriesId}#${edition} sent a malformed podPubKey — binding without it`);
  }

  const bound = bindTicket({
    seriesId,
    edition,
    eventId,
    parentAddress,
    emailHash,
    podPubKey,
    paid: await seriesIsPaid(eventId, seriesId),
    route: "email-link",
  });
  if (!bound) {
    return c.json({ ok: false, error: "This ticket has already unlocked an account" }, 409);
  }

  console.log(`[gate] bound ${seriesId}#${edition} → ${parentAddress} (email-link)`);
  return c.json({
    ok: true,
    data: {
      gated: true,
      via: "ticket",
      eventId,
      seriesId,
      edition,
      // Absent-because-not-sent and absent-because-rejected are different, and
      // only the client knows which it attempted.
      podKeyRecorded: !!podPubKey,
    },
  });
});
