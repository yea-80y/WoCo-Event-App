/**
 * DOM-free seat-hold rules for the buy panel (#568). The lifecycle mirrors the
 * main app's (apps/web/src/lib/attendee/events/claim/useReservation.svelte.ts):
 * hold when the panel opens, count down, re-issue on a quantity change, release
 * on Cancel. Kept out of the custom element so the decisions are testable, the
 * same way checkout.ts is.
 */

import { isSaleClosedCode } from "@woco/shared";
import type { SeatedHold } from "@woco/shared/seating/reserve";

export interface Hold {
  reservationId: string;
  /** ISO timestamp at which the server drops the hold. */
  expiresAt: string;
  quantity: number;
}

/** Whole seconds until `expiresAt`, clamped at 0. An unparseable date counts as expired. */
export function secondsUntil(expiresAt: string, nowMs: number): number {
  const ms = new Date(expiresAt).getTime() - nowMs;
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
}

/** `m:ss`, the main app pill's format. */
export function formatCountdown(secs: number): string {
  const s = Number.isFinite(secs) ? Math.max(0, Math.floor(secs)) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export type HoldResult =
  | { kind: "held"; hold: Hold }
  | { kind: "refused"; message: string }
  /** Not on sale at all (no confirmed privacy notice, or a legacy event): the panel closes. */
  | { kind: "closed"; message: string }
  | { kind: "unavailable" };

type ReserveResponse = {
  ok: boolean;
  error?: string;
  code?: unknown;
  data?: { reservationId?: unknown; expiresAt?: unknown; quantity?: unknown };
  available?: unknown;
  physicalAvailable?: unknown;
} | null;

/**
 * What a /reserve response means for the open panel.
 *
 * "Insufficient seats" is the route's stable literal; its counts separate a
 * sell-out from seats sitting inside other buyers' holds, because telling a
 * buyer on quantity 1 to reduce quantity would be wrong. Any other server
 * message is shown as sent. No response at all (network failure) or a
 * malformed success stays quiet: the checkout click still reserves and
 * create-checkout re-checks, so a broken hold must never read as a refusal.
 */
export function holdResult(resp: ReserveResponse): HoldResult {
  if (!resp) return { kind: "unavailable" };
  if (resp.ok) {
    const d = resp.data;
    if (
      d &&
      typeof d.reservationId === "string" && d.reservationId &&
      typeof d.expiresAt === "string" &&
      Number.isInteger(d.quantity) && (d.quantity as number) >= 1
    ) {
      return {
        kind: "held",
        hold: { reservationId: d.reservationId, expiresAt: d.expiresAt, quantity: d.quantity as number },
      };
    }
    return { kind: "unavailable" };
  }
  if (typeof resp.error !== "string" || !resp.error) return { kind: "unavailable" };
  if (isSaleClosedCode(resp.code)) return { kind: "closed", message: resp.error };
  if (resp.error === "Insufficient seats") {
    const available = typeof resp.available === "number" ? resp.available : null;
    const physical = typeof resp.physicalAvailable === "number" ? resp.physicalAvailable : null;
    if (available === 0 && physical !== null && physical > 0) {
      return { kind: "refused", message: "All remaining tickets are currently held by other buyers - try again in a few minutes." };
    }
    if (available === 0) return { kind: "refused", message: "Sold out." };
    if (available !== null) {
      return {
        kind: "refused",
        message: `Only ${available} ticket${available === 1 ? "" : "s"} available - please reduce quantity.`,
      };
    }
    return { kind: "refused", message: "Not enough tickets left at this quantity" };
  }
  return { kind: "refused", message: resp.error };
}

export type SeatHoldResult =
  | { kind: "held"; hold: Hold; seated: SeatedHold }
  /** `conflicts`: seats someone else has, for the map to mark. */
  | { kind: "refused"; message: string; conflicts: number[] }
  | { kind: "unavailable" };

const isMinor = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/**
 * What a seated /reserve response means (docs/SEATING.md). A hold is used only when its
 * reply is whole: one entry per seat with a label and prices, and the order's amounts.
 * Those figures are the only ones the panel shows for a seated order - never a price
 * worked out here from the event's bands.
 */
export function seatHoldResult(resp: unknown): SeatHoldResult {
  const r = resp as { ok?: unknown; error?: unknown; conflicts?: unknown; data?: Partial<SeatedHold> } | null;
  if (!r || typeof r !== "object") return { kind: "unavailable" };
  if (r.ok !== true) {
    if (typeof r.error !== "string" || !r.error) return { kind: "unavailable" };
    const conflicts = Array.isArray(r.conflicts) ? r.conflicts.filter((k): k is number => Number.isSafeInteger(k) && k >= 0) : [];
    return { kind: "refused", message: r.error.slice(0, 300), conflicts };
  }
  const d = r.data;
  const a = d?.amounts;
  const ok = !!d && typeof d.reservationId === "string" && !!d.reservationId && typeof d.expiresAt === "string" &&
    Number.isInteger(d.quantity) && (d.quantity as number) >= 1 &&
    Array.isArray(d.seats) && d.seats.length === d.quantity &&
    d.seats.every((s) => !!s && typeof s.label === "string" && isMinor(s.priceMinor) && isMinor(s.chargeMinor)) &&
    !!a && typeof a.currency === "string" && typeof a.mode === "string" &&
    [a.subtotalMinor, a.orderFeeMinor, a.bookingFeeMinor, a.totalMinor].every(isMinor) && Number.isFinite(a.feePercent);
  if (!ok) return { kind: "unavailable" };
  const seated = d as SeatedHold;
  return { kind: "held", hold: { reservationId: seated.reservationId, expiresAt: seated.expiresAt, quantity: seated.quantity }, seated };
}

/**
 * The hold checkout may carry: one for exactly the quantity being bought and
 * not yet expired. Anything else means the click must reserve afresh.
 */
export function usableHold(hold: Hold | null, quantity: number, nowMs: number): Hold | null {
  if (!hold || hold.quantity !== quantity) return null;
  return secondsUntil(hold.expiresAt, nowMs) > 0 ? hold : null;
}
