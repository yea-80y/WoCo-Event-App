/**
 * Whether a name picker shows its claim form or its lock panel. The answer is the
 * SERVER'S unlock verdict (lib/gate/check.ts: a ticket, published events, Stripe,
 * or a confirmed invite), read through the gate store - never a Stripe read of the
 * picker's own. Until 2026-10-09 both pickers locked every passkey account on
 * Stripe alone, so a member whose invite had confirmed was sent from Home to
 * "claim your name" and met "verify with Stripe" instead (#476/#575).
 *
 * The lock panel is for passkey accounts only: Stripe is the one unlock a person
 * can start from the panel, and only a passkey account can organise (#746). Any
 * other account gets the form; a refused claim (`ticket_required`) opens the
 * unlock flow, which already says the whole rule.
 *
 * Pure, so the suite can pin it.
 */

import type { GateStatusData } from "../../api/attendee-gate.js";

export type NameLock = "signed-out" | "checking" | "locked" | "open";

export interface NameLockInputs {
  /** Signed in at all. */
  connected: boolean;
  /** A passkey account (`canOrganise`): the only kind the panel can offer Stripe to. */
  organiserKind: boolean;
  /** The server's verdict, null when the store holds none for this account. */
  gate: Pick<GateStatusData, "gated"> | null;
  /** A status read is in flight and nothing is cached: say "checking", not "locked". */
  gateLoading: boolean;
}

export function nameLockFrom(i: NameLockInputs): NameLock {
  if (!i.connected) return "signed-out";
  if (!i.organiserKind) return "open";
  if (i.gate) return i.gate.gated ? "open" : "locked";
  // No verdict and nothing coming (no session yet, or the read failed): show the
  // form. The server enforces the same rule on the claim, and the refusal opens
  // the unlock flow - "locked" here would tell an unlocked member the opposite of
  // the truth on a flaky read.
  return i.gateLoading ? "checking" : "open";
}
