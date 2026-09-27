import { orderKeyRef, type CreateEventV3Request, type EventFeed } from "@woco/shared";
import { hexToBytes } from "@noble/hashes/utils.js";

/**
 * Before this client signs a server-ASSEMBLED event feed as its own SOC, refuse it
 * unless the fields whose silent change would matter are what we sent (#642):
 *  - the order key ref is the content address of OUR key (a different ref would
 *    have every buyer seal their details to someone else), and no retired inline
 *    `encryptionKey` rides along;
 *  - the feed signer is ours and the creator is our own account;
 *  - the order form is the one we asked for.
 * Not yet every client-authored field — the rest are tracked separately; these are
 * the ones a signature by our key would otherwise vouch for blind.
 */
export function assertAssembledFeedMatches(
  req: CreateEventV3Request,
  feed: EventFeed,
  own: { feedSigner: string; parent: string },
): void {
  const refuse = (what: string) => {
    throw new Error(`The server returned an event whose ${what} is not what you published - refusing to sign it.`);
  };
  if ("encryptionKey" in (feed as unknown as Record<string, unknown>)) refuse("order key");
  const expectedRef = req.encryptionPublicKey ? orderKeyRef(hexToBytes(req.encryptionPublicKey)) : undefined;
  if (feed.encryptionKeyRef !== expectedRef) refuse("order key");
  if ((feed.creatorFeedSigner ?? "").toLowerCase() !== own.feedSigner.toLowerCase()) refuse("feed signer");
  if ((feed.creatorAddress ?? "").toLowerCase() !== own.parent.toLowerCase()) refuse("creator");
  if (JSON.stringify(feed.orderFields ?? []) !== JSON.stringify(req.orderFields ?? [])) refuse("order form");
}
