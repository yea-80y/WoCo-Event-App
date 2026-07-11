/**
 * Attendee gate — prove rightful possession of a purchased ticket to unlock
 * profile creation / sub-ENS / social actions. Design: docs/ATTENDEE_GATE_RESALE_PLAN.md §3.
 *
 *   GET  /api/attendee-gate/status       → { gated, via, bindings }
 *   POST /api/attendee-gate/start        → Route B step 1: ticket link + email
 *                                          → sig-verify + emailHash match → code sent
 *   POST /api/attendee-gate/confirm      → Route B step 2: code → binding (one-shot)
 *   POST /api/attendee-gate/bind-wallet  → wallet claimers: bind own claims, no email dance
 *
 * Security invariants:
 *  - The ClaimedTicket POD is PUBLIC Swarm data — it is never accepted as a
 *    credential. Possession proof = per-ticket QR sig (email-only artifact,
 *    verified against on-chain slotOwner) AND control of the purchase email.
 *  - Codes are only ever sent to the address whose HMAC already matches the
 *    claim record — this endpoint cannot be used to spam arbitrary inboxes.
 *  - v1 / unverifiable tickets are hard-rejected ("unverified" ≠ "valid"):
 *    v1 QR sigs are reconstructable from public feeds.
 *  - One edition unlocks exactly one account, ever (gate nullifier — separate
 *    namespace from door check-in).
 */

import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { verifyTicketSig } from "../lib/ticket/verify-sig.js";
import {
  hashEmail,
  getClaimedTicketByEdition,
  getClaimStatus,
} from "../lib/event/claim-service.js";
import { getEvent } from "../lib/event/service.js";
import { checkAttendeeGate } from "../lib/gate/check.js";
import {
  bindTicket,
  canSendCode,
  createPendingCode,
  getBindingsForParent,
  isTicketConsumed,
  verifyPendingCode,
} from "../lib/gate/store.js";
import { getResend, getFromAddress } from "../lib/email/client.js";

export const attendeeGate = new Hono<AppEnv>();

// Per-IP limiter for /start (mirrors the email-claim limiter in claims.ts).
const START_RATE_LIMIT = 5;
const START_RATE_WINDOW_MS = 15 * 60 * 1000;
const startAttempts = new Map<string, number[]>();

function allowStart(ip: string): boolean {
  const now = Date.now();
  const recent = (startAttempts.get(ip) ?? []).filter((t) => now - t < START_RATE_WINDOW_MS);
  if (recent.length >= START_RATE_LIMIT) return false;
  recent.push(now);
  startAttempts.set(ip, recent);
  return true;
}

function clientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

/** Accepts `woco://t/...`, a full /t page URL, or the bare path — extracts
 *  {eventId, seriesId, edition, sig}. Query params (?n= ?e=) are ignored. */
function parseTicketRef(input: string): {
  eventId: string;
  seriesId: string;
  edition: number;
  sig: string;
} | null {
  const cleaned = input.trim().split("?")[0];
  const m = cleaned.match(/t\/([^/\s]+)\/([^/\s]+)\/(\d+)\/(0x[0-9a-fA-F]{130})$/);
  if (!m) return null;
  const edition = Number(m[3]);
  if (!Number.isInteger(edition) || edition < 1 || edition > 100_000) return null;
  return { eventId: m[1], seriesId: m[2], edition, sig: m[4] };
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

attendeeGate.post("/start", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();

  if (!allowStart(clientIp(c))) {
    return c.json({ ok: false, error: "Too many attempts — try again later" }, 429);
  }

  const body = await c.req.json<{ ticket?: string; email?: string }>().catch(() => null);
  const email = body?.email?.trim();
  if (!body?.ticket || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ ok: false, error: "ticket and a valid email are required" }, 400);
  }

  const ref = parseTicketRef(body.ticket);
  if (!ref) return c.json({ ok: false, error: "Unrecognised ticket link or QR" }, 400);

  if (isTicketConsumed(ref.seriesId, ref.edition)) {
    return c.json({ ok: false, error: "This ticket has already unlocked an account" }, 409);
  }

  // Authenticity: sig must recover to the on-chain slotOwner. "unverified"
  // (v1 ticket or chain read failure) is a hard reject — v1 sigs are public.
  const verdict = await verifyTicketSig(ref);
  if (verdict !== "valid") {
    const msg =
      verdict === "invalid"
        ? "Ticket signature is not valid"
        : "This ticket cannot be verified right now — try again later";
    return c.json({ ok: false, error: msg }, verdict === "invalid" ? 403 : 503);
  }

  // Ownership knowledge: the presented email's HMAC must match the claim
  // record. Never reveal WHICH check failed beyond this generic message.
  const claimed = await getClaimedTicketByEdition(ref.seriesId, ref.edition);
  if (!claimed || claimed.eventId !== ref.eventId || claimed.approvalStatus === "pending") {
    return c.json({ ok: false, error: "Ticket not found" }, 404);
  }
  if (!claimed.ownerEmailHash || claimed.ownerEmailHash !== hashEmail(email)) {
    return c.json({ ok: false, error: "Details do not match this ticket" }, 403);
  }

  if (!canSendCode(ref.seriesId, ref.edition)) {
    return c.json({ ok: false, error: "Too many codes sent for this ticket — try again later" }, 429);
  }

  // Ownership control: code goes ONLY to the already-matching purchase email.
  const code = createPendingCode({
    parentAddress,
    seriesId: ref.seriesId,
    edition: ref.edition,
    eventId: ref.eventId,
    emailHash: claimed.ownerEmailHash,
  });
  await getResend().emails.send({
    from: `"WoCo" <${getFromAddress()}>`,
    to: [email],
    subject: `${code} is your WoCo verification code`,
    text: `Your WoCo ticket verification code is ${code}. It expires in 10 minutes.\n\nIf you didn't request this, you can ignore this email — your ticket is safe.`,
  });

  return c.json({ ok: true, data: { seriesId: ref.seriesId, edition: ref.edition } });
});

attendeeGate.post("/confirm", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const body = await c.req
    .json<{ seriesId?: string; edition?: number; code?: string; podPubKey?: string }>()
    .catch(() => null);
  if (!body?.seriesId || !body.edition || !body.code) {
    return c.json({ ok: false, error: "seriesId, edition and code are required" }, 400);
  }

  const verdict = verifyPendingCode(parentAddress, body.seriesId, body.edition, body.code);
  if (!verdict.ok) {
    const status = verdict.reason === "wrong-code" ? 403 : 410;
    return c.json({ ok: false, error: `Verification failed: ${verdict.reason}` }, status);
  }

  const bound = bindTicket({
    seriesId: body.seriesId,
    edition: body.edition,
    eventId: verdict.eventId,
    parentAddress,
    emailHash: verdict.emailHash,
    podPubKey: typeof body.podPubKey === "string" ? body.podPubKey : undefined,
    paid: await seriesIsPaid(verdict.eventId, body.seriesId),
    route: "ticket-proof",
  });
  if (!bound) {
    return c.json({ ok: false, error: "This ticket has already unlocked an account" }, 409);
  }

  console.log(
    `[gate] bound ${body.seriesId}#${body.edition} → ${parentAddress} (ticket-proof)`,
  );
  return c.json({ ok: true, data: { gated: true, via: "ticket" } });
});

/** Wallet claimers: their claims are already bound to the authed parent on
 *  the claims feed — no email dance needed. Binds every unconsumed edition. */
attendeeGate.post("/bind-wallet", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const body = await c.req
    .json<{ eventId?: string; seriesId?: string; podPubKey?: string }>()
    .catch(() => null);
  if (!body?.eventId || !body.seriesId) {
    return c.json({ ok: false, error: "eventId and seriesId are required" }, 400);
  }

  const status = await getClaimStatus(body.seriesId, parentAddress);
  const editions = status.userEditions ?? [];
  if (editions.length === 0) {
    return c.json({ ok: false, error: "No claimed tickets found for this account" }, 404);
  }

  const paid = await seriesIsPaid(body.eventId, body.seriesId);
  let boundCount = 0;
  for (const edition of editions) {
    const bound = bindTicket({
      seriesId: body.seriesId,
      edition,
      eventId: body.eventId,
      parentAddress,
      podPubKey: typeof body.podPubKey === "string" ? body.podPubKey : undefined,
      paid,
      route: "wallet",
    });
    if (bound) boundCount++;
  }
  if (boundCount === 0) {
    return c.json({ ok: false, error: "These tickets have already unlocked an account" }, 409);
  }

  console.log(`[gate] bound ${boundCount} edition(s) of ${body.seriesId} → ${parentAddress} (wallet)`);
  return c.json({ ok: true, data: { gated: true, via: "ticket", bound: boundCount } });
});
