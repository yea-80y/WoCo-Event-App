/**
 * Where the next update of a sequence feed goes (#186).
 *
 * Two facts make this its own problem (bee 2.7.1 source, 2026-10-08):
 *  - A feed lookup is a LOWER bound, never the answer. Bee's walk gives each
 *    probe one second and counts a slower one as missing (`pkg/feeds/sequence`),
 *    so an update still reaching our bee - an Etherna write, or our own, which
 *    `/soc` pushes straight to its storer rather than keeping locally - reads as
 *    the one before it.
 *  - A write at a taken index does not fail. The SOC already there keeps its
 *    bytes and the upload still answers 201, so the edit is lost with success
 *    reported.
 *
 * So a lookup only says where to START. A chunk read at each index from there (a
 * full retrieval, no one-second cut) finds the first free one: a lookup that
 * under-reads by k costs k reads of chunks that exist, plus the one miss every
 * resolution pays.
 */
import { FeedIndex, type Topic } from "@ethersphere/bee-js";
import { Binary } from "cafe-utility";
import { ethernaSource, readVerifiedSoc, wocoBeeSource, type SocSource, type VerifiedSocRead } from "./soc-read.js";

/** How far past the lookup a resolution walks before refusing. Lag is usually a
 *  few updates, but one slow probe can cut bee's walk far short; a found chunk is
 *  a cheap read, and refusing costs the caller an edit. */
export const MAX_FORWARD_WALK = 64;

/** Where a feed's updates are stamped: our bee, or the Etherna gateway. */
export type FeedDest = "woco" | "etherna";

/** Who to ask whether an update exists. Etherna first for its own feeds: it
 *  holds what it was just sent, and a found there spares our bee a search. */
export function feedSources(dest: FeedDest): SocSource[] {
  return dest === "etherna" ? [ethernaSource, wocoBeeSource] : [wocoBeeSource];
}

export function feedUpdateIdentifierHex(topic: Topic, index: bigint): string {
  return Binary.uint8ArrayToHex(
    Binary.keccak256(Binary.concatBytes(topic.toUint8Array(), FeedIndex.fromBigInt(index).toUint8Array())),
  );
}

export function readFeedUpdate(
  ownerHex: string,
  topic: Topic,
  index: bigint,
  sources: SocSource[],
): Promise<VerifiedSocRead> {
  return readVerifiedSoc(ownerHex, feedUpdateIdentifierHex(topic, index), { sources, heal: false });
}

/**
 * The first index at or after `start` that holds no update. Throws when a source
 * cannot say whether an index is taken (writing there might be lost), or when the
 * head is more than MAX_FORWARD_WALK past `start` (the lookup is not a usable start).
 * For an Etherna feed that includes the 30 s pause after a slow Etherna read
 * (`soc-read.ts` breaker): a write needing a walk refuses until it lifts.
 */
export async function firstFreeIndex(
  ownerHex: string,
  topic: Topic,
  start: bigint,
  sources: SocSource[],
): Promise<bigint> {
  const name = topic.toHex().slice(0, 16);
  for (let i = start; i < start + BigInt(MAX_FORWARD_WALK); i++) {
    const r = await readFeedUpdate(ownerHex, topic, i, sources);
    if (r.status === "absent") return i;
    if (r.status === "unavailable") {
      throw new Error(`feed ${name}: cannot tell whether index ${i} is taken (${r.reason})`);
    }
  }
  throw new Error(`feed ${name}: more than ${MAX_FORWARD_WALK} updates past its lookup, refusing to guess`);
}
