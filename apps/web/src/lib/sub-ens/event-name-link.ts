/**
 * The WoCo name an event is live at, for links that leave the app - the CTA of
 * an organiser's announcement email (#576). A name only counts when its content
 * is THIS event's page feed: topic `woco-site-{eventId}`, owned by the event's
 * feed signer (#614). The stored `subEnsLabel` is a display hint and can be
 * stale after a re-point (#537), so it is not used. A name re-pointed AFTER an
 * email is sent takes that link with it, like a domain the organiser owns.
 */

import { eventPageFeedTopic, subEnsWebUrl } from "@woco/shared";
import { id as keccakUtf8 } from "ethers";
import type { OwnedSubEnsName } from "../api/sub-ens.js";
import { WOCO_GATEWAY_URL } from "../swarm/gateways.js";

// Read strictly, as bee reads it (#186): one parser for every feed manifest.
import { feedOfManifestChunk } from "../swarm/feed-manifest.js";
export { feedOfManifestChunk };

export interface EventNameDeps {
  ownedNames(): Promise<OwnedSubEnsName[]>;
  /** A chunk's raw bytes (span + payload), or null when it cannot be read. */
  chunk(hash: string): Promise<Uint8Array | null>;
}

/** A chunk our bee has to pull from the network can hang for its whole retrieval timeout. */
const CHUNK_TIMEOUT_MS = 5000;

/** Live reads. Owned names are read once per call of this (one composer visit):
 *  the server answers them with a full on-chain scan. */
export function liveEventNameDeps(): EventNameDeps {
  let owned: Promise<OwnedSubEnsName[]> | null = null;
  return {
    ownedNames: () => (owned ??= liveDeps.ownedNames()),
    chunk: liveDeps.chunk,
  };
}

const liveDeps: EventNameDeps = {
  async ownedNames() {
    // Lazy: the API module pulls in the auth store, which the pure parts never need.
    const { getOwnedSubEns } = await import("../api/sub-ens.js");
    const res = await getOwnedSubEns();
    return res.ok && res.data ? res.data.names : [];
  },
  async chunk(hash) {
    const res = await fetch(`${WOCO_GATEWAY_URL}/chunks/${hash}`, { signal: AbortSignal.timeout(CHUNK_TIMEOUT_MS) });
    return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
  },
};

/** `subEnsWebUrl(label)` for the organiser's name on this event's page, or null. */
export async function eventNameUrl(
  event: { eventId: string; creatorFeedSigner?: string },
  deps: EventNameDeps = liveDeps,
): Promise<string | null> {
  const signer = event.creatorFeedSigner?.toLowerCase().replace(/^0x/, "");
  if (!signer) return null;
  const topic = keccakUtf8(eventPageFeedTopic(event.eventId)).slice(2);
  // A profile name is pinned to the app, never to an event page.
  const candidates = (await deps.ownedNames()).filter((n) => n.contentHash && n.role !== "profile");
  const verdicts = await Promise.all(candidates.map(async (n) => {
    const bytes = await deps.chunk(n.contentHash!).catch(() => null);
    const feed = bytes ? feedOfManifestChunk(bytes) : null;
    return feed?.owner === signer && feed.topic === topic;
  }));
  const hit = candidates.find((_, i) => verdicts[i]);
  return hit ? subEnsWebUrl(hit.label) : null;
}
