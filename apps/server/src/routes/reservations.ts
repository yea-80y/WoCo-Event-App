import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { cancellationGate } from "../lib/event/cancellations.js";
import { getEvent } from "../lib/event/service.js";
import { checkSalesWindow, salesClosedMessage } from "../lib/event/sales-window.js";
import { checkSeriesSaleWindow, seriesSaleMessage } from "../lib/event/series-window.js";
import { resolveSiteEventSigner } from "../lib/site/service.js";
import { eventKeys, type EventKeys } from "../lib/keyring/event-keys.js";
import { sellableKeys } from "../lib/keyring/sale-keys.js";
import { noticeRefusal, organiserNoticeVerdict } from "../lib/legal/notice-gate.js";
import { getOnChainEventAt } from "../lib/chain/event-contract.js";
import { ledger2SaleStatus, noteChainCancelled } from "../lib/event/ledger2-sale-status.js";
import { registrationSeatingFor, saleContractFor } from "../lib/event/onchain-registry.js";
import {
  reserve,
  release,
  getReservation,
  RESERVATION_MAX_QTY,
  heldFor,
  heldSeatsFor,
} from "../lib/event/reservation-store.js";
import { seatCapForReserve } from "../lib/event/seat-cap.js";
import { seatedSaleRefusal } from "../lib/seating/seated-sale.js";
import { reserveSeated, releaseSeated } from "../lib/seating/seated-reserve.js";
import { PLAN_CHANGED } from "../lib/seating/seat-reads.js";
import { reservationsPersisting, SEAT_SALES_PAUSED } from "../lib/event/reservation-store.js";
import { clientIp } from "../lib/http/client-ip.js";
import { FEATURES } from "@woco/shared";
import { MAX_PLAN_SEATS } from "@woco/shared/seating/layout";
import { parseSeatedReserve, seatedReserveRefusal, type SeatedReserveRequest } from "@woco/shared/seating/reserve";

const reservations = new Hono<AppEnv>();

/**
 * In-memory rate limiter — same shape as the email-claim rate limiter in
 * routes/claims.ts. Reservations are unauthenticated by design (email-only
 * standalone-ENS users have no session at form-open time), so we cap by IP
 * to prevent abuse (someone hammering /reserve to lock out other buyers).
 *
 * 30/min is the burst guard — typical legit flow is form-open + a few
 * quantity changes (≤5/min). Sustained abuse is bounded structurally by the
 * per-event held-seats cap inside the store (`seat-cap.ts`), so the rate limit
 * doesn't have to do all the work.
 */
const reserveRateMap = new Map<string, number[]>();
const RESERVE_RATE_LIMIT = 30; // max calls
const RESERVE_RATE_WINDOW = 60_000; // per minute


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

  // #644: no seat is held for a cancelled event; "unknown" refuses too.
  const gate = cancellationGate(eventId);
  if (gate === "cancelled") return c.json({ ok: false, error: "This event has been cancelled" }, 409);
  if (gate === "unknown") return c.json({ ok: false, error: "Ticket sales are temporarily unavailable" }, 503);

  // Allocated seating: a series registered seated is held by SEAT (decision 4: keyed on
  // the registration record, never the feed), and only once seated sales are on.
  const seating = registrationSeatingFor(eventId, seriesId);
  if (seating && !FEATURES.seatedEventsAllowed) {
    const seatedRefusal = seatedSaleRefusal(eventId, seriesId);
    if (seatedRefusal) return c.json(seatedRefusal.body, seatedRefusal.status);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON" }, 400);
  }

  let quantity = NaN;
  let seatReq: SeatedReserveRequest | null = null;
  if (seating) {
    // Range against the plan comes later, with the plan in hand.
    seatReq = parseSeatedReserve(body, MAX_PLAN_SEATS);
    if (!seatReq) return c.json({ ok: false, error: "Choose the seats to hold" }, 400);
    if (seatedReserveRefusal(seatReq, seating)) return c.json({ ok: false, error: PLAN_CHANGED, code: "PLAN_CHANGED" }, 409);
    if (!reservationsPersisting()) return c.json({ ok: false, error: SEAT_SALES_PAUSED }, 503);
    quantity = seatReq.seats.length;
  } else {
    const rawQty = body.quantity;
    quantity = Number.isInteger(rawQty) ? Number(rawQty) : NaN;
    if (!Number.isFinite(quantity) || quantity < 1 || quantity > RESERVATION_MAX_QTY) {
      return c.json({ ok: false, error: "Invalid quantity" }, 400);
    }
  }

  // Optional: release this prior reservation atomically inside the per-series
  // mutex before allocating a new one. Lets a buyer change quantity without
  // racing themselves out of the last seats. Unknown / stale IDs are ignored.
  const replaceReservationId =
    typeof body.replaceReservationId === "string" && body.replaceReservationId
      ? body.replaceReservationId
      : undefined;

  // Stable per-browser identifier (UUID from localStorage). Used by the
  // store to atomically release this buyer's other active reservations on
  // the same series before allocating a new one — closes the stale-hold
  // window when sessionStorage was cleared (closed tab, new tab, refresh
  // edge cases). Header preferred over body so it's set once at the API
  // client level. Length-bounded to prevent abuse.
  const headerClientKey = c.req.header("x-client-key");
  const clientKey =
    typeof headerClientKey === "string" &&
    headerClientKey.length >= 8 &&
    headerClientKey.length <= 64 &&
    /^[A-Za-z0-9_-]+$/.test(headerClientKey)
      ? headerClientKey
      : undefined;

  // Validate the event/series exist before touching the store. Site carrier (see
  // claims.ts) resolves a client-signed, not-WoCo-listed event's authentic SOC.
  const siteId = typeof body.siteId === "string" ? body.siteId : undefined;
  const siteSigner = siteId ? await resolveSiteEventSigner(siteId, eventId) : null;
  const [keys, event] = await Promise.all([
    // A throw is "could not read the keys": refused below, never a 500 or a sale.
    eventKeys(eventId).catch((err): EventKeys => ({ kind: "unavailable", creator: "", feedSigner: "", reason: String(err) })),
    getEvent(eventId, siteSigner ?? undefined).catch(() => null),
  ]);
  if (!event) return c.json({ ok: false, error: "Event not found" }, 404);
  const series = event.series.find((s) => s.seriesId === seriesId);
  if (!series) return c.json({ ok: false, error: "Series not found" }, 404);

  // The organiser's keys and privacy notice: the same refusals create-checkout
  // gives, so no seat is held for a sale it would refuse. An event with no order
  // key the server can vouch for is never sold (issue 896); unreadable keys or an
  // unreadable notice refuse.
  const keyVerdict = sellableKeys(keys);
  if (!keyVerdict.ok) return c.json(keyVerdict.body, keyVerdict.status);
  const noticeBlock = noticeRefusal(await organiserNoticeVerdict(keyVerdict.keys.creator, keyVerdict.keys.feedSigner));
  if (noticeBlock) return c.json(noticeBlock.body, noticeBlock.status);
  const onChainEventId = series.onChainEventId;
  if (!onChainEventId) {
    // Registration never completed — nothing can be minted, so a seat hold
    // has nothing to hold. Same refusal create-checkout and claim-status give.
    return c.json({ ok: false, error: "Tickets for this event are not currently on sale" }, 409);
  }

  // Past-event gate (#241) — a hold exists only to become a paid checkout,
  // and create-checkout refuses ended events, so refuse the hold up front
  // with the same 409 rather than granting a seat that can never be sold.
  const salesWindow = checkSalesWindow(event);
  if (!salesWindow.open) {
    return c.json({ ok: false, error: salesClosedMessage(salesWindow.reason) }, 409);
  }

  // Series sale-window gate (#295) — same refusal create-checkout gives, so a
  // hold is never granted for a tier that cannot become a paid checkout.
  const seriesWindow = checkSeriesSaleWindow(series);
  if (!seriesWindow.open) {
    return c.json({ ok: false, error: seriesSaleMessage(seriesWindow.reason) }, 409);
  }

  // Sale-contract gate (#563) — the same rule, and the same refusal, as
  // create-checkout: the registration's own contract, and only on the active
  // chain. A hold for a series create-checkout would refuse is a seat nobody
  // can buy, and it would still spend this network's seat cap (#223). Refused
  // before any read of another chain.
  const sale = saleContractFor(eventId, seriesId);
  if (!sale.ok) {
    return c.json({ ok: false, error: "Tickets for this event are not currently on sale" }, 409);
  }
  const contract = sale.contract;

  // How many seats one network may hold unpaid at THIS event (#223), sized from
  // the declared supply on the event record already loaded above, with this series
  // at no more than the live supply the read below sees (a ledger2 cut). The store
  // evaluates it after that read, synchronously - see the invariant note at the check.
  const seatCap = seatCapForReserve(event.series, seriesId);

  if (seating && seatReq) {
    const r = await reserveSeated({
      eventId, seriesId, seats: seatReq.seats, planDigest: seating.planDigest, series, contract, seatCap,
      feedSigner: keyVerdict.keys.feedSigner,
      replaceReservationId, clientKey, ip,
    });
    return c.json(r.body, r.status);
  }

  // Closure that the reservation store uses to ask "what is available right
  // now?" — the contract is the only supply ledger.
  const availableSupplier = async (): Promise<number> => {
    // Fail closed on ANY chain problem: EventNotFound returns null, a
    // transport failure throws — both mean "cannot verify seats exist",
    // and a hold must never be granted against seats we can't count.
    // On ledger2 the organiser can cancel through any relay: read it with the supply,
    // in the same round trip. A status that did not answer fails open (the server's
    // cancellation record above is the closed gate); a cancellation holds nothing.
    const [onChainData, status] = await Promise.all([
      getOnChainEventAt(contract, onChainEventId).catch(() => null),
      ledger2SaleStatus(contract, onChainEventId).catch(() => null),
    ]);
    if (!onChainData) return 0;
    seatCap.sawLiveSupply(Number(onChainData.totalSupply));
    if (status?.cancelled) {
      noteChainCancelled(eventId, onChainEventId);
      return 0;
    }
    return Math.max(0, Number(onChainData.totalSupply) - Number(onChainData.nextSlot));
  };

  const result = await reserve(
    eventId,
    seriesId,
    quantity,
    availableSupplier,
    seatCap.cap,
    replaceReservationId,
    clientKey,
    ip,
  );

  if (!result.ok) {
    if (result.error === "InsufficientSeats") {
      return c.json(
        {
          ok: false,
          error: "Insufficient seats",
          available: result.available ?? 0,
          physicalAvailable: result.physicalAvailable ?? 0,
        },
        409,
      );
    }
    if (result.error === "IpCapExceeded") {
      return c.json(
        {
          ok: false,
          error:
            "Too many seats are already being held from your network. " +
            "Complete a pending purchase, or try again in a few minutes.",
        },
        429,
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
  const eventId = c.req.param("eventId");

  // Soft check: only release if the reservation actually belongs to this series
  // OF THIS EVENT. Prevents a malicious client from trying to release someone
  // else's hold by guessing IDs from another series — and, since series ids are
  // unique only by convention (#377), from another event declaring the same id.
  const r = getReservation(reservationId);
  if (r && (r.seriesId !== seriesId || r.eventId !== eventId)) {
    return c.json({ ok: false, error: "Reservation series mismatch" }, 400);
  }

  // A seated hold may have a Stripe session open: it is closed there before the seats
  // return (one Stripe call, so rate limited like a hold).
  if (r?.seats) {
    if (!checkRate(clientIp(c))) return c.json({ ok: false, error: "Rate limit exceeded" }, 429);
    const out = await releaseSeated(reservationId);
    return c.json(out.body, out.status);
  }

  release(reservationId);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /api/events/:eventId/series/:seriesId/held
//
// How many seats other buyers hold right now. For a series registered seated it
// also lists WHICH seats (`heldSeatsFor`: live holds, and seats paid in the last
// few minutes that a lagging RPC may not show yet) - the one thing a buyer's seat
// map needs from our server (docs/SEATING.md decision 6). Only seat indices: no
// expiry, nothing about who. The same answer for every caller (a buyer's map
// leaves its own hold out itself), so a CDN may keep it for a few seconds.
// ---------------------------------------------------------------------------

reservations.get("/:eventId/series/:seriesId/held", async (c) => {
  const seriesId = c.req.param("seriesId");
  const eventId = c.req.param("eventId");
  const seated = registrationSeatingFor(eventId, seriesId) !== null;
  c.header("Cache-Control", "public, max-age=5, s-maxage=5");
  return c.json({
    ok: true,
    data: { held: heldFor(eventId, seriesId), ...(seated ? { seats: heldSeatsFor(eventId, seriesId) } : {}) },
  });
});

export { reservations };
