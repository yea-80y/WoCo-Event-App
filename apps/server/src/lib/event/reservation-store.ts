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
 * Atomicity: the public mutators (`reserve`, `consume`, `release`) are
 * serialised per-series via an in-memory mutex (mirrors the per-series
 * claim queue pattern in routes/claims.ts), so concurrent /reserve calls
 * for the same series can't both grab the last seat.
 *
 * Authority: `available` reported by getClaimStatus is the physical remaining
 * (totalSupply - claimed). Active reservations are NOT subtracted there —
 * doing so would self-double-count the buyer's own hold and break the
 * dropdown / shortfall UX. Concurrency is enforced inside `reserve()`, which
 * subtracts heldFor() before validating, and returns the precise remaining
 * count if the requested quantity can't be satisfied.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const DATA_DIR = join(process.cwd(), ".data");
const STORE_FILE = join(DATA_DIR, "reservations.json");

/** How long a reservation lives before auto-expiring. */
export const RESERVATION_TTL_MS = 10 * 60 * 1000; // 10 min

/** Sweep interval for expired/consumed garbage collection. */
const RESERVATION_GC_INTERVAL_MS = 60 * 1000;

/** Keep consumed/expired entries this long for debugging before deletion. */
const RESERVATION_KEEP_AFTER_MS = 60 * 60 * 1000; // 1 hour

/** Max quantity that can be reserved in one entry (matches Stripe checkout cap). */
export const RESERVATION_MAX_QTY = 10;

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
}

const reservations = new Map<string, Reservation>();
let loaded = false;
let gcTimer: NodeJS.Timeout | null = null;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = readFileSync(STORE_FILE, "utf-8");
    const arr = JSON.parse(raw) as Reservation[];
    for (const r of arr) reservations.set(r.id, r);
    console.log(`[reservations] Loaded ${reservations.size} reservations from disk`);
  } catch {
    // File doesn't exist yet — fine
  }
  // Kick off GC on first access.
  if (!gcTimer) {
    gcTimer = setInterval(sweep, RESERVATION_GC_INTERVAL_MS);
    // Don't block process exit on the GC interval.
    gcTimer.unref?.();
  }
}

function persistToDisk(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(STORE_FILE, JSON.stringify([...reservations.values()]), "utf-8");
  } catch (err) {
    console.error("[reservations] Failed to persist to disk:", err);
  }
}

/** Sweep expired + long-consumed reservations from memory + disk. */
function sweep(): void {
  const now = Date.now();
  let removed = 0;
  for (const [id, r] of reservations) {
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
  if (removed > 0) {
    persistToDisk();
    console.log(`[reservations] Swept ${removed} stale entries`);
  }
}

/** Per-series mutex: serialises reserve/consume/release for a single series. */
const seriesLocks = new Map<string, Promise<void>>();
function withSeriesLock<T>(seriesId: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = seriesLocks.get(seriesId) ?? Promise.resolve();
  const next = prev.then(() => fn());
  seriesLocks.set(seriesId, next.then(() => {}, () => {}));
  return next as Promise<T>;
}

/** Active = not consumed AND not expired. */
function isActive(r: Reservation, now: number): boolean {
  return !r.consumedAt && new Date(r.expiresAt).getTime() > now;
}

/**
 * Total seats currently held by active reservations for a given series.
 * Used inside `reserve()` to enforce concurrency at reservation time, and
 * exposed informationally on SeriesClaimStatus.held.
 */
export function heldFor(seriesId: string): number {
  ensureLoaded();
  const now = Date.now();
  let total = 0;
  for (const r of reservations.values()) {
    if (r.seriesId === seriesId && isActive(r, now)) total += r.quantity;
  }
  return total;
}

export interface ReserveResult {
  ok: true;
  reservation: Reservation;
}
export interface ReserveError {
  ok: false;
  error: "InsufficientSeats" | "InvalidQuantity";
  available?: number;
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
  replaceReservationId?: string,
): Promise<ReserveResult | ReserveError> {
  ensureLoaded();
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > RESERVATION_MAX_QTY) {
    return { ok: false, error: "InvalidQuantity" };
  }

  return withSeriesLock(seriesId, async () => {
    if (replaceReservationId) {
      const prior = reservations.get(replaceReservationId);
      if (prior && prior.seriesId === seriesId && !prior.consumedAt) {
        prior.expiresAt = new Date().toISOString();
      }
    }
    const canonicalAvailable = await availableSupplier();
    const currentlyHeld = heldFor(seriesId);
    const realAvailable = Math.max(0, canonicalAvailable - currentlyHeld);
    if (quantity > realAvailable) {
      return { ok: false, error: "InsufficientSeats", available: realAvailable };
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
