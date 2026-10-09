/**
 * Which keys an event is read and sold under (#186).
 *
 * An event's feed is a SOC owned by its organiser's content-feed signer, and names the
 * order key buyers seal to. Both come from the organiser's account secret, and when a
 * passkey is removed the account moves to a new secret the removed passkey does not
 * have. So once the organiser's account has a key ring:
 *   - the feed is read from the RING's feed signer, never the signer recorded at
 *     create (the removed passkey holds that one and can still write under it);
 *   - the order key is the RING's, whatever the feed says.
 * Without a ring (nothing ever removed) the record pinned at create stands, and the
 * order key is the one the server validated at create, where the record has it.
 *
 * Resolved on every read from the chain (cached in `current-ring.ts`), never stored:
 * the record stays write-once, and there is no second copy to fall out of step.
 */

import type { EventFeed } from "@woco/shared";
import { getRecordedFeedSigner } from "../event/feed-signer-record.js";
import { currentRing } from "./current-ring.js";

export type EventKeys =
  /** The organiser's account has a ring: its keys are the event's. */
  | { kind: "ring"; creator: string; feedSigner: string; orderKeyRef: string; gen: number }
  /** No ring: the keys recorded at create (the order key only for events created since #186). */
  | { kind: "record"; creator: string; feedSigner: string; orderKeyRef: string | null }
  /** No record: a legacy event, read and sold as before. */
  | { kind: "legacy" }
  /** The ring could not be read and none was seen: the feed is NOT read (a removed
   *  passkey may hold the signer we would read it under) - nothing served or sold. */
  | { kind: "unavailable"; creator: string; feedSigner: string; reason: string };

/**
 * `directoryEntry`: for an event with no record (created before #670), its creator
 * and signer from the platform-written directory - trusted, never a request. Such an
 * event is still under its organiser's ring: without this, a removed passkey could go
 * on writing every event the account made before the record existed.
 */
export async function eventKeys(
  eventId: string,
  directoryEntry?: () => Promise<{ creatorAddress: string; creatorFeedSigner?: string } | null>,
): Promise<EventKeys> {
  const rec = getRecordedFeedSigner(eventId);
  let creator: string;
  let signer: string;
  let recordedKey: string | null = null;
  if (rec) {
    creator = rec.creatorAddress.toLowerCase();
    signer = rec.signer;
    recordedKey = rec.orderKeyRef ?? null;
  } else {
    const entry = directoryEntry ? await directoryEntry().catch(() => null) : null;
    if (!entry?.creatorFeedSigner) return { kind: "legacy" };
    creator = entry.creatorAddress.toLowerCase();
    signer = entry.creatorFeedSigner.toLowerCase();
  }
  const r = await currentRing(creator);
  if (r.status === "ring") {
    return { kind: "ring", creator, feedSigner: r.ring.feedSigner, orderKeyRef: r.ring.orderKeyRef, gen: r.ring.gen };
  }
  if (r.status === "none") return { kind: "record", creator, feedSigner: signer, orderKeyRef: recordedKey };
  return { kind: "unavailable", creator, feedSigner: signer, reason: r.reason };
}

/** The signer to read the event's feed from, given the one the caller would have used. */
export function feedSignerFor(keys: EventKeys, requested: string): string {
  return keys.kind === "ring" ? keys.feedSigner : requested;
}

/** The order key buyers must seal to, or null where there is no authority (legacy, unread). */
export function authoritativeOrderKeyRef(keys: EventKeys): string | null {
  return keys.kind === "ring" || keys.kind === "record" ? keys.orderKeyRef : null;
}

const warned = new Set<string>();

/**
 * The feed with the order key it must be sold under. A feed naming another key is
 * either stale (signed before a rotation) or written by a key the account lost; either
 * way buyers seal to the authoritative one, and it is logged once per event and key.
 */
export function withAuthoritativeOrderKey(eventId: string, feed: EventFeed, keys: EventKeys): EventFeed {
  const ref = authoritativeOrderKeyRef(keys);
  if (!ref || feed.encryptionKeyRef === ref) return feed;
  const k = `${eventId}:${feed.encryptionKeyRef ?? "none"}`;
  if (!warned.has(k)) {
    warned.add(k);
    console.error(
      `[keyring] event ${eventId}: feed names order key ${feed.encryptionKeyRef ?? "(none)"}, ` +
        `the organiser's is ${ref} (${keys.kind}) - serving the organiser's`,
    );
  }
  return { ...feed, encryptionKeyRef: ref };
}

/**
 * Was a buyer's order sealed to a key other than the one this event sells under? Once
 * the organiser's account has a key ring, a box sealed to any other key - a page loaded
 * before a passkey was removed, an old embed - may be readable by that passkey: refuse it
 * before anything is charged. Without a ring, an undeclared key passes (a client from
 * before this check), a declared one must match. Boxes do not name their recipient, so
 * this trusts the buyer's own client: it catches stale pages, not liars, and a buyer
 * lying here only exposes their own order.
 */
export function isStaleOrderKey(keys: EventKeys, declared: string | undefined): boolean {
  if (keys.kind === "ring") return declared !== keys.orderKeyRef;
  return keys.kind === "record" && !!keys.orderKeyRef && declared !== undefined && declared !== keys.orderKeyRef;
}

/** Creating an event under keys the account has moved on from. */
export class AccountKeysChangedError extends Error {
  readonly code = "KEYS_CHANGED";
  constructor() {
    super("Your account's keys changed on another device. Reload this page, then publish again - nothing was created.");
    this.name = "AccountKeysChangedError";
  }
}

/** The account's keys could not be read, so a create cannot be checked against them. */
export class AccountKeysUnavailableError extends Error {
  readonly code = "KEYS_UNAVAILABLE";
  constructor() {
    super("Couldn't check your account's keys right now. Nothing was created - please try again in a minute.");
    this.name = "AccountKeysUnavailableError";
  }
}

/**
 * A create must use the account's CURRENT keys: an event signed under a generation the
 * account has left would be read from a signer no reader follows any more.
 */
export async function assertCurrentKeys(creator: string, feedSigner: string, orderKeyRef: string | undefined): Promise<void> {
  const r = await currentRing(creator);
  if (r.status === "unavailable") throw new AccountKeysUnavailableError();
  if (r.status === "none") return;
  if (feedSigner.toLowerCase() !== r.ring.feedSigner || (orderKeyRef !== undefined && orderKeyRef !== r.ring.orderKeyRef)) {
    throw new AccountKeysChangedError();
  }
}
