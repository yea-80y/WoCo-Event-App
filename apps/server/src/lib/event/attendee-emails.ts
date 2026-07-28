/**
 * Which email addresses actually hold a ticket for an event — as HMAC hashes.
 *
 * Exists so `/api/events/:id/broadcast` can prove a recipient is an attendee
 * before sending. The organiser builds that recipient list in their own browser
 * by decrypting sealed order blobs, so the server has no way to re-derive it
 * from the request; it has to check the addresses it is handed against
 * something it trusts. The claimers feed is that something — it is written
 * exclusively by the claim path and carries `email:{hash}` handles, never
 * plaintext.
 *
 * This mirrors what `/api/marketing/broadcast` already does against the stored
 * list. Without it, event broadcasts are an ungated send-to-anyone path (they
 * are deliberately not Stripe-gated, on the reasoning that attendee-relationship
 * mail must not depend on Stripe — reasoning that only holds if the recipients
 * really are attendees).
 */

import type { ClaimersFeed, EventFeed } from "@woco/shared";
import { readFeedPage, decodeJsonFeed } from "../swarm/feeds.js";
import { topicClaimers } from "../swarm/topics.js";

/** Prefix used by `ClaimerEntry.claimerAddress` for email-identified claims. */
const EMAIL_HANDLE_PREFIX = "email:";

export interface AttendeeEmailSet {
  /** HMAC-SHA256 hashes (hex) of every email handle holding a ticket. */
  hashes: Set<string>;
  /**
   * Series whose attendee identities the server cannot see. v2 on-chain series
   * record a per-ticket burner address on chain and put the claimer identity
   * inside the sealed order blob only — nothing hashed is written anywhere the
   * server can read. Callers must decide a policy rather than silently treating
   * these as "no attendees" (which would reject every legitimate recipient) or
   * as "all allowed" (which would reopen the hole).
   */
  unverifiableSeries: number;
}

/** Reads one series' claimers feed. Injectable so the logic is testable without Swarm. */
export type ClaimersReader = (seriesId: string) => Promise<ClaimersFeed | null>;

const readClaimersFromSwarm: ClaimersReader = async (seriesId) => {
  const page = await readFeedPage(topicClaimers(seriesId));
  return page ? decodeJsonFeed<ClaimersFeed>(page) : null;
};

/**
 * Collect the email hashes that hold a ticket for `event`.
 *
 * Reads the same v1 claimers feeds as `GET /api/events/:id/orders`, so the set
 * is exactly the population the organiser's dashboard could have decrypted a
 * recipient out of. A series whose feed is missing or unreadable contributes
 * nothing — it cannot manufacture membership.
 */
export async function getAttendeeEmailHashes(
  event: EventFeed,
  readClaimers: ClaimersReader = readClaimersFromSwarm,
): Promise<AttendeeEmailSet> {
  const hashes = new Set<string>();
  let unverifiableSeries = 0;

  for (const series of event.series) {
    if (series.swarmManifestRef && series.onChainEventId) {
      unverifiableSeries++;
      continue;
    }

    let feed: ClaimersFeed | null = null;
    try {
      feed = await readClaimers(series.seriesId);
    } catch (err) {
      console.warn(`[attendee-emails] claimers feed unreadable for ${series.seriesId}:`, err);
    }
    if (!feed?.claimers) continue;

    for (const claimer of feed.claimers) {
      if (claimer.claimerAddress?.startsWith(EMAIL_HANDLE_PREFIX)) {
        hashes.add(claimer.claimerAddress.slice(EMAIL_HANDLE_PREFIX.length).toLowerCase());
      }
      // Wallet buyer who paid by card: the Stripe customer email is recorded
      // alongside the verified address, and is a legitimate broadcast target.
      if (claimer.secondaryEmailHash) {
        hashes.add(claimer.secondaryEmailHash.toLowerCase());
      }
    }
  }

  return { hashes, unverifiableSeries };
}
