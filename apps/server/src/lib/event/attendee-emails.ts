/**
 * Which email addresses provably hold a ticket for an event — as HMAC hashes.
 *
 * Exists so `/api/events/:id/broadcast` can prove a recipient is an attendee
 * before sending. The organiser builds that recipient list in their own
 * browser by decrypting sealed order blobs, so the server has to check the
 * addresses it is handed against something it trusts.
 *
 * On the on-chain rail there is nothing to check against: the contract
 * records a per-ticket burner address, and the claimer identity lives only
 * inside the sealed order blob the server cannot read. The v1 claimers feeds
 * that once proved email membership are gone with the v1 rail — so the proven
 * set is EMPTY, every on-chain series is `unverifiableSeries`, and event
 * broadcasts ride the marketing abuse gate (`allowUnproven` = verified
 * organiser) alone. Callers must keep deciding a policy rather than treating
 * "no proof" as "no attendees" or as "all allowed".
 */

import type { EventFeed } from "@woco/shared";

export interface AttendeeEmailSet {
  /** HMAC-SHA256 hashes (hex) of every email PROVABLY holding a ticket.
   *  Always empty now — kept so the broadcast membership contract (and the
   *  failure copy it selects) is decided in one place, not inferred. */
  hashes: Set<string>;
  /** Series whose attendee identities the server cannot see (every registered
   *  on-chain series). */
  unverifiableSeries: number;
}

/** Collect the provable email hashes for `event` — see module header. */
export function getAttendeeEmailHashes(event: EventFeed): AttendeeEmailSet {
  let unverifiableSeries = 0;
  for (const series of event.series) {
    if (series.swarmManifestRef && series.onChainEventId) {
      unverifiableSeries++;
    }
    // A series without an on-chain registration cannot have been claimed at
    // all — it contributes neither proof nor unverifiability.
  }
  return { hashes: new Set(), unverifiableSeries };
}
