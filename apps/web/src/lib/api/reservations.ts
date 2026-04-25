/**
 * Frontend API client for slot reservations.
 *
 * The reservation lifecycle:
 *   1. Form opens → POST /reserve { quantity } → { reservationId, expiresAt }
 *   2. UI shows countdown until expiresAt
 *   3. User clicks Pay → reservationId passed into createCheckoutSession
 *   4. Webhook consumes the reservation when issuing the ticket
 *
 * On form abandon (route change, tab close, quantity change), call release()
 * — best-effort, idempotent. We use sendBeacon when available so the request
 * survives even when the page is unloading.
 */

import { apiBase } from "./client.js";

export interface ReservationData {
  reservationId: string;
  expiresAt: string; // ISO timestamp
  quantity: number;
}

export async function reserveSlots(
  eventId: string,
  seriesId: string,
  quantity: number,
): Promise<{ ok: true; data: ReservationData } | { ok: false; error: string; available?: number }> {
  const resp = await fetch(
    `${apiBase}/api/events/${eventId}/series/${seriesId}/reserve`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quantity }),
    },
  );
  const json = await resp.json() as
    | { ok: true; data: ReservationData }
    | { ok: false; error: string; available?: number };
  return json;
}

/**
 * Release a reservation. Best-effort: uses sendBeacon when available so the
 * request goes through during pagehide/unload. Always resolves; errors are
 * non-fatal (server-side TTL will expire the reservation anyway).
 */
/** Seconds remaining until the given ISO expiry, clamped at 0. */
export function secondsUntil(expiresAt: string): number {
  const ms = new Date(expiresAt).getTime() - Date.now();
  return Math.max(0, Math.floor(ms / 1000));
}

/** Format `mm:ss` from a seconds count (always 2-digit seconds). */
export function formatCountdown(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function releaseSlots(
  eventId: string,
  seriesId: string,
  reservationId: string,
): void {
  const url = `${apiBase}/api/events/${eventId}/series/${seriesId}/reserve/release`;
  const payload = JSON.stringify({ reservationId });

  if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    try {
      const blob = new Blob([payload], { type: "application/json" });
      const sent = navigator.sendBeacon(url, blob);
      if (sent) return;
    } catch {
      // fall through to fetch
    }
  }

  // Fire-and-forget fetch fallback. keepalive lets the browser send it during
  // navigation events, similar to sendBeacon.
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    keepalive: true,
  }).catch(() => {
    // server-side TTL handles missed releases
  });
}
