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

/** The JSON a bee feed manifest carries on its root fork. */
const FEED_METADATA = /\{[^{}]*"swarm-feed-owner"[^{}]*\}/;

/**
 * The feed a manifest root chunk follows, or null when it is not a feed
 * manifest or its bytes are obfuscated. Both come back lowercase, no `0x`.
 */
export function feedOfManifestChunk(chunk: Uint8Array): { owner: string; topic: string } | null {
  const match = new TextDecoder("latin1").decode(chunk).match(FEED_METADATA);
  if (!match) return null;
  try {
    const meta = JSON.parse(match[0]) as Record<string, unknown>;
    const owner = String(meta["swarm-feed-owner"] ?? "").toLowerCase();
    const topic = String(meta["swarm-feed-topic"] ?? "").toLowerCase();
    return /^[0-9a-f]{40}$/.test(owner) && /^[0-9a-f]{64}$/.test(topic) ? { owner, topic } : null;
  } catch {
    return null;
  }
}

export interface EventNameDeps {
  ownedNames(): Promise<OwnedSubEnsName[]>;
  /** A chunk's raw bytes (span + payload), or null when it cannot be read. */
  chunk(hash: string): Promise<Uint8Array | null>;
}

const liveDeps: EventNameDeps = {
  async ownedNames() {
    // Lazy: the API module pulls in the auth store, which the pure parts never need.
    const { getOwnedSubEns } = await import("../api/sub-ens.js");
    const res = await getOwnedSubEns();
    return res.ok && res.data ? res.data.names : [];
  },
  async chunk(hash) {
    const res = await fetch(`${WOCO_GATEWAY_URL}/chunks/${hash}`);
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
  for (const n of await deps.ownedNames()) {
    // A profile name is pinned to the app, never to an event page.
    if (!n.contentHash || n.role === "profile") continue;
    const bytes = await deps.chunk(n.contentHash).catch(() => null);
    const feed = bytes ? feedOfManifestChunk(bytes) : null;
    if (feed?.owner === signer && feed.topic === topic) return subEnsWebUrl(n.label);
  }
  return null;
}
