/**
 * A feed manifest's address, worked out from the feed it follows (#614 names). Its own
 * module so the strict reader in `feed-manifest.ts` stays dependency-free; this one needs
 * the chunk hash, and loads only where a name is pointed.
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import { calculateCacAddress, encodeSpan } from "@woco/shared/swarm/soc";
import { ADDRESS_BYTES, SLASH, TYPE_WITH_METADATA, VERSION_02, hex } from "./feed-manifest.js";

const TYPE_VALUE = 2;

function unhex(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function cacAddress(payload: Uint8Array): Uint8Array {
  return calculateCacAddress(encodeSpan(payload.length), payload);
}

/**
 * The root chunk (span + payload) of the feed manifest bee makes for `owner`'s feed at
 * `topic` (both lowercase hex, no `0x`; `topic` is the 32-byte topic, already hashed).
 * Bee writes a feed manifest in the clear (a zero obfuscation key), so its bytes depend
 * on the feed alone: the layout above with a zero root target, and one "/" fork whose
 * child is an empty node - a zero target and no forks, the same bytes for every feed.
 * Pinned to a production chunk, not to bee-js: bee-js drops a "/" node's zero target,
 * so the manifest it builds has another child address than the one bee serves.
 */
export function feedManifestRootChunk(owner: string, topic: string): Uint8Array {
  if (!/^[0-9a-f]{40}$/.test(owner) || !/^[0-9a-f]{64}$/.test(topic)) {
    throw new Error("A feed manifest needs a lowercase 20-byte owner and 32-byte topic");
  }
  const key = new Uint8Array(32);
  const version = unhex(VERSION_02);
  const zeroTarget = new Uint8Array(ADDRESS_BYTES);
  const child = concat(key, version, Uint8Array.of(ADDRESS_BYTES), zeroTarget, new Uint8Array(32));

  const bitmap = new Uint8Array(32);
  bitmap[SLASH >> 3] = 1 << (SLASH & 7);
  const prefix = new Uint8Array(30);
  prefix[0] = SLASH;
  const json = new TextEncoder().encode(
    JSON.stringify({ "swarm-feed-owner": owner, "swarm-feed-topic": topic, "swarm-feed-type": "Sequence" }),
  );
  // The 2-byte length plus the JSON, padded with newlines to a multiple of 32.
  const metaLength = Math.ceil((json.length + 2) / 32) * 32 - 2;
  const meta = new Uint8Array(metaLength).fill(0x0a);
  meta.set(json);
  const payload = concat(
    key,
    version,
    Uint8Array.of(ADDRESS_BYTES),
    zeroTarget,
    bitmap,
    // A "/" child counts as a value even with no target.
    Uint8Array.of(TYPE_VALUE | TYPE_WITH_METADATA, 1),
    prefix,
    cacAddress(child),
    Uint8Array.of(metaLength >> 8, metaLength & 0xff),
    meta,
  );
  return concat(encodeSpan(payload.length), payload);
}

/**
 * The address of that manifest, worked out here rather than read from anyone: lets a
 * holder check a name's target is its own feed without fetching anything - a fresh
 * feed's manifest can take minutes to reach our gateway.
 */
export function expectedFeedManifestHash(owner: string, topic: string): string {
  return hex(cacAddress(feedManifestRootChunk(owner, topic).subarray(8)));
}

/** The same, from an address in any case (with or without `0x`) and a topic STRING,
 *  hashed as bee hashes one - the shape a page's feed is named in. */
export function feedManifestFor(ownerAddress: string, topic: string): string {
  return expectedFeedManifestHash(ownerAddress.toLowerCase().replace(/^0x/, ""), hex(keccak_256(new TextEncoder().encode(topic))));
}

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
  if (manifest.replace(/^0x/, "").toLowerCase() !== feedManifestFor(feed.owner, feed.topic)) {
    throw new FeedManifestMismatchError();
  }
}
