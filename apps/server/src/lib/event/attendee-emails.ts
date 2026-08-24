/**
 * Which email addresses provably hold a ticket for an event — as HMAC hashes.
 *
 * Exists so the broadcast route can prove a recipient is an attendee before
 * sending. The organiser builds that recipient list in their own browser by
 * decrypting sealed order blobs, so the server has to check the addresses it is
 * handed against something it trusts.
 *
 * That something is `attendee-index.ts`, appended at Stripe fulfilment from the
 * verified purchase email. Between #207 (which deleted the v1 claimers feeds)
 * and #387 (which added the index) there was no such source, and this function
 * returned an empty set — which made the membership check vacuous in both
 * directions: verified organisers were waved through to arbitrary addresses,
 * and unverified organisers could reach nobody at all, including to say an
 * event was cancelled. Do not reintroduce a "no proof" fallback; an empty set
 * now means "no attendees recorded", which is the truth.
 */

import type { EventFeed } from "@woco/shared";
import { attendeeEmailHashes } from "./attendee-index.js";

export interface AttendeeEmailSet {
  /** HMAC-SHA256 hashes (hex) of every email PROVABLY holding a ticket. */
  hashes: Set<string>;
  /**
   * Series registered on-chain BEFORE the attendee index existed, whose buyers
   * are therefore not in it. Reported so the failure copy can say "some of this
   * event's tickets predate our attendee records" rather than the flatly wrong
   * "these people have not claimed a ticket". It grants no permission — it is
   * a diagnostic, and nothing branches on it to widen who may be mailed.
   */
  unverifiableSeries: number;
}

/** Collect the provable email hashes for `event` — see module header. */
export function getAttendeeEmailHashes(event: EventFeed): AttendeeEmailSet {
  const hashes = attendeeEmailHashes(event.eventId);
  let unverifiableSeries = 0;
  for (const series of event.series) {
    if (series.swarmManifestRef && series.onChainEventId) {
      unverifiableSeries++;
    }
    // A series without an on-chain registration cannot have been claimed at
    // all — it contributes neither proof nor unverifiability.
  }
  return { hashes, unverifiableSeries };
}
