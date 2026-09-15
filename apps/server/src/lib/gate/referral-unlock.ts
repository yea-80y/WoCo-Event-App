/**
 * "Has anyone this account invited verified with Stripe?" — the referral branch
 * of the attendee gate (#575, owner decision 5 of 2026-09-14).
 *
 * The fact lives on Swarm: the campaign issuer appends every confirmed referee
 * to the referrer's index (`lib/campaign/issuer.ts`, `appendReferrerIndex`) and
 * nothing is ever removed from it. The answer is therefore MONOTONE — once yes,
 * always yes — which is what makes a memo safe: "confirmed" is kept for the life
 * of the process, and only "none" and "unavailable" expire, so a fresh
 * confirmation shows within one window and an outage is retried without every
 * locked member's Home open costing the bee a missing-chunk search.
 *
 * Read at `CAMPAIGN_ISSUER_ADDRESS`, the address every client reads, not at the
 * configured key: a read needs no signer, and a deployment without the key still
 * has the confirmations an earlier one wrote.
 *
 * ABSENT IS NEVER INFERRED FROM A FAULT. The banded read THROWS on any fault but
 * not-found (issuer.ts says the same of the same read), so a throw is
 * `unavailable`; unavailable is refused by the gate — never allowed, it fronts
 * sponsored mints — and never remembered as "none".
 */

import {
  CAMPAIGN_ISSUER_ADDRESS,
  campaignAccountSubject,
  referrerIndexTopic,
  validateReferrerIndexV1,
} from "@woco/shared";
import { readBandedContentFeedJsonResult } from "../swarm/soc-upload.js";

export type ReferralUnlock = "confirmed" | "none" | "unavailable";

/** The three answers, never collapsed into two. */
export type ReferrerIndexRead =
  | { status: "found"; confirmed: number }
  | { status: "absent" }
  | { status: "unavailable" };

export type ReadReferrerIndex = (referrer: string) => Promise<ReferrerIndexRead>;

/** How long a "none" or "unavailable" answer stands before the index is read again. */
export const REFERRAL_UNLOCK_RECHECK_MS = 30_000;

const memo = new Map<string, { status: ReferralUnlock; at: number }>();

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/** The live read. `readBanded` is a parameter only so the suite can pin the address it reads at. */
export async function liveReadReferrerIndex(
  referrer: string,
  readBanded: typeof readBandedContentFeedJsonResult = readBandedContentFeedJsonResult,
): Promise<ReferrerIndexRead> {
  const subject = campaignAccountSubject(referrer.toLowerCase());
  const owner = CAMPAIGN_ISSUER_ADDRESS.replace(/^0x/, "").toLowerCase();
  let res: Awaited<ReturnType<typeof readBandedContentFeedJsonResult>>;
  try {
    res = await readBanded(owner, (band) => referrerIndexTopic(subject, band));
  } catch (err) {
    console.warn(`[gate] referrer index read threw for ${referrer}:`, err);
    return { status: "unavailable" };
  }
  if (res.status === "unavailable") return { status: "unavailable" };
  if (res.status === "absent") return { status: "absent" };
  // Only the issuer writes this topic, so bytes it would never have written read
  // as nothing published (the client's reader says the same) — not as an outage
  // to retry.
  const parsed = parseJson(res.bytes);
  if (!validateReferrerIndexV1(parsed)) return { status: "absent" };
  // `scanClean` is deliberately not consulted: a dirty scan's "found" is a LOWER
  // BOUND on the version, and entries are never removed, so a subject seen at any
  // version was confirmed. The question is "at least one", never "how many".
  return { status: "found", confirmed: parsed.subjects.length };
}

/** Does at least one confirmed referral stand for `address` as the referrer? */
export async function referralUnlock(
  address: string,
  read: ReadReferrerIndex = liveReadReferrerIndex,
  now: () => number = Date.now,
): Promise<ReferralUnlock> {
  const key = address.toLowerCase();
  const hit = memo.get(key);
  if (hit && (hit.status === "confirmed" || now() - hit.at < REFERRAL_UNLOCK_RECHECK_MS)) {
    return hit.status;
  }
  const res = await read(key);
  const status: ReferralUnlock =
    res.status === "found" && res.confirmed > 0
      ? "confirmed"
      : res.status === "unavailable"
        ? "unavailable"
        : "none";
  memo.set(key, { status, at: now() });
  return status;
}

/**
 * The issuer says a confirmation is on Swarm. Remembered from the confirmation
 * itself, not the index: the index append can fail without unmaking it, and
 * propagation plus one recheck window would otherwise stand between a member
 * and the unlock they just earned.
 */
export function noteConfirmedReferral(referrer: string): void {
  memo.set(referrer.toLowerCase(), { status: "confirmed", at: Date.now() });
}

/** Test seam. */
export function resetReferralUnlockMemo(): void {
  memo.clear();
}
