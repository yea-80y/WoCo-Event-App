/**
 * Undelivered tickets, from the organiser's dashboard (#983). A ticket whose email
 * bounced is held, sealed to the organiser's order key: this client opens it and hands
 * it back to the server to email to the address the buyer gave the organiser. The
 * server never could open it itself.
 */
import type { ApiResponse } from "@woco/shared";
import type { SealedBoxV2 } from "@woco/shared/crypto/sealed-box-shape";
import { authGet, authPost } from "./client.js";
import { openHeldTickets, type HeldCopy } from "../creator/dashboard/held-tickets.js";

export type { HeldCopy };

export interface UndeliveredRow {
  sessionId: string;
  failedAt: string;
  reason: string;
  typedAddress: string | null;
  editions: number[];
  resendsLeft: number;
  blocked: string | null;
}


const base = (eventId: string) => `/api/events/${encodeURIComponent(eventId)}/undelivered`;

/** The caller's events with tickets that did not arrive - the dashboard's badge. */
export function undeliveredSummary(): Promise<ApiResponse<Array<{ eventId: string; sales: number }>>> {
  return authGet<Array<{ eventId: string; sales: number }>>("/api/undelivered/summary", undefined, { establish: false });
}

export function listUndelivered(eventId: string): Promise<ApiResponse<UndeliveredRow[]>> {
  return authGet<UndeliveredRow[]>(base(eventId), undefined, { establish: false });
}

/**
 * Resend one sale's tickets: fetch the held copy, open it here, send it back with the
 * address. `secretKeys` are every order key this device holds, newest first.
 */
export async function resendUndelivered(
  eventId: string,
  sessionId: string,
  to: string,
  secretKeys: Uint8Array[],
  buyerName?: string,
): Promise<ApiResponse<{ sentTo: string; resendsLeft: number }>> {
  const copy = await authGet<HeldCopy>(`${base(eventId)}/${encodeURIComponent(sessionId)}/copy`);
  if (!copy.ok || !copy.data) return { ok: false, error: copy.error ?? "Could not load the held tickets", ...(copy.code ? { code: copy.code } : {}) };
  if (copy.data.eventId !== eventId) return { ok: false, error: "These tickets are not for this event." };
  const { openJsonWithAnyKey } = await import("../keyring/order-keys.js");
  let tickets: Array<{ edition: number; qrContent: string }>;
  try {
    tickets = await openHeldTickets(copy.data, sessionId, secretKeys, openJsonWithAnyKey);
  } catch {
    return { ok: false, error: "This device can't open these tickets. Sign in with the account that made the event." };
  }
  return authPost<{ sentTo: string; resendsLeft: number }>(`${base(eventId)}/${encodeURIComponent(sessionId)}/resend`, {
    to,
    tickets,
    ...(buyerName ? { buyerName } : {}),
  });
}
