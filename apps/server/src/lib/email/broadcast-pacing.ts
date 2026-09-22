/**
 * Where broadcasts meet sender pacing (#619). The pacing module knows senders,
 * batches and hashes; this file is the only place that says what those mean
 * for an organiser's marketing broadcast. Kept out of the route so the rules
 * are testable without an authenticated HTTP harness.
 */

import { getConsent } from "../marketing/consent-store.js";
import { isProven, pacingState, pacingWindow } from "../sender-pacing/index.js";
import { pacingNotice } from "./pacing-copy.js";

/**
 * Has this organiser already reached this contact through us? Either the
 * pacing ledger holds proof (accepted, and not suppressed an hour later), or
 * the person opted in at one of this organiser's own checkouts — an address
 * they typed to receive a ticket we then sent, which a hard bounce would since
 * have suppressed. Per organiser only: proof for one sender says nothing about
 * another's list.
 *
 * One definition, read by both the upload classification and `/check`, so the
 * composer's "140 go straight away" is the number the send path acts on.
 */
export function reachedBefore(org: string, hash: string): boolean {
  return isProven(org, hash) || getConsent(hash, org)?.source === "checkout";
}

export interface StartRefusal {
  message: string;
  status: 403 | 429;
  code: "SENDER_STOPPED" | "SENDER_PAUSED";
}

/**
 * Whether a marketing broadcast may start at all. A stopped sender, or one
 * whose every send is paused on complaints, has nothing that could go — so it
 * is refused before the hourly window or the daily cap are spent on it. A
 * pause for NEW contacts only still starts: proven contacts go now and the new
 * ones wait on their own.
 */
export function pacingStartRefusal(org: string, at = Date.now()): StartRefusal | null {
  const state = pacingState(org, at);
  const blocked = state.kind === "stopped" || (state.kind === "held" && state.scope === "all");
  if (!blocked) return null;
  return {
    message: pacingNotice(state, pacingWindow(org, at)) ?? "Marketing email is paused on your account.",
    status: state.kind === "stopped" ? 403 : 429,
    code: state.kind === "stopped" ? "SENDER_STOPPED" : "SENDER_PAUSED",
  };
}
