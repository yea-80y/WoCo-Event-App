/** Organiser-side check-in API — door pass issue, roster push, live status. */

import { authPost, authGet } from "./client.js";
import type { DoorMode, DoorPassIssueRequest, EncryptedRoster } from "@woco/shared";

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

/** Issue a pass and register its door entries key (`doorPassRegistration`) in one request. */
export async function issueDoorPass(
  eventId: string,
  mode: DoorMode,
  registration: Omit<DoorPassIssueRequest, "mode">,
): Promise<DoorPassIssueResult> {
  const body: DoorPassIssueRequest = { mode, ...registration };
  const resp = await authPost<DoorPassIssueResult>(`/api/events/${eventId}/door-pass`, { ...body });
  if (!resp.ok || !resp.data) throw new Error(resp.error ?? "Failed to issue door pass");
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
