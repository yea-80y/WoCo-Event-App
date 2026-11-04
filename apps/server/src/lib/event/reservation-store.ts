/**
 * Reservation store — server-side slot holds with TTL.
 *
 * A reservation holds N seats off the market for a single series for up to
 * RESERVATION_TTL_MS, giving a buyer time to complete checkout without
 * racing other concurrent buyers. Reservations are server-only state — no
 * Swarm writes — so they're cheap (no postage cost) and fast (file write).
 *
 * Storage: in-memory Map backed by a JSON file so state survives restarts.
 * GC sweep removes expired + consumed entries every RESERVATION_GC_INTERVAL_MS.
 *
 * Atomicity: `reserve()` is serialised per (event, series) via an in-memory
 * mutex (mirrors the per-series claim queue pattern in routes/claims.ts), so
 * concurrent /reserve calls for the same series can't both grab the last seat.
 * `consume` and `release` do NOT take it — they are wholly synchronous, so
 * run-to-completion already makes them atomic. This said all three were
 * serialised, which was never true.
 *
 * Per-buyer cap: when a `clientKey` (UUID from the buyer's localStorage)
 * is supplied, `reserve()` releases all other active reservations on the
 * same series with the same clientKey before allocating a new one. This
 * prevents a single buyer from accumulating stale held seats across tab
 * close, refresh, or sessionStorage loss — those would otherwise linger
 * for the full TTL and surface as a false "Not enough tickets" UI when
 * the same buyer tries to reserve again.
 *
 * Authority: `available` reported by getClaimStatus is the physical remaining
 * (totalSupply - claimed). Active reservations are NOT subtracted there —
 * doing so would self-double-count the buyer's own hold and break the
 * dropdown / shortfall UX. Concurrency is enforced inside `reserve()`, which
 * subtracts heldFor() before validating, and returns the precise remaining
 * count if the requested quantity can't be satisfied.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeJsonAtomic } from "../marketing/persist.js";
import { RESERVATION_MAX_QTY } from "@woco/shared/event/reservation";

const DATA_DIR = join(process.cwd(), ".data");
const STORE_FILE = join(DATA_DIR, "reservations.json");

/** How long a reservation lives before auto-expiring. */
export const RESERVATION_TTL_MS = 10 * 60 * 1000; // 10 min

/** Sweep interval for expired/consumed garbage collection. */
const RESERVATION_GC_INTERVAL_MS = 60 * 1000;

/** Keep consumed/expired entries this long for debugging before deletion. */
const RESERVATION_KEEP_AFTER_MS = 60 * 60 * 1000; // 1 hour

/** Max quantity that can be reserved in one entry (matches Stripe checkout cap). Shared with every client. */
export { RESERVATION_MAX_QTY };

/**
 * The per-IP held-seat cap is no longer a constant — it is sized per event by
 * `perIpSeatCapForEvent()` in `seat-cap.ts` and passed into `reserve()`.
 *
 * It was 30 for every event, which is 60% of a 50-seat room and 1.5% of an
 * arena — so the same number that barely inconveniences a large event let one
 * address sit on most of a small one. The cap now shrinks for small events and
 * is never raised above 30, so this only ever tightens.
 *
 * #223 also argued 30 was too TIGHT for a 40-person block booking. That half was
 * rejected: a consumed hold stops counting the moment payment lands, so such a
 * purchase already completes by paying per order. The cap bounds seats held
 * unpaid and simultaneously, never total sales.
 *
 * The justification once given for 30 — "a small office or family LAN
 * (~30 concurrent buyers × 1 ticket each)" — also pre-dated #218, which moved
 * IPv6 to /64 bucketing and made that office ONE bucket rather than thirty.
 *
 * The cap is computed at the route, not here, so the check below stays
 * synchronous. See the invariant note on the check itself. It may be passed as a
 * synchronous function, evaluated after the availability read, so a ledger2
 * supply cut that read saw sizes the cap (`seatCapForReserve`).
 */

export interface Reservation {
  id: string;
  eventId: string;
  seriesId: string;
  quantity: number;
  /** ISO timestamp when this reservation was created */
  createdAt: string;
  /** ISO timestamp when this reservation expires (createdAt + TTL) */
  expiresAt: string;
  /** Set when the reservation has been consumed by a successful claim */
  consumedAt?: string;
  /**
   * Stable per-browser identifier (UUID from localStorage). When present,
   * `reserve()` atomically releases any other active reservation on the
   * same series with the same clientKey before allocating a new one.
   * This prevents a single buyer from accumulating multiple held seats
   * across tab close/reopen, refresh, or sessionStorage loss.
   */
  clientKey?: string;
  /**
   * Source IP recorded for the per-IP held-seats cap (see `seat-cap.ts`).
   * Derived at the route layer by `clientIp()`
   * from `cf-connecting-ip` ONLY — never `x-forwarded-for`, whose first element
   * the caller writes (#179). Still never trusted for identity, only as a
   * flood-control hint.
   */
  ip?: string;
  /**
   * Allocated seating: the seat indices this hold names (docs/SEATING.md), ascending,
   * each once, `quantity` of them. Only a seated hold has it (`reserveSeats`).
   */
  seats?: number[];
  /** The plan the seats were checked on: the registration's pin (decision 4). */
  planDigest?: string;
  /** Per seat, aligned with `seats`: what the buyer was shown and will be charged. */
  seatInfo?: SeatedHoldSeat[];
  /** The fee settings the hold's amounts were worked out under (`holdFeeKey`): checkout refuses others. */
  feeKey?: string;
  /** The Stripe Checkout Session currently paying for this seated hold (one at a time). */
  checkout?: HoldCheckout;
  /** Fulfilment has claimed the hold for a paid session and is minting it. */
  fulfilling?: { sessionId: string; at: string };
  /** How a seated hold ended before its time, when it did. */
  releasedBy?: "buyer" | "replaced" | "session-expired" | "not-minted";
  /** It carried a session and ran out by time, not by Stripe's expiry event (`/api/health`). */
  ttlLapsed?: true;
}

/** One seat of a seated hold, pinned when the hold is made. */
export interface SeatedHoldSeat {
  /** The plan band's id: its price comes from the event feed. */
  band: string;
  bandName: string;
  /** "Stalls, Row D, seat 7". */
  label: string;
  /** The band's price when the hold was made, minor units. Checkout refuses if the feed's differs. */
  priceMinor: number;
}

export interface HoldCheckout {
  sessionId: string;
  /** The organiser's connected account the session lives on. */
  account: string;
  /** The session's own expiry (Stripe's `expires_at`). */
  expiresAt: string;
  /** Sessions this hold has had, this one included (MAX_SESSIONS_PER_HOLD). */
  sessions: number;
  /** We closed it at Stripe to open the next one: its expiry event is ours, not a lapse. */
  closed?: true;
}

/** A seated hold stays this long past its session's expiry: a payment in flight, a late webhook. */
export const SEATED_HOLD_GRACE_MS = 5 * 60 * 1000;
/** Checkouts one seated hold may have. Each new one closes the last at Stripe first. */
export const MAX_SESSIONS_PER_HOLD = 3;
/**
 * How long fulfilment keeps a claimed hold in force while it mints: a mint can take up to
 * MINT_RESOLVE_BOUND_MS (10 min) to resolve. Bounded so a process that died mid-sale
 * cannot keep the seats off sale for good.
 */
export const FULFIL_PIN_MS = 20 * 60 * 1000;

/** A persisted `seats` field is used only when it is exactly a seated hold's. */
function validSeats(seats: unknown, quantity: number): seats is number[] {
  if (!Array.isArray(seats) || seats.length !== quantity || seats.length > RESERVATION_MAX_QTY) return false;
  for (let i = 0; i < seats.length; i++) {
    if (!Number.isSafeInteger(seats[i]) || seats[i] < 0 || (i > 0 && seats[i] <= seats[i - 1])) return false;
  }
  return true;
}

const DIGEST_RE = /^0x[0-9a-f]{64}$/;
const isText = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const isTime = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));

function validSeatInfo(v: unknown, n: number): v is SeatedHoldSeat[] {
  return Array.isArray(v) && v.length === n && v.every((s) =>
    s && typeof s === "object" && isText(s.band, 64) && isText(s.bandName, 200) && isText(s.label, 200) &&
    Number.isSafeInteger(s.priceMinor) && s.priceMinor >= 0);
}

function validCheckout(v: unknown): v is HoldCheckout {
  const c = v as HoldCheckout;
  return !!c && typeof c === "object" && isText(c.sessionId, 255) && c.sessionId.startsWith("cs_") &&
    isText(c.account, 255) && c.account.startsWith("acct_") && isTime(c.expiresAt) &&
    Number.isInteger(c.sessions) && c.sessions >= 1 && c.sessions <= MAX_SESSIONS_PER_HOLD &&
    (c.closed === undefined || c.closed === true);
}

/**
 * Each seated field loads only if well formed, and a bad one is dropped alone: the hold
 * keeps counting (and its seats stay held), but checkout and fulfilment, which need the
 * pin, the prices and the session, refuse it - a refund, never a guess.
 */
function sanitiseSeated(r: Reservation): void {
  if ("seats" in r && !validSeats(r.seats, r.quantity)) delete r.seats;
  if ("planDigest" in r && !(typeof r.planDigest === "string" && DIGEST_RE.test(r.planDigest))) delete r.planDigest;
  if ("seatInfo" in r && !validSeatInfo(r.seatInfo, r.seats?.length ?? -1)) delete r.seatInfo;
  if ("feeKey" in r && !isText(r.feeKey, 512)) delete r.feeKey;
  if ("checkout" in r && !validCheckout(r.checkout)) delete r.checkout;
  if ("fulfilling" in r && !(r.fulfilling && isText(r.fulfilling.sessionId, 255) && isTime(r.fulfilling.at))) delete r.fulfilling;
}

const reservations = new Map<string, Reservation>();
let loaded = false;
let gcTimer: NodeJS.Timeout | null = null;
/**
 * Why the file exists but could not be read, or null. Then it is never overwritten
 * (seated holds are money-path state: a lost one refunds a paid seat), general holds
 * keep working in memory, and seated holds and checkouts refuse until it is restored.
 */
let fileUnreadable: string | null = null;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  let raw: string | null = null;
  try {
    raw = readFileSync(STORE_FILE, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      fileUnreadable = err instanceof Error ? err.message : String(err);
      console.error(`[reservations] ${STORE_FILE} exists but cannot be read — it will NOT be overwritten; seated sales are paused:`, err);
    }
  }
  if (raw !== null) {
    try {
      const arr = JSON.parse(raw) as unknown;
      if (!Array.isArray(arr)) throw new Error("not a JSON array");
      for (const r of arr as Reservation[]) {
        // A malformed seat list loses the list, never the hold (it still counts by quantity).
        sanitiseSeated(r);
        reservations.set(r.id, r);
      }
      console.log(`[reservations] Loaded ${reservations.size} reservations from disk`);
    } catch (err) {
      reservations.clear();
      fileUnreadable = err instanceof Error ? err.message : String(err);
      console.error(`[reservations] ${STORE_FILE} is not readable JSON — it will NOT be overwritten; seated sales are paused:`, err);
    }
  }
  // Kick off GC on first access.
  if (!gcTimer) {
    gcTimer = setInterval(sweep, RESERVATION_GC_INTERVAL_MS);
    // Don't block process exit on the GC interval.
    gcTimer.unref?.();
  }
}

function persistToDisk(): void {
  if (fileUnreadable) return;
  writeJsonAtomic(STORE_FILE, [...reservations.values()], "reservations");
}

/** False while the file exists but could not be read: seated holds and checkouts refuse. */
export function reservationsPersisting(): boolean {
  ensureLoaded();
  return fileUnreadable === null;
}

/** Sweep expired + long-consumed reservations from memory + disk. */
function sweep(): void {
  const now = Date.now();
  let removed = 0;
  let changed = false;
  for (const [id, r] of reservations) {
    // Held by fulfilment past its time: never swept from under the mint.
    if (isActive(r, now)) continue;
    if (r.checkout && !r.checkout.closed && !r.consumedAt && !r.releasedBy && !r.ttlLapsed) {
      r.ttlLapsed = true;
      changed = true;
    }
    const expired = new Date(r.expiresAt).getTime() < now;
    const longConsumed =
      r.consumedAt && new Date(r.consumedAt).getTime() + RESERVATION_KEEP_AFTER_MS < now;
    const longExpired =
      expired && new Date(r.expiresAt).getTime() + RESERVATION_KEEP_AFTER_MS < now;
    if (longConsumed || longExpired) {
      reservations.delete(id);
      removed++;
    }
  }
  if (removed > 0 || changed) persistToDisk();
  if (removed > 0) console.log(`[reservations] Swept ${removed} stale entries`);
}

/** Per-series mutex: serialises reserve/consume/release for a single series. */
const seriesLocks = new Map<string, Promise<void>>();
/**
 * Serialise work on one series of one event.
 *
 * The event is in the key for the same reason it is in `heldFor` (#377). Keyed
 * on seriesId alone, two events declaring the same id shared a lock — harmless
 * for correctness, but it let anyone who registered a colliding event force the
 * victim's buyers to queue behind their own reserve calls, each of which makes a
 * chain read. NUL separates the parts so no pair of ids can produce the same key
 * by concatenation.
 */
function withSeriesLock<T>(
  eventId: string,
  seriesId: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const key = `${eventId}\u0000${seriesId}`;
  const prev = seriesLocks.get(key) ?? Promise.resolve();
  const next = prev.then(() => fn());
  seriesLocks.set(key, next.then(() => {}, () => {}));
  return next as Promise<T>;
}

/**
 * Active = not consumed AND not expired - or claimed by fulfilment within FULFIL_PIN_MS:
 * a payment that lands near the end of a hold must not let the seats lapse to another
 * buyer while its mint resolves.
 */
function isActive(r: Reservation, now: number): boolean {
  if (r.consumedAt) return false;
  if (r.fulfilling && Date.parse(r.fulfilling.at) + FULFIL_PIN_MS > now) return true;
  return new Date(r.expiresAt).getTime() > now;
}

/**
 * Total seats currently held by active reservations for a given series OF A
 * GIVEN EVENT. Used inside `reserve()` to enforce concurrency at reservation
 * time, and exposed informationally on SeriesClaimStatus.held.
 *
 * The event is part of the key on purpose (#377). This matched `seriesId` alone,
 * which is only sound if series ids are globally unique — true in practice
 * because both client mint sites emit `crypto.randomUUID()`, but NOT enforced:
 * `isValidSeriesId` is a shape check that happily accepts another event's id.
 * An attacker who registered their own event declaring a victim's (public)
 * seriesId could hold seats on their own event and shrink the victim's
 * availability, so the victim's tickets read sold out with nothing bought.
 * Keying by (event, series) makes the code correct regardless of how ids are
 * minted, rather than correct by coincidence.
 */
export function heldFor(eventId: string, seriesId: string): number {
  ensureLoaded();
  const now = Date.now();
  let total = 0;
  for (const r of reservations.values()) {
    if (r.eventId === eventId && r.seriesId === seriesId && isActive(r, now)) {
      total += r.quantity;
    }
  }
  return total;
}

/**
 * Seats of a seated series the server would refuse that the chain may not show yet,
 * ascending (the live holds route, docs/SEATING.md "Buyer experience"): every active
 * hold's seats, plus the seats of holds consumed (paid, minted) in the last
 * RESERVATION_TTL_MS, so a buyer's map reading a public RPC replica that has not
 * caught up with the mint still sees them taken. Seats only: never a hold's expiry,
 * id, client key or address.
 */
export function heldSeatsFor(eventId: string, seriesId: string): number[] {
  ensureLoaded();
  const now = Date.now();
  const out = new Set<number>();
  for (const r of reservations.values()) {
    if (r.eventId !== eventId || r.seriesId !== seriesId || !r.seats) continue;
    if (seatsOffSale(r, now)) for (const k of r.seats) out.add(k);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * A seated hold's seats are off sale: it is live, or it was paid in the last
 * RESERVATION_TTL_MS - a mint the chain may not show yet, or one still unresolved
 * (#994), which may land. The map and the hold check share this one rule.
 */
function seatsOffSale(r: Reservation, now: number): boolean {
  return isActive(r, now) || (!!r.consumedAt && Date.parse(r.consumedAt) + RESERVATION_TTL_MS > now);
}

/**
 * `heldFor`, plus when the last of those holds runs out (epoch ms, null when none).
 * A ledger2 capacity cut below sold + held is refused (`lib/event/ledger2-relay.ts`),
 * and the organiser is told the time it can try again.
 */
export function holdsFor(eventId: string, seriesId: string): { held: number; expiresBy: number | null } {
  ensureLoaded();
  const now = Date.now();
  let held = 0;
  let expiresBy: number | null = null;
  for (const r of reservations.values()) {
    if (r.eventId === eventId && r.seriesId === seriesId && isActive(r, now)) {
      held += r.quantity;
      const t = new Date(r.expiresAt).getTime();
      if (expiresBy === null || t > expiresBy) expiresBy = t;
    }
  }
  return { held, expiresBy };
}

/**
 * Seats currently held by one address AT ONE EVENT.
 *
 * The event filter is the fix in #223. This counted every active hold for the
 * address platform-wide, so seats held at tonight's gig silently consumed the
 * allowance at an unrelated event — while the comment on the check claimed it
 * was already event-scoped. Post-#218 a venue, office or campus is a single /64
 * bucket, so that cross-event interference landed on exactly the shared
 * networks most likely to have several genuine buyers behind them.
 */
export function heldSeatsByIp(ip: string, eventId: string): number {
  ensureLoaded();
  const now = Date.now();
  let total = 0;
  for (const r of reservations.values()) {
    if (r.ip === ip && r.eventId === eventId && isActive(r, now)) total += r.quantity;
  }
  return total;
}

export interface ReserveResult {
  ok: true;
  reservation: Reservation;
  /** True when an existing same-clientKey + same-qty hold was returned as-is
   *  (TTL preserved, no fresh allocation). */
  reused?: boolean;
}
export interface ReserveError {
  ok: false;
  error: "InsufficientSeats" | "InvalidQuantity" | "IpCapExceeded";
  /** Effective remaining = canonical - heldByOthers. May be 0 even when
   *  `physicalAvailable` > 0 (held by other browsers). */
  available?: number;
  /** Physical remaining ignoring all holds (totalSupply - claimed). Lets
   *  the frontend distinguish "sold out" from "held by another buyer". */
  physicalAvailable?: number;
}

/**
 * Reserve N seats for a series. Atomic per-series: two concurrent /reserve
 * calls won't both succeed if only one seat remains.
 *
 * @param availableSupplier — async function that returns the current
 *   `available` count from the canonical Swarm-backed source. The reservation
 *   store can't compute this itself (it doesn't read the editions feed); the
 *   route caller passes a closure over getClaimStatus.
 * @param replaceReservationId — optional ID of a prior reservation to release
 *   atomically before allocating the new one. Lets clients change quantity
 *   without racing themselves: the released seats are visible to the
 *   `heldFor()` calculation below (within the same mutex turn), so the buyer
 *   never blocks themselves out. Passing an unknown / already-released ID is
 *   a no-op.
 */
export async function reserve(
  eventId: string,
  seriesId: string,
  quantity: number,
  availableSupplier: () => Promise<number>,
  perIpSeatCap: number | (() => number),
  replaceReservationId?: string,
  clientKey?: string,
  ip?: string,
): Promise<ReserveResult | ReserveError> {
  ensureLoaded();
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > RESERVATION_MAX_QTY) {
    return { ok: false, error: "InvalidQuantity" };
  }

  return withSeriesLock(eventId, seriesId, async () => {
    if (replaceReservationId) {
      const prior = reservations.get(replaceReservationId);
      if (prior && prior.eventId === eventId && prior.seriesId === seriesId && !prior.consumedAt) {
        prior.expiresAt = new Date().toISOString();
      }
    }
    // Return-existing path: when the caller is the same browser (clientKey
    // match) AND wants the same quantity AND `replaceReservationId` was NOT
    // passed, return the existing hold UNCHANGED. This preserves the TTL
    // across tab close/reopen and refresh — the timer keeps decreasing
    // instead of restarting at 10 min, so a buyer can't extend a lock by
    // closing and reopening the page. Active hold = not consumed and not
    // yet expired.
    if (clientKey && !replaceReservationId) {
      const now = Date.now();
      let existing: Reservation | undefined;
      for (const r of reservations.values()) {
        if (
          r.eventId === eventId &&
          r.seriesId === seriesId &&
          r.clientKey === clientKey &&
          !r.consumedAt &&
          new Date(r.expiresAt).getTime() > now &&
          r.quantity === quantity
        ) {
          if (!existing || new Date(r.createdAt).getTime() > new Date(existing.createdAt).getTime()) {
            existing = r;
          }
        }
      }
      if (existing) {
        return { ok: true, reservation: existing, reused: true };
      }
    }
    // ClientKey dedup: the canonical guard against a single buyer holding
    // multiple seats across tab close/reopen, refresh, or sessionStorage
    // loss. `replaceReservationId` only catches same-tab continuations;
    // when the client lost track of the prior id (different tab, cleared
    // sessionStorage), this loop releases all of their stale holds before
    // we allocate the new one. Inside the per-series mutex, so atomic.
    if (clientKey) {
      const nowIso = new Date().toISOString();
      for (const r of reservations.values()) {
        if (
          r.eventId === eventId &&
          r.seriesId === seriesId &&
          r.clientKey === clientKey &&
          !r.consumedAt &&
          new Date(r.expiresAt).getTime() > Date.now()
        ) {
          r.expiresAt = nowIso;
        }
      }
    }
    const canonicalAvailable = await availableSupplier();
    const currentlyHeld = heldFor(eventId, seriesId);
    const realAvailable = Math.max(0, canonicalAvailable - currentlyHeld);
    if (quantity > realAvailable) {
      return {
        ok: false,
        error: "InsufficientSeats",
        available: realAvailable,
        physicalAvailable: canonicalAvailable,
      };
    }
    // Per-IP cap — checked AFTER the replace/clientKey-dedup loops above, so a
    // buyer changing quantity isn't double-counted (their prior hold is already
    // marked expired). Counts every series of THIS event, so a flood can't be
    // spread across tiers, and no other event, so an unrelated hold can't
    // consume this event's allowance.
    //
    // INVARIANT — DO NOT ADD AN `await` BETWEEN THIS CHECK AND THE `set` BELOW.
    // The per-series mutex does not protect this: the count spans series, so a
    // concurrent reserve on a DIFFERENT series of the same event holds a
    // different lock. What makes the check-then-insert atomic is that it is one
    // synchronous stretch under Node's run-to-completion. `perIpSeatCap` is
    // passed in already computed, or as a SYNCHRONOUS function (the type refuses a
    // Promise), for exactly this reason — deriving it here with I/O would
    // silently reopen the race.
    const ipCap = typeof perIpSeatCap === "function" ? perIpSeatCap() : perIpSeatCap;
    if (ip && heldSeatsByIp(ip, eventId) + quantity > ipCap) {
      return { ok: false, error: "IpCapExceeded" };
    }
    const now = new Date();
    const expires = new Date(now.getTime() + RESERVATION_TTL_MS);
    const r: Reservation = {
      id: randomUUID(),
      eventId,
      seriesId,
      quantity,
      createdAt: now.toISOString(),
      expiresAt: expires.toISOString(),
      ...(clientKey ? { clientKey } : {}),
      ...(ip ? { ip } : {}),
    };
    reservations.set(r.id, r);
    persistToDisk();
    return { ok: true, reservation: r };
  });
}

/**
 * Best-effort release. Idempotent — releasing an unknown / already-released
 * / already-consumed reservation is not an error.
 */
export function release(reservationId: string): void {
  ensureLoaded();
  const r = reservations.get(reservationId);
  if (!r || r.consumedAt) return;
  // Mark expired by setting expiresAt to now — keeps the entry around for
  // GC sweep + audit, but heldFor() ignores it immediately.
  r.expiresAt = new Date().toISOString();
  persistToDisk();
}

/**
 * Consume a reservation as part of a successful claim. The webhook calls this
 * once it's confirmed the Stripe payment landed and the ticket is being
 * issued. Returns the reservation if it was consumed, null otherwise.
 *
 * Lenient: a reservation is consumed even if it's expired by a few seconds —
 * we don't want a slow webhook to block a paid claim. If the reservation is
 * truly stale (consumed already, or unknown), we return null and the caller
 * falls back to the regular availability check.
 */
export function consume(reservationId: string): Reservation | null {
  ensureLoaded();
  const r = reservations.get(reservationId);
  if (!r || r.consumedAt) return null;
  r.consumedAt = new Date().toISOString();
  persistToDisk();
  return r;
}

/** Read-only fetch — no side effects. */
export function getReservation(id: string): Reservation | null {
  ensureLoaded();
  const r = reservations.get(id);
  if (!r) return null;
  return { ...r };
}

// ---------------------------------------------------------------------------
// Allocated seating (docs/SEATING.md "Selling a seat"; Fable S4 consult)
//
// A seated hold names seats, and it is bound to at most ONE payable Stripe session at
// a time. It is never released while that session can still be paid: it is closed at
// Stripe first, or the hold stays (and a session Stripe says is complete is a sale).
// ---------------------------------------------------------------------------

/** What closing a hold's session at Stripe said. */
export type SessionExpiry = "expired" | "complete" | "error";

export type SeatVerify =
  | { ok: true; remaining: number; seats: SeatedHoldSeat[] }
  | { ok: false; status: 409 | 503; error: string; conflicts?: number[] };

export type SeatedReserveResult =
  | { ok: true; reservation: Reservation; reused?: boolean }
  | { ok: false; status: 400 | 409 | 429 | 503; error: string; conflicts?: number[]; available?: number };

export const SEAT_SALES_PAUSED = "Seat sales are paused for a moment. Please try again shortly.";
export const SEATS_GONE = "Some of these seats have just been taken. Choose others.";

const sessionOpen = (r: Reservation, now: number): boolean =>
  !!r.checkout && Date.parse(r.checkout.expiresAt) > now;

const sameSeats = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((k, i) => k === b[i]);

/** End a seated hold. Every caller has closed its session at Stripe, or it had none open. */
function endHold(r: Reservation, by: NonNullable<Reservation["releasedBy"]>): void {
  const now = new Date().toISOString();
  delete r.fulfilling;
  r.expiresAt = now;
  r.releasedBy = by;
  if (r.checkout && Date.parse(r.checkout.expiresAt) > Date.parse(now)) r.checkout = { ...r.checkout, expiresAt: now };
}

/**
 * Close a hold's open session at Stripe, then end the hold. "kept": it is paid (Stripe
 * says complete, or fulfilment has it). "error": Stripe unreachable, or a newer session
 * was bound while we asked - either way something may still pay, so nothing is released.
 */
async function closeThenEnd(
  r: Reservation,
  by: NonNullable<Reservation["releasedBy"]>,
  expire: (c: HoldCheckout) => Promise<SessionExpiry>,
): Promise<"ended" | "kept" | "error"> {
  if (r.consumedAt || r.fulfilling) return "kept";
  if (sessionOpen(r, Date.now())) {
    const closing = r.checkout!;
    const verdict = await expire(closing);
    if (verdict === "error") return "error";
    if (verdict === "complete") return "kept";
    if (r.checkout?.sessionId !== closing.sessionId) return "error";
  }
  if (r.consumedAt || r.fulfilling) return "kept";
  if (!r.releasedBy) endHold(r, by);
  return "ended";
}

/**
 * Hold seats. Under the series lock: this browser's hold on exactly these seats comes
 * back unchanged (its clock and checkout kept) while checkout would still take it -
 * prices pinned, under its session cap, `reusable` (the feed's prices and fees still its
 * own); a buyer told to hold again gets a fresh one. Otherwise this browser's other holds on
 * the series end first (an open checkout closed at Stripe before its seats return);
 * then `verify` (the plan, the chain and our own sales, `lib/seating/seat-check.ts`),
 * then - synchronously to the insert - nobody else's live hold names a seat, the count
 * fits `remaining` less what is held, and the per-IP cap.
 */
export async function reserveSeats(a: {
  eventId: string;
  seriesId: string;
  /** Ascending, each once (`parseSeatedReserve`). */
  seats: number[];
  planDigest: string;
  perIpSeatCap: number | (() => number);
  replaceReservationId?: string;
  clientKey?: string;
  ip?: string;
  /** Recorded on the hold (`Reservation.feeKey`). */
  feeKey?: string;
  /** Whether this browser's hold on the same seats may come back as it is. */
  reusable?(r: Reservation): boolean;
  verify(): Promise<SeatVerify>;
  expireSession(c: HoldCheckout): Promise<SessionExpiry>;
}): Promise<SeatedReserveResult> {
  ensureLoaded();
  if (fileUnreadable) return { ok: false, status: 503, error: SEAT_SALES_PAUSED };
  if (a.seats.length < 1 || !validSeats(a.seats, a.seats.length) || !DIGEST_RE.test(a.planDigest)) {
    return { ok: false, status: 400, error: "Invalid seats" };
  }
  const { eventId, seriesId } = a;
  const here = (r: Reservation) => r.eventId === eventId && r.seriesId === seriesId;

  return withSeriesLock(eventId, seriesId, async () => {
    const now = Date.now();
    if (a.clientKey && !a.replaceReservationId) {
      for (const r of reservations.values()) {
        if (here(r) && r.clientKey === a.clientKey && r.seats && r.planDigest === a.planDigest && !r.fulfilling &&
            sameSeats(r.seats, a.seats) && isActive(r, now) && r.seatInfo &&
            (r.checkout?.sessions ?? 0) < MAX_SESSIONS_PER_HOLD && (a.reusable?.(r) ?? true)) {
          return { ok: true, reservation: { ...r }, reused: true };
        }
      }
    }

    const own = [...reservations.values()].filter((r) => here(r) && isActive(r, now) && !r.fulfilling &&
      (r.id === a.replaceReservationId || (!!a.clientKey && r.clientKey === a.clientKey)));
    for (const r of own) {
      // A paid one ("kept") stands as its own order, its seats with it.
      if ((await closeThenEnd(r, "replaced", a.expireSession)) === "error") {
        persistToDisk();
        return { ok: false, status: 503, error: "We couldn't let go of your other seats just now. Try again in a moment." };
      }
    }
    if (own.length) persistToDisk();

    const v = await a.verify();
    if (!v.ok) return v;
    if (v.seats.length !== a.seats.length) return { ok: false, status: 503, error: SEAT_SALES_PAUSED };

    // INVARIANT: synchronous from here to the insert (see the per-IP note in `reserve`).
    const t = Date.now();
    const wanted = new Set(a.seats);
    const conflicts = new Set<number>();
    for (const r of reservations.values()) {
      if (!here(r) || !r.seats || !seatsOffSale(r, t)) continue;
      for (const k of r.seats) if (wanted.has(k)) conflicts.add(k);
    }
    if (conflicts.size) return { ok: false, status: 409, error: SEATS_GONE, conflicts: [...conflicts].sort((x, y) => x - y) };
    const available = Math.max(0, v.remaining - heldFor(eventId, seriesId));
    if (a.seats.length > available) {
      return { ok: false, status: 409, error: available === 0 ? "Sold out" : `Only ${available} seats can be sold now`, available };
    }
    const ipCap = typeof a.perIpSeatCap === "function" ? a.perIpSeatCap() : a.perIpSeatCap;
    if (a.ip && heldSeatsByIp(a.ip, eventId) + a.seats.length > ipCap) {
      return {
        ok: false,
        status: 429,
        error: "Too many seats are already being held from your network. Complete a pending purchase, or try again in a few minutes.",
      };
    }
    const created = new Date(t);
    const r: Reservation = {
      id: randomUUID(),
      eventId,
      seriesId,
      quantity: a.seats.length,
      createdAt: created.toISOString(),
      expiresAt: new Date(t + RESERVATION_TTL_MS).toISOString(),
      ...(a.clientKey ? { clientKey: a.clientKey } : {}),
      ...(a.ip ? { ip: a.ip } : {}),
      seats: [...a.seats],
      planDigest: a.planDigest,
      seatInfo: v.seats.map((s) => ({ ...s })),
      ...(a.feeKey ? { feeKey: a.feeKey } : {}),
    };
    reservations.set(r.id, r);
    persistToDisk();
    return { ok: true, reservation: { ...r } };
  });
}

/**
 * Bind a new Stripe session to a seated hold, in one synchronous step: only while the
 * hold is live, unpaid, and still bound to `prevSessionId` (the session the caller closed
 * at Stripe, or null for the first). Its clock then runs to the session's expiry plus
 * SEATED_HOLD_GRACE_MS. False: the caller closes the new session at Stripe.
 */
export function bindCheckout(
  id: string,
  prevSessionId: string | null,
  s: { sessionId: string; account: string; expiresAtMs: number },
): boolean {
  ensureLoaded();
  const r = reservations.get(id);
  const now = Date.now();
  if (!r || !r.seats || r.consumedAt || r.fulfilling || !isActive(r, now)) return false;
  if ((r.checkout?.sessionId ?? null) !== prevSessionId) return false;
  const sessions = (r.checkout?.sessions ?? 0) + 1;
  if (sessions > MAX_SESSIONS_PER_HOLD) return false;
  r.checkout = { sessionId: s.sessionId, account: s.account, expiresAt: new Date(s.expiresAtMs).toISOString(), sessions };
  r.expiresAt = new Date(Math.max(Date.parse(r.expiresAt), s.expiresAtMs + SEATED_HOLD_GRACE_MS)).toISOString();
  persistToDisk();
  return true;
}

export type SeatedClaim =
  | { ok: true; seats: number[]; planDigest: string; seatInfo?: SeatedHoldSeat[] }
  | { ok: false; reason: string };

/**
 * Fulfilment's claim on a seated hold for a paid session, synchronous (call it before
 * the first await). Only the hold this session was made from: same event and series,
 * seats and pin present, unpaid, and bound to THIS session - a session replaced by a
 * newer one refunds even if it was paid. A hold whose time ran out is still this
 * buyer's while nobody else holds or bought any of its seats (first paid wins; the
 * chain's SeatTaken stays the backstop). Claimed, it stays in force while it mints.
 */
export function claimSeatedHold(
  id: string,
  sessionId: string,
  eventId: string,
  seriesId: string,
  minted: ReadonlySet<number>,
): SeatedClaim {
  ensureLoaded();
  const r = reservations.get(id);
  if (!r) return { ok: false, reason: "the seat hold is gone" };
  if (r.eventId !== eventId || r.seriesId !== seriesId) return { ok: false, reason: "the seat hold is for another ticket type" };
  if (!r.seats || !r.planDigest) return { ok: false, reason: "the hold names no seats" };
  if (r.consumedAt) return { ok: false, reason: "the seat hold was already used" };
  if (r.checkout?.sessionId !== sessionId) return { ok: false, reason: "the hold is not this payment's" };
  if (r.fulfilling && r.fulfilling.sessionId !== sessionId) return { ok: false, reason: "the hold is another payment's" };
  const now = Date.now();
  if (!isActive(r, now)) {
    const mine = new Set(r.seats);
    for (const o of reservations.values()) {
      if (o.id === r.id || o.eventId !== eventId || o.seriesId !== seriesId || !o.seats) continue;
      if ((isActive(o, now) || o.consumedAt) && o.seats.some((k) => mine.has(k))) {
        return { ok: false, reason: "the seats went to another buyer after the hold ran out" };
      }
    }
    if (r.seats.some((k) => minted.has(k))) return { ok: false, reason: "the seats were sold after the hold ran out" };
  }
  r.fulfilling = { sessionId, at: new Date(now).toISOString() };
  persistToDisk();
  return { ok: true, seats: [...r.seats], planDigest: r.planDigest, ...(r.seatInfo ? { seatInfo: r.seatInfo.map((s) => ({ ...s })) } : {}) };
}

/**
 * How fulfilment left a claimed hold. Minted, or unresolved (it may yet land: kept off
 * sale), consumes it; definitively not minted ends it, so the seats return at once.
 */
export function settleSeatedHold(id: string, sessionId: string, outcome: "minted" | "unresolved" | "not-minted"): void {
  ensureLoaded();
  const r = reservations.get(id);
  if (!r || r.consumedAt || r.fulfilling?.sessionId !== sessionId) return;
  if (outcome === "not-minted") endHold(r, "not-minted");
  else r.consumedAt = new Date().toISOString();
  persistToDisk();
}

/**
 * Checkout closed this hold's session at Stripe to open the next one. Stripe's expiry
 * event for it must not end the hold the buyer is paying with now; and until the next
 * session is bound the hold has none payable, so it runs a fresh hold's time at most.
 */
export function markCheckoutClosed(id: string, sessionId: string): void {
  ensureLoaded();
  const r = reservations.get(id);
  if (!r?.checkout || r.checkout.sessionId !== sessionId || r.consumedAt || r.fulfilling) return;
  const now = Date.now();
  r.checkout = { ...r.checkout, expiresAt: new Date(Math.min(Date.parse(r.checkout.expiresAt), now)).toISOString(), closed: true };
  r.expiresAt = new Date(Math.min(Date.parse(r.expiresAt), now + RESERVATION_TTL_MS)).toISOString();
  persistToDisk();
}

/** `checkout.session.expired`: end the hold bound to that session, if it is still waiting on it. */
export function releaseForExpiredSession(sessionId: string): boolean {
  ensureLoaded();
  for (const r of reservations.values()) {
    if (r.checkout?.sessionId !== sessionId) continue;
    if (r.consumedAt || r.fulfilling || r.releasedBy || r.checkout.closed) return false;
    endHold(r, "session-expired");
    persistToDisk();
    return true;
  }
  return false;
}

/** The buyer lets go of a seated hold: its open session closed at Stripe first. Idempotent. */
export async function releaseSeatedHold(
  id: string,
  expireSession: (c: HoldCheckout) => Promise<SessionExpiry>,
): Promise<"released" | "paid" | "error"> {
  ensureLoaded();
  const r = reservations.get(id);
  if (!r) return "released";
  const out = await closeThenEnd(r, "buyer", expireSession);
  persistToDisk();
  return out === "ended" ? "released" : out === "kept" ? "paid" : "error";
}

export interface ReservationsHealth {
  ok: boolean;
  /** The file could not be read: seated sales are paused. The reason is in the log only (health is public). */
  unreadable?: true;
  /**
   * Seated holds in the last hour that carried a Stripe session and ran out by time,
   * against those Stripe's `checkout.session.expired` ended. Lapses with no expiry event
   * at all = the webhook endpoint is not sent that event (a dashboard setting).
   */
  seated: { lapsedWithSession: number; endedBySessionExpiry: number };
}

export function reservationsHealth(): ReservationsHealth {
  ensureLoaded();
  let lapsedWithSession = 0;
  let endedBySessionExpiry = 0;
  for (const r of reservations.values()) {
    if (r.ttlLapsed) lapsedWithSession++;
    if (r.releasedBy === "session-expired") endedBySessionExpiry++;
  }
  return {
    ok: fileUnreadable === null && !(lapsedWithSession > 0 && endedBySessionExpiry === 0),
    ...(fileUnreadable ? { unreadable: true as const } : {}),
    seated: { lapsedWithSession, endedBySessionExpiry },
  };
}

/** Test seam: the GC sweep runs on a timer. */
export function __sweepForTests(): void {
  ensureLoaded();
  sweep();
}

/** Test seam: the store is process-lifetime state. */
export function __resetReservationsForTests(): void {
  reservations.clear();
  loaded = false;
  fileUnreadable = null;
}
