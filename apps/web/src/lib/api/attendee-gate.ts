/**
 * Attendee gate API — prove rightful possession of a purchased ticket to
 * unlock the account (profile, sub-ENS, social). Server: routes/attendee-gate.ts;
 * design: docs/ATTENDEE_GATE_RESALE_PLAN.md §3.
 */

import type { ApiResponse } from "@woco/shared";
import { authGet, authPost, post } from "./client.js";

export interface GateBindingSummary {
  eventId: string;
  seriesId: string;
  edition: number;
  boundAt: string;
}

export interface GateStatusData {
  gated: boolean;
  via?: "ticket" | "organiser" | "disabled";
  bindings: GateBindingSummary[];
}

export function getGateStatus(): Promise<ApiResponse<GateStatusData>> {
  return authGet<GateStatusData>("/api/attendee-gate/status");
}

// Route B (ticket link + email → code) and bind-wallet were deleted with the
// v1 claim rail — both read claim records only the v1 Swarm feeds held, so no
// on-chain ticket could ever pass them. The unlock path is the email CTA token.

// ---------------------------------------------------------------------------
// Route A — email CTA token (signup landing)
// ---------------------------------------------------------------------------

export interface GateTokenInfo {
  eventId: string;
  seriesId: string;
  edition: number;
  eventTitle?: string;
  eventDate?: string;
  eventLocation?: string;
  seriesName?: string;
  /** Ticket already unlocked an account (first click won). */
  consumed: boolean;
}

/** Unauthenticated preview of the email-CTA token — lets the signup landing
 *  show WHICH ticket/event is being linked before an account exists. */
export function getGateTokenInfo(token: string): Promise<ApiResponse<GateTokenInfo>> {
  return post<GateTokenInfo>("/api/attendee-gate/token-info", { token });
}

/** Redeem the email-CTA token against the signed-in account (one-shot). */
export function redeemGateToken(
  token: string,
  podPubKey?: string,
): Promise<ApiResponse<{ gated: boolean; via: string; eventId: string; seriesId: string; edition: number }>> {
  return authPost("/api/attendee-gate/redeem", { token, podPubKey });
}

/** True when a server error means "account not unlocked yet" — callers route
 *  to the gate flow instead of surfacing the raw error string. */
export function isTicketRequired(error: unknown): boolean {
  const msg =
    typeof error === "string" ? error : error instanceof Error ? error.message : "";
  return msg.includes("ticket_required");
}
