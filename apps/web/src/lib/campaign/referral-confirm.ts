/**
 * Confirming a referral without a click (owner decision 2026-10-09).
 *
 * The confirm used to wait for the referee to press a button on Home once their
 * Stripe onboarding was done, and the owner, testing the flow end to end, never
 * saw it: the referrer got no unlock and no badge, and nothing said why. The
 * press guarded nothing. The statement it countersigns is already public on the
 * referee's own feed, written when they followed the invite, and the server
 * re-checks every condition (Stripe complete, statement live, not a
 * self-referral, first confirmed wins) before it signs anything. So the confirm
 * runs by itself when the same reads that used to show the button say it is
 * due, and the button survives only as the retry for an attempt that failed.
 *
 * Pure, and its only imports are TYPES, for the reason `referral-flow.ts` gives:
 * the rules are testable without a browser, a wallet or a network.
 */

import type { Hex0x, ReferralConfirmationV1 } from "@woco/shared";

export interface ConfirmFacts {
  /** The referee's live statement, from their own feed. */
  statement: { referrer: Hex0x } | null;
  /** `GET /api/campaign/referrals/status`, or null when it did not answer. */
  status: { stripeComplete: boolean; readOk: boolean; confirmed: ReferralConfirmationV1 | null } | null;
}

/**
 * Whether a confirmation is owed and nothing stands in for it.
 *
 * `readOk` is load-bearing: a confirmation read that could not answer may be
 * hiding one that stands, and confirming over it asks the issuer for a second
 * record it will refuse as a conflict - or, against a different referrer, says
 * so to the referee as if they had done something wrong.
 */
export function confirmDue(f: ConfirmFacts): boolean {
  return (
    f.statement !== null &&
    f.status !== null &&
    f.status.stripeComplete &&
    f.status.readOk &&
    f.status.confirmed === null
  );
}

export type AutoConfirmOutcome =
  | { kind: "skip" }
  | { kind: "confirmed"; record: ReferralConfirmationV1 }
  | { kind: "failed"; error: string };

export interface AutoConfirmDeps {
  facts: ConfirmFacts;
  /** The referee's content-feed signer: where the server reads the statement. */
  feed: Hex0x;
  /**
   * True while the account the facts were read for is still the signed-in one.
   * The request is authenticated as whoever is signed in WHEN IT IS SENT, so
   * facts read for one account and posted under another would ask the issuer
   * to credit the first account's referrer from the second.
   */
  stillSameAccount: () => boolean;
  confirm: (
    referrer: Hex0x,
    feed: Hex0x,
  ) => Promise<{ ok: boolean; data?: { confirmed: ReferralConfirmationV1 }; error?: string }>;
}

export async function autoConfirmReferral(deps: AutoConfirmDeps): Promise<AutoConfirmOutcome> {
  if (!confirmDue(deps.facts) || !deps.stillSameAccount()) return { kind: "skip" };
  try {
    const resp = await deps.confirm(deps.facts.statement!.referrer, deps.feed);
    if (resp.ok && resp.data) return { kind: "confirmed", record: resp.data.confirmed };
    return { kind: "failed", error: resp.error ?? "Could not confirm the referral - try again." };
  } catch (err) {
    return { kind: "failed", error: err instanceof Error ? err.message : "Could not confirm the referral - try again." };
  }
}
