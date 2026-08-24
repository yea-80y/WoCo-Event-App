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
 *
 * THE STORE KEY COMES FROM THE CALLER, NEVER FROM THE FEED. `eventId` is the
 * route parameter that ownership was resolved against; `event.eventId` is a
 * field in a feed body. For a Phase B event that body is a CLIENT-SIGNED SOC
 * which the server never writes, and `getEventBySigner` (`event/service.ts`)
 * does not check that the body's `eventId` matches the topic it was read from.
 * So an organiser could register their own event Y, sign its content SOC with a
 * body claiming `eventId: "Z"`, pass the `creatorAddress === org` check they
 * also control, and have this function load VICTIM EVENT Z's attendee set into
 * their job snapshot. Since the chunk endpoint answers accept/reject against
 * that set, it would become a cross-event attendance oracle — "did this person
 * attend Z?" — answerable at draft time with no send and no rate limit. Keying
 * on the trusted parameter closes it; for a legitimate event the two values are
 * equal, so nothing else changes. Same class as #377.
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

/**
 * Collect the provable email hashes for `event` — see module header.
 *
 * @param eventId TRUSTED id — the route parameter, not `event.eventId`.
 * @param event Used ONLY for its series list, which feeds the diagnostic.
 */
export function getAttendeeEmailHashes(event: EventFeed, eventId: string): AttendeeEmailSet {
  const hashes = attendeeEmailHashes(eventId);
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
