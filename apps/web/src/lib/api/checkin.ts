/** Organiser-side check-in API — door pass issue, roster push, live status. */

import { authPost, authGet } from "./client.js";
import type { DoorMode, DoorPassChallenge, DoorPassIssueRequest, EncryptedRoster } from "@woco/shared";

export interface DoorPassIssueResult {
  token: string;
  exp: number;
  mode: DoorMode;
}

export interface CheckinStatus {
  checkedIn: number;
  bySeries: Record<string, number>;
  lastCheckinAt: string | null;
}

/** Step 1 of issuing a pass: a nonce sealed to the account's order key. */
export async function requestDoorPassChallenge(eventId: string): Promise<DoorPassChallenge> {
  const resp = await authPost<DoorPassChallenge>(`/api/events/${eventId}/door-pass/challenge`, {});
  if (!resp.ok || !resp.data) throw new Error(resp.error ?? "Couldn't start the door pass");
  return resp.data;
}

/**
 * Step 2: issue the pass and register its door entries key, with the order-key proof.
 * A refusal carries the server's `reason` ("challenge-expired": ask for a new challenge).
 */
export async function issueDoorPass(eventId: string, request: DoorPassIssueRequest): Promise<DoorPassIssueResult> {
  const resp = await authPost<DoorPassIssueResult>(`/api/events/${eventId}/door-pass`, { ...request });
  if (!resp.ok || !resp.data) {
    const reason = (resp as { reason?: unknown }).reason;
    throw Object.assign(new Error(resp.error ?? "Failed to issue door pass"), typeof reason === "string" ? { reason } : {});
  }
  return resp.data;
}

export async function pushCheckinRoster(
  eventId: string,
  roster: Pick<EncryptedRoster, "iv" | "ciphertext">,
): Promise<void> {
  const resp = await authPost(`/api/events/${eventId}/checkin-roster`, roster);
  if (!resp.ok) throw new Error(resp.error ?? "Failed to upload roster");
}

export async function getCheckinStatus(eventId: string): Promise<CheckinStatus> {
  const resp = await authGet<CheckinStatus>(`/api/events/${eventId}/checkin-status`);
  if (!resp.ok || !resp.data) throw new Error(resp.error ?? "Failed to load check-in status");
  return resp.data;
}
