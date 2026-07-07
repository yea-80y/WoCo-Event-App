/** Organiser-side check-in API — door pass issue, roster push, live status. */

import { authPost, authGet } from "./client.js";
import type { EncryptedRoster } from "@woco/shared";

export interface DoorPassIssueResult {
  token: string;
  exp: number;
}

export interface CheckinStatus {
  checkedIn: number;
  bySeries: Record<string, number>;
  lastCheckinAt: string | null;
}

export async function issueDoorPass(eventId: string): Promise<DoorPassIssueResult> {
  const resp = await authPost<DoorPassIssueResult>(`/api/events/${eventId}/door-pass`, {});
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
