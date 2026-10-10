/**
 * Attendee gate check — may this parent claim a sub-ENS name, save a profile,
 * upload a photo? One rule, three callers (routes/sub-ens.ts, routes/profiles.ts
 * twice) and one status report (routes/attendee-gate.ts).
 *
 * Owner decision 2026-09-14 (#575): every name stays backed by a real payment or
 * a real identity check. Pass conditions, any one of:
 *   1. A ticket binding — rightful possession of a purchased ticket.
 *   2. Published events — brands claim names without buying tickets. Every
 *      publishable event already needs Stripe, so this is 3 by another route; it
 *      stays ahead of 3 for the `via` it reports, which the client turns into
 *      the Studio link on a fresh device.
 *   3. Completed Stripe verification — the STORED flag. It is written only from
 *      Stripe's own answer (routes/stripe.ts, the account.updated webhook, and
 *      the two live checks that sync it), and the referral confirm pays a
 *      revenue share on the same flag (routes/campaign.ts). A live Stripe call
 *      here would put Stripe's latency and uptime on every profile save and
 *      every Home paint for nothing a name mint needs; paid-event publishing
 *      stays strict because that is the money gate.
 *   4. A confirmed referral — someone this account invited verified with
 *      Stripe. Read from the issuer's referrer index (./referral-unlock.ts).
 *
 * Order: today's `via` for today's accounts, then cost. 1 and 3 are memory; 2 is
 * the memoised Swarm read every call already made; 4 is the only new read, runs
 * only for accounts nothing else unlocks, and is memoised so a locked member's
 * Home does not pay for it on every open.
 *
 * A read that cannot answer REFUSES — the events read always did, as
 * `.catch(() => [])` — and never allows: the gate fronts sponsored mints and
 * stamped storage. It also never ends the walk: a Swarm hiccup on branch 2 must
 * not hide a memory-backed unlock on branch 3.
 *
 * `ATTENDEE_GATE_DISABLED=1` bypasses enforcement (rollout kill-switch); the real
 * reason is still reported when there is one, so the UI can be exercised.
 */

import { getCreatorEvents } from "../event/service.js";
import { stripeVerificationComplete } from "../stripe/accounts.js";
import { referralUnlock, type ReferralUnlock } from "./referral-unlock.js";
import { getBindingsForParent } from "./store.js";

export type GateVia = "ticket" | "organiser" | "stripe" | "referral" | "disabled";

export interface GateStatus {
  gated: boolean;
  via?: GateVia;
}

/** The facts the rule reads, injected so the rule can be pinned without a bee, a Stripe record or `.data`. */
export interface GateDeps {
  bindingCount(parent: string): number;
  creatorEvents(parent: string): Promise<unknown[]>;
  stripeVerified(parent: string): boolean;
  referralUnlock(parent: string): Promise<ReferralUnlock>;
  enforced(): boolean;
}

export function gateEnforced(): boolean {
  return process.env.ATTENDEE_GATE_DISABLED !== "1";
}

function liveGateDeps(): GateDeps {
  return {
    bindingCount: (parent) => getBindingsForParent(parent).length,
    creatorEvents: (parent) => getCreatorEvents(parent),
    stripeVerified: stripeVerificationComplete,
    referralUnlock: (parent) => referralUnlock(parent),
    enforced: gateEnforced,
  };
}

export async function checkAttendeeGate(
  parentAddress: string,
  deps: GateDeps = liveGateDeps(),
): Promise<GateStatus> {
  const parent = parentAddress.toLowerCase();
  if (deps.bindingCount(parent) > 0) {
    return { gated: true, via: "ticket" };
  }
  const events = await deps.creatorEvents(parent).catch((): unknown[] => []);
  if (events.length > 0) {
    return { gated: true, via: "organiser" };
  }
  if (deps.stripeVerified(parent)) {
    return { gated: true, via: "stripe" };
  }
  const referral = await deps.referralUnlock(parent).catch((): ReferralUnlock => "unavailable");
  if (referral === "confirmed") {
    return { gated: true, via: "referral" };
  }
  if (!deps.enforced()) return { gated: true, via: "disabled" };
  return { gated: false };
}
