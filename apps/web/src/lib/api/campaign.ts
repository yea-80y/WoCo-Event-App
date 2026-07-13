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

/** The shareable referral link for an account. */
export function referralLink(address: Hex0x): string {
  return `${window.location.origin}${window.location.pathname}#/ref/${address}`;
}

// ---------------------------------------------------------------------------
// Ref-link capture — persisted until the visitor's first authenticated moment,
// then posted as a pending attribution (App.svelte effect). Kept in this light
// module so the router can import it without dragging in wallet/kernel deps.
// ---------------------------------------------------------------------------

const REF_STORAGE_KEY = "woco:ref";

/** Persist a referral capture (from #/ref/{address}) until first sign-in. */
export function storeCapturedRef(referrer: string): void {
  if (/^0x[0-9a-fA-F]{40}$/.test(referrer)) {
    localStorage.setItem(REF_STORAGE_KEY, referrer.toLowerCase());
  }
}

export function readCapturedRef(): Hex0x | null {
  const v = localStorage.getItem(REF_STORAGE_KEY);
  return v && /^0x[0-9a-f]{40}$/.test(v) ? (v as Hex0x) : null;
}

export function clearCapturedRef(): void {
  localStorage.removeItem(REF_STORAGE_KEY);
}
