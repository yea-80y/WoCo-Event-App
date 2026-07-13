/**
 * Attendee gate check — is this parent allowed to create a profile / claim
 * a sub-ENS / act socially?
 *
 * Pass conditions (either):
 *   1. A ticket binding exists (proved rightful possession of a purchased
 *      ticket — see routes/attendee-gate.ts).
 *   2. The parent is an organiser (has a creator events directory) — brands
 *      claim sub-ENS and publish profiles without buying tickets.
 *
 * `ATTENDEE_GATE_DISABLED=1` bypasses enforcement (rollout kill-switch);
 * status is still reported so the UI can be exercised.
 */

import { getCreatorEvents } from "../event/service.js";
import { getBindingsForParent } from "./store.js";

export interface GateStatus {
  gated: boolean;
  via?: "ticket" | "organiser" | "disabled";
}

export function gateEnforced(): boolean {
  return process.env.ATTENDEE_GATE_DISABLED !== "1";
}

export async function checkAttendeeGate(parentAddress: string): Promise<GateStatus> {
  if (getBindingsForParent(parentAddress).length > 0) {
    return { gated: true, via: "ticket" };
  }
  const events = await getCreatorEvents(parentAddress).catch(() => []);
  if (events.length > 0) {
    return { gated: true, via: "organiser" };
  }
  if (!gateEnforced()) return { gated: true, via: "disabled" };
  return { gated: false };
}
