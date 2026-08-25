/**
 * Onboarding campaign API client — referral attribution, relay, badges.
 * Server contract: apps/server/src/routes/campaign.ts.
 */

import type { Hex0x, ReferralStatus, ReferralRecord, BadgeRecord, DelegatedSignature } from "@woco/shared";
import { authGet, authPost, get } from "./client.js";

/** Capture link attribution for the signed-in account (first wins, ever). */
export function postPendingReferral(referrer: Hex0x) {
  return authPost<ReferralStatus>("/api/campaign/referrals/pending", { referrer });
}

/** Referral state for the signed-in account — drives the confirm banner. */
export function getReferralStatus() {
  return authGet<ReferralStatus>("/api/campaign/referrals/status");
}

/** Kernel rail: confirm a direct gasless attest by its on-chain UID. */
export function recordReferral(uid: Hex0x) {
  return authPost<ReferralStatus>("/api/campaign/referrals/record", { uid });
}

/** EOA rail: submit the signed delegated attest for server relay (zero gas). */
export function relayReferral(deadline: bigint, signature: DelegatedSignature) {
  return authPost<ReferralStatus>("/api/campaign/referrals/relay", {
    deadline: deadline.toString(),
    signature,
  });
}

/** Confirmed referrals credited to an address (public read). */
export function getReferralsBy(address: Hex0x) {
  return get<ReferralRecord[]>(`/api/campaign/referrals/by/${address}`);
}

/** An address's Joined badge, or null (public read). */
export function getBadge(address: Hex0x) {
  return get<BadgeRecord | null>(`/api/campaign/badges/${address}`);
}

/**
 * The shareable referral link for an account — deliberately whatever origin and
 * path the sharer is browsing.
 *
 * #34 proposed rewriting this to drop a versioned `/bzz/{hash}/` prefix, on the
 * grounds that sharing from one pins the recipient to a frozen build. Checked
 * against the live gateways before building it, and it does not hold:
 *
 *   - gateway.woco-net.com serves the app ONLY under /bzz/{hash}/. Its origin
 *     root 404s, so stripping the prefix produces a dead link — worse than the
 *     defect it was meant to fix.
 *   - the path normally browsed there is the FEED MANIFEST hash, which is
 *     stable across deploys and resolves to the current build. A link shared
 *     from it was never frozen.
 *
 * A fixed canonical host was the other option and is worse again: it bakes one
 * gateway into every build, and an old build would emit whatever host was
 * canonical when it was built — the same frozen-pointer problem one level up.
 *
 * `referrer` is an address or a WoCo sub-ENS label — the router accepts both,
 * so a sharer with a name gets `#/ref/theirvenue` instead of forty hex
 * characters, and the visitor who follows it is told a name rather than hex.
 */
export function referralLink(referrer: Hex0x | string): string {
  return `${window.location.origin}${window.location.pathname}#/ref/${referrer}`;
}

// Ref-link capture moved to lib/campaign/referral-capture.ts, which imports
// nothing — the router reaches capture on every hash change and should not pull
// the API client (and through it a runes module) to write one string.
// Re-exported so existing callers are unaffected.
export {
  storeCapturedRef,
  readCapturedRef,
  clearCapturedRef,
} from "../campaign/referral-capture.js";
