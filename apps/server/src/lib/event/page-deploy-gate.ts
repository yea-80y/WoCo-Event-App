/**
 * Who may publish an event's page, and whose key owns its feed (#614, #679).
 *
 * Only the event's creator, and the feed belongs to the content-feed signer
 * pinned for the event at create (#676) - never a value from the request. The
 * page deploy had no creator check at all, so any signed-in account could
 * advance an event's platform-owned page feed (#679); with the page feed now the
 * organiser's own, the platform key never decides what a name following it shows.
 *
 * Pure, with the record read injected, so the rule is tested rather than trusted.
 */

import type { Hex0x } from "@woco/shared";
import {
  feedSignerRecordHealth,
  getRecordedFeedSigner,
  type FeedSignerRecord,
} from "./feed-signer-record.js";

export type PageDeployGate =
  | { ok: true; signer: Hex0x }
  | { ok: false; status: 403 | 404 | 503; error: string };

export interface PageDeployGateDeps {
  getRecord: (eventId: string) => FeedSignerRecord | null;
  storeHealthy: () => boolean;
}

const defaultDeps: PageDeployGateDeps = {
  getRecord: getRecordedFeedSigner,
  storeHealthy: () => feedSignerRecordHealth().ok,
};

export function eventPageDeployGate(
  eventId: string,
  parentAddress: string,
  deps: PageDeployGateDeps = defaultDeps,
): PageDeployGate {
  const record = deps.getRecord(eventId);
  if (!record) {
    // A record we could not read is not "no such event": the organiser would be
    // told to recreate an event that is fine.
    if (!deps.storeHealthy()) {
      return { ok: false, status: 503, error: "Event pages can't be published right now - please try again shortly" };
    }
    // Events created before the record existed have no organiser key on file,
    // and the platform no longer publishes a page feed of its own (#614).
    return {
      ok: false,
      status: 404,
      error: "This event can't have an event page yet - create the event again, then publish its page",
    };
  }
  if (record.creatorAddress !== parentAddress.toLowerCase()) {
    return { ok: false, status: 403, error: "Only the event's creator can publish its page" };
  }
  return { ok: true, signer: record.signer };
}
