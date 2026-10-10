/**
 * The cohort badge seam (#476).
 *
 * Badges are issued LAZILY, on a user's first meaningful action — a publish, a
 * confirmed referral — and never on raw signup, so a farm of bot profiles
 * cannot mint epoch-0 badges. That policy is the only thing this file owns; the
 * write itself is a signed Swarm record and lives in `issuer.ts` with the rest
 * of the campaign key's work.
 *
 * This module survives as the NAME every success path already calls. It is
 * deliberately a wrapper and not a re-export: `issueBadge` takes injectable
 * deps, and a caller firing and forgetting from a request handler should not be
 * able to pass any.
 */

import { currentEpoch, issueBadge } from "./issuer.js";

export { currentEpoch };

/**
 * Issue the Joined badge for `address`, once ever.
 *
 * Fire-and-forget safe: `issueBadge` dedupes against an in-flight set, refuses
 * to write over a badge that already exists — including a revoked one — and
 * never throws. A failed attempt retries on the user's next qualifying action.
 */
export async function issueJoinedBadge(address: string): Promise<void> {
  await issueBadge(address);
}
