import { orderKeyRef, type CreateEventV3Request, type EventFeed } from "@woco/shared";
import { hexToBytes } from "@noble/hashes/utils.js";

/**
 * The guard EVERY event-feed signature passes (`signEventFeedSoc`, #642): the
 * create response, the re-sign after on-chain registration, edits, cancel, delete
 * and the sub-ENS stamp. Each of those signs a feed the SERVER assembled, and a
 * signature by the organiser's key vouches for all of it — so refuse one that:
 *  - carries the retired inline `encryptionKey`;
 *  - names an order key other than OUR OWN (every buyer would seal their details
 *    to someone else's key);
 *  - names another feed signer, or another creator than our own account.
 * A feed with no `encryptionKeyRef` is allowed (events without an order key).
 * Other fields are not yet compared on every path — see #719.
 */
export function assertFeedIsOurs(
  feed: EventFeed,
  own: { feedSigner: string; parent: string; orderKeyRef: string | undefined },
): void {
  if ("encryptionKey" in (feed as unknown as Record<string, unknown>)) refuse("order key");
  if (feed.encryptionKeyRef !== undefined && feed.encryptionKeyRef !== own.orderKeyRef) refuse("order key");
  if ((feed.creatorFeedSigner ?? "").toLowerCase() !== own.feedSigner.toLowerCase()) refuse("feed signer");
  if ((feed.creatorAddress ?? "").toLowerCase() !== own.parent.toLowerCase()) refuse("creator");
}

/**
 * At CREATE, additionally: the ref is exactly the key we sent (or absent when we
 * sent none), and the order form is the one we asked for.
 */
export function assertAssembledFeedMatches(
  req: CreateEventV3Request,
  feed: EventFeed,
  own: { feedSigner: string; parent: string },
): void {
  const expectedRef = req.encryptionPublicKey ? orderKeyRef(hexToBytes(req.encryptionPublicKey)) : undefined;
  if (feed.encryptionKeyRef !== expectedRef) refuse("order key");
  assertFeedIsOurs(feed, { ...own, orderKeyRef: expectedRef });
  if (JSON.stringify(feed.orderFields ?? []) !== JSON.stringify(req.orderFields ?? [])) refuse("order form");
}

function refuse(what: string): never {
  throw new Error(`The server returned an event whose ${what} is not yours - refusing to sign it.`);
}
