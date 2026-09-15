/**
 * Home's decisions, pure so the suite can pin them: which name block to show,
 * what the invite line says, and whether an unlock means the account organises.
 */

import type { GateStatusData } from "../../api/attendee-gate.js";
import type { ReferrerIndexRead } from "../../campaign/records.js";

export type NameState = "claimed" | "unlocked" | "locked" | "unknown";

/**
 * A claimed profile name wins; otherwise the unlock status decides. No status
 * yet means say nothing — "locked" shown before the answer arrives would tell an
 * unlocked member the opposite of the truth.
 */
export function nameStateFrom(
  profileName: string | null,
  gateStatus: Pick<GateStatusData, "gated"> | null,
): NameState {
  if (profileName) return "claimed";
  if (!gateStatus) return "unknown";
  return gateStatus.gated ? "unlocked" : "locked";
}

/** The line under the invite. An unanswered read says so and never reads as "none". */
export function inviteStatusText(read: ReferrerIndexRead | null): string | null {
  if (!read) return null;
  if (read.status === "unavailable") return "Couldn't check your invites right now.";
  const count = read.status === "found" ? read.referees.length : 0;
  if (count === 0) return "No verified invites yet. People you invite show up once they verify with Stripe.";
  return count === 1 ? "1 verified invite." : `${count} verified invites.`;
}

/** Whether an unlock reason means the account organises, so Studio can show on a new device. */
export function organisesFromUnlock(via: GateStatusData["via"] | undefined): boolean {
  return via === "organiser";
}
