/**
 * Identity registry (Phase B — CLIENT_FEED_SIGNER_HANDOVER.md Task 2).
 *
 * A platform-signed pointer feed `woco/identity/{parentAddress}` → the PUBLIC
 * address of the content-feed signing key the user OWNS. This is the discovery
 * layer for client-owned content feeds: a reader knows a user's parent address
 * (Kernel/EOA) but a content SOC is addressed by the user's feed-signer address,
 * which is derived from a secret and not computable from the parent. The registry
 * publishes that mapping.
 *
 * The pointer is written by the SERVER (platform signer), keyed by the VERIFIED
 * parent from the auth middleware — so it cannot be spoofed for someone else's
 * parent. It stores only a public address: the user keeps the signing key, and the
 * registry owns no content feed. This is the write-side analog of the gateway
 * whitelist — server-maintained infra that is mandatory when you stamp on a shared
 * postage batch.
 */

import type { IdentityPointer } from "@woco/shared";
import {
  readFeedPage,
  writeFeedPage,
  encodeJsonFeed,
  decodeJsonFeed,
} from "../swarm/feeds.js";
import { topicIdentity } from "../swarm/topics.js";

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/** Resolve a user's content-feed-signer address, or null if not registered. */
export async function getFeedSigner(parentAddress: string): Promise<string | null> {
  const page = await readFeedPage(topicIdentity(parentAddress));
  if (!page) return null;
  const pointer = decodeJsonFeed<IdentityPointer>(page);
  return pointer?.feedSignerAddress ?? null;
}

/**
 * Bind a content-feed-signer address to the verified parent. Idempotent — a
 * re-register with the same address is a harmless overwrite-in-place. Writes
 * synchronously (deferred:false) so a content write that immediately follows can
 * be resolved by readers.
 */
export async function setFeedSigner(
  parentAddress: string,
  feedSignerAddress: string,
): Promise<IdentityPointer> {
  if (!ADDR_RE.test(feedSignerAddress)) {
    const err = new Error("feedSignerAddress must be a 20-byte 0x hex address") as Error & {
      status: number;
    };
    err.status = 400;
    throw err;
  }
  const pointer: IdentityPointer = {
    v: 1,
    feedSignerAddress: feedSignerAddress.toLowerCase(),
    updatedAt: new Date().toISOString(),
  };
  await writeFeedPage(topicIdentity(parentAddress), encodeJsonFeed(pointer), {
    deferred: false,
  });
  return pointer;
}
