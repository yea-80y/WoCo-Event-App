/**
 * A feed manifest's address, worked out from the feed it follows (#614 names). Its own
 * module so the strict reader in `feed-manifest.ts` stays light; the builder itself is
 * shared with the server (`@woco/shared/swarm/feed-manifest`), which stores manifests
 * the same way (#912), and loads only where a name is pointed.
 */

import { feedManifestFor } from "@woco/shared/swarm/feed-manifest";

export { expectedFeedManifestHash, feedManifestFor, feedManifestRootChunk } from "@woco/shared/swarm/feed-manifest";

/** A name target that is not the manifest of the feed this device signs. */
export class FeedManifestMismatchError extends Error {
  constructor() {
    super("Refusing to sign: this page's address isn't the one your account publishes. Nothing was signed. Please report this.");
    this.name = "FeedManifestMismatchError";
  }
}

/**
 * Refuse unless `manifest` is the manifest of `feed` (this device's own feed signer and
 * the page's topic string). A name that follows a feed answers to whoever signs that feed,
 * and the manifest hash otherwise comes from the server's deploy reply.
 */
export function assertOwnFeedManifest(manifest: string, feed: { owner: string; topic: string }): void {
  const served = manifest.replace(/^0x/, "").toLowerCase();
  const expected = feedManifestFor(feed.owner, feed.topic);
  if (served !== expected) {
    // What a "please report this" needs: which side moved.
    console.warn("[sub-ens] feed manifest mismatch", { served, expected, owner: feed.owner, topic: feed.topic });
    throw new FeedManifestMismatchError();
  }
}
