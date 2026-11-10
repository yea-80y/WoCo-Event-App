/**
 * A feed manifest, built here byte for byte as bee builds one (#614 names, #912 slice 2b).
 * Shared so the browser (checking a name points at its own feed) and the server (storing
 * the manifest itself, with no call to the gateway that would otherwise make it) agree.
 *
 * Bee writes a feed manifest in the clear (a zero obfuscation key): a mantaray v0.2 root
 * with a zero target and ONE "/" fork, whose metadata names the feed, to a child that is
 * an empty node - a zero target and no forks, the same bytes for every feed. So both
 * chunks depend on the feed alone. Pinned to production chunks, not to bee-js: bee-js
 * drops a "/" node's zero target, so the manifest it builds has another child address
 * than the one bee serves. Measured 2026-11-10: equal to the manifest Etherna made for
 * every name target in production (11 event pages, 6 websites).
 *
 * Layout (bee-js `MantarayNode.marshal`, which bee reads): obfuscation key (32) then,
 * XORed with it: version hash (31), target length (1), target, fork bitmap (32, bit i
 * LE = first byte i), and per fork: type (1), prefix length (1), prefix padded to 30,
 * the child's address (32), and with metadata a 2-byte big-endian length and the JSON
 * padded with newlines.
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes as concat, hexToBytes } from "@noble/hashes/utils.js";
import { calculateCacAddress, encodeSpan } from "./soc.js";

export const VERSION_02 = "5768b3b6a7db56d21d1abff40d41cebfc83448fed8d7e9b06ec0d3b073f28f";
export const TYPE_WITH_METADATA = 16;
export const SLASH = 47;
export const ADDRESS_BYTES = 32;

const TYPE_VALUE = 2;

function cacAddress(payload: Uint8Array): Uint8Array {
  return calculateCacAddress(encodeSpan(payload.length), payload);
}

const withSpan = (payload: Uint8Array): Uint8Array => concat(encodeSpan(payload.length), payload);

/** The "/" child: an empty node, the same chunk (span + payload) for every feed. */
export function feedManifestChildChunk(): Uint8Array {
  return withSpan(concat(new Uint8Array(32), hexToBytes(VERSION_02), Uint8Array.of(ADDRESS_BYTES), new Uint8Array(ADDRESS_BYTES), new Uint8Array(32)));
}

/**
 * The root chunk (span + payload) of the feed manifest bee makes for `owner`'s feed at
 * `topic` (both lowercase hex, no `0x`; `topic` is the 32-byte topic, already hashed).
 */
export function feedManifestRootChunk(owner: string, topic: string): Uint8Array {
  if (!/^[0-9a-f]{40}$/.test(owner) || !/^[0-9a-f]{64}$/.test(topic)) {
    throw new Error("A feed manifest needs a lowercase 20-byte owner and 32-byte topic");
  }
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
  return withSpan(
    concat(
      new Uint8Array(32),
      hexToBytes(VERSION_02),
      Uint8Array.of(ADDRESS_BYTES),
      new Uint8Array(ADDRESS_BYTES),
      bitmap,
      // A "/" child counts as a value even with no target.
      Uint8Array.of(TYPE_VALUE | TYPE_WITH_METADATA, 1),
      prefix,
      cacAddress(feedManifestChildChunk().subarray(8)),
      Uint8Array.of(metaLength >> 8, metaLength & 0xff),
      meta,
    ),
  );
}

/**
 * The address of that manifest, worked out here rather than read from anyone: lets a
 * holder check a name's target is its own feed without fetching anything - a fresh
 * feed's manifest can take minutes to reach our gateway.
 */
export function expectedFeedManifestHash(owner: string, topic: string): string {
  return bytesToHex(cacAddress(feedManifestRootChunk(owner, topic).subarray(8)));
}

/** The same, from an address in any case (with or without `0x`) and a topic STRING,
 *  hashed as bee hashes one - the shape a page's feed is named in. */
export function feedManifestFor(ownerAddress: string, topic: string): string {
  return expectedFeedManifestHash(ownerAddress.toLowerCase().replace(/^0x/, ""), bytesToHex(keccak_256(new TextEncoder().encode(topic))));
}
