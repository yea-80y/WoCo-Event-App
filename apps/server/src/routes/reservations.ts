import { Hono, type Context } from "hono";
import type { AppEnv } from "../types.js";
import { getEvent } from "../lib/event/service.js";
import { getClaimStatus } from "../lib/event/claim-service.js";
import {
  reserve,
  release,
  getReservation,
  RESERVATION_MAX_QTY,
  heldFor,
} from "../lib/event/reservation-store.js";

const reservations = new Hono<AppEnv>();

/**
 * In-memory rate limiter — same shape as the email-claim rate limiter in
 * routes/claims.ts. Reservations are unauthenticated by design (email-only
 * standalone-ENS users have no session at form-open time), so we cap by IP
 * to prevent abuse (someone hammering /reserve to lock out other buyers).
 */
const reserveRateMap = new Map<string, number[]>();
const RESERVE_RATE_LIMIT = 30; // max calls
const RESERVE_RATE_WINDOW = 60_000; // per minute

function clientIp(c: Context<AppEnv>): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("cf-connecting-ip") ||
    "unknown"
  );
}

function checkRate(ip: string): boolean {
  const now = Date.now();
  const recent = (reserveRateMap.get(ip) ?? []).filter((t) => now - t < RESERVE_RATE_WINDOW);
  if (recent.length >= RESERVE_RATE_LIMIT) return false;
  recent.push(now);
  reserveRateMap.set(ip, recent);
  return true;
}

// ---------------------------------------------------------------------------
// POST /api/events/:eventId/series/:seriesId/reserve
//
// Holds N seats off the market for RESERVATION_TTL_MS. The frontend shows
// a countdown to the user; the slot is auto-released on expiry. Stripe
// checkout passes the reservationId in metadata so the webhook can consume
// it on successful claim.
// ---------------------------------------------------------------------------

reservations.post("/:eventId/series/:seriesId/reserve", async (c) => {
  const ip = clientIp(c);
  if (!checkRate(ip)) {
    return c.json({ ok: false, error: "Rate limit exceeded" }, 429);
  }

  const eventId = c.req.param("eventId");
  const seriesId = c.req.param("seriesId");

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const rawQty = body.quantity;
  const quantity = Number.isInteger(rawQty) ? Number(rawQty) : NaN;
  if (!Number.isFinite(quantity) || quantity < 1 || quantity > RESERVATION_MAX_QTY) {
    return c.json({ ok: false, error: "Invalid quantity" }, 400);
  }

  // Optional: release this prior reservation atomically inside the per-series
  // mutex before allocating a new one. Lets a buyer change quantity without
  // racing themselves out of the last seats. Unknown / stale IDs are ignored.
  const replaceReservationId =
    typeof body.replaceReservationId === "string" && body.replaceReservationId
      ? body.replaceReservationId
      : undefined;

  // Validate the event/series exist before touching the store.
  const event = await getEvent(eventId).catch(() => null);
  if (!event) return c.json({ ok: false, error: "Event not found" }, 404);
  const series = event.series.find((s) => s.seriesId === seriesId);
  if (!series) return c.json({ ok: false, error: "Series not found" }, 404);

  // Closure that the reservation store uses to ask "what does the canonical
  // (Swarm-backed) source say is available right now?" — a per-call read so
  // we never use a stale cached value.
  const availableSupplier = async (): Promise<number> => {
    const status = await getClaimStatus(seriesId);
    return Math.max(0, status.available);
  };

  const result = await reserve(
    eventId,
    seriesId,
    quantity,
    availableSupplier,
    replaceReservationId,
  );

  if (!result.ok) {
    if (result.error === "InsufficientSeats") {
      return c.json(
        { ok: false, error: "Insufficient seats", available: result.available ?? 0 },
        409,
      );
    }
    return c.json({ ok: false, error: "Invalid request" }, 400);
  }

  return c.json({
    ok: true,
    data: {
      reservationId: result.reservation.id,
      expiresAt: result.reservation.expiresAt,
      quantity: result.reservation.quantity,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/events/:eventId/series/:seriesId/reserve/release
//
// Best-effort release. The frontend calls this on form close / route change
// (sendBeacon). Idempotent — releasing an unknown / already-released
// reservation returns ok. We don't authenticate this endpoint because the
// reservationId itself is the bearer token.
// ---------------------------------------------------------------------------

reservations.post("/:eventId/series/:seriesId/reserve/release", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const reservationId = body.reservationId;
  if (typeof reservationId !== "string" || !reservationId) {
    return c.json({ ok: false, error: "reservationId required" }, 400);
  }
  const seriesId = c.req.param("seriesId");

  // Soft check: only release if the reservation actually belongs to this
  // series. Prevents a malicious client from trying to release someone
  // else's hold by guessing IDs from another series.
  const r = getReservation(reservationId);
  if (r && r.seriesId !== seriesId) {
    return c.json({ ok: false, error: "Reservation series mismatch" }, 400);
  }

  release(reservationId);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /api/events/:eventId/series/:seriesId/held
//
// Optional helper for clients that want a fast "how many seats are currently
// held by other buyers" read without a full claim-status round-trip.
// ---------------------------------------------------------------------------

reservations.get("/:eventId/series/:seriesId/held", async (c) => {
  const seriesId = c.req.param("seriesId");
  return c.json({ ok: true, data: { held: heldFor(seriesId) } });
});

export { reservations };
