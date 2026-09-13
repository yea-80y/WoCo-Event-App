/**
 * The referral campaign's SERVER surface — deliberately two calls.
 *
 * Everything else the campaign knows now lives in signed chunks and is read
 * straight from Swarm (`lib/campaign/records.ts`): the referee's own statement,
 * the issuer's confirmations, the badges, the per-referrer index. The endpoints
 * this file used to wrap — `/referrals/pending`, `/record`, `/relay`,
 * `/referrals/by`, `/badges/:address` — are gone with the EAS rail (#476).
 *
 * What is left is the two things a chunk cannot carry:
 *   · STRIPE ONBOARDING state, which only the platform's Connect account can
 *     see, and which is the precondition the campaign actually pays on;
 *   · the COUNTERSIGN, because the issuer's key is the whole point — a referee
 *     who could write their own confirmation could credit anyone.
 *
 * Server contract: apps/server/src/routes/campaign.ts.
 */

import type { Hex0x, ReferralConfirmationV1 } from "@woco/shared";
import { authGet, authPost } from "./client.js";

/** `POST /api/campaign/referrals/confirm`. */
export interface ConfirmReferralResponse {
  confirmed: ReferralConfirmationV1;
  /** The address the server signed with. Reported rather than assumed so a
   *  reader can weigh it against the pinned `CAMPAIGN_ISSUER_ADDRESS` — a
   *  server whose key derives anything else has written where nobody reads. */
  issuer: Hex0x;
}

/** `GET /api/campaign/referrals/status`. */
export interface ReferralStatusResponse {
  stripeComplete: boolean;
  issuer: Hex0x;
  confirmed: ReferralConfirmationV1 | null;
  /**
   * Whether the confirmation READ answered definitively. `false` means the
   * issuer's feed could not be resolved, NOT that there is no confirmation —
   * so a surface must show nothing rather than "not confirmed yet", which would
   * invite a second confirm of a referral that may already be recorded.
   */
  readOk: boolean;
}

/**
 * Ask the issuer to countersign the referral this account's own feed already
 * claims. `refereeFeed` is the content-feed signer that holds that statement —
 * the discovery binding the confirmation carries forward, so a verifier holding
 * only the confirmation chunk can open the statement under it.
 */
export function confirmReferral(referrer: Hex0x, refereeFeed: Hex0x) {
  return authPost<ConfirmReferralResponse>("/api/campaign/referrals/confirm", {
    referrer,
    refereeFeed,
  });
}

/** Stripe state + any existing confirmation — the two facts the banner gates on. */
export function getReferralStatus() {
  return authGet<ReferralStatusResponse>("/api/campaign/referrals/status");
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
