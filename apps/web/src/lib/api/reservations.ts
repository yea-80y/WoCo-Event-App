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

/**
 * Stable per-browser identifier sent with every /reserve call. Server uses
 * it to atomically release this buyer's other active reservations on the
 * same series before allocating a new one — the canonical guard against
 * one buyer accumulating multiple held seats across tab close/reopen,
 * refresh, or sessionStorage loss. Persisted in localStorage so it
 * survives across tabs and sessions on the same browser profile.
 */
const CLIENT_KEY_STORAGE = "woco:client-id";

function getClientKey(): string | null {
  if (typeof window === "undefined") return null;
  try {
    let key = window.localStorage.getItem(CLIENT_KEY_STORAGE);
    if (!key || key.length < 8) {
      key = (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2) + Date.now().toString(36);
      window.localStorage.setItem(CLIENT_KEY_STORAGE, key);
    }
    return key;
  } catch {
    return null;
  }
}

export async function reserveSlots(
  eventId: string,
  seriesId: string,
  quantity: number,
  /**
   * Existing reservation ID to release atomically (server-side, inside the
   * per-series mutex) before allocating the new one. Pass when the buyer is
   * changing quantity — eliminates the self-race where their old hold
   * appears in `heldFor()` while the new request is being validated.
   */
  replaceReservationId?: string,
): Promise<{ ok: true; data: ReservationData } | { ok: false; error: string; available?: number }> {
  const clientKey = getClientKey();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (clientKey) headers["X-Client-Key"] = clientKey;
  const resp = await fetch(
    `${apiBase}/api/events/${eventId}/series/${seriesId}/reserve`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(
        replaceReservationId ? { quantity, replaceReservationId } : { quantity },
      ),
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
