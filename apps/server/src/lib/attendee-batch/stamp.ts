/**
 * Postage stamps we sign ourselves, for the attendee batch (#546).
 *
 * WHY not let the bee stamp: erasure. A storer replaces a chunk when another
 * chunk arrives with a strictly newer stamp for the SAME (batch, bucket, index)
 * — bee `reserve.Put`, verified on #546 — and that is the only way to remove one
 * record from Swarm. The bee's own issuer never lets us choose the index, and
 * nothing records which index a chunk got. Signing here, with a key we hold,
 * is what makes a single order erasable later.
 *
 * Conventions match bee's issuer and Etherchunk (Cafe137/etherchunk
 * `src/stamper.ts`), so its slot reuse can later work on chunks written here:
 *   index     = bucket (uint32 BE) || slot (uint32 BE); bucket = first 16 bits of the address
 *   timestamp = NANOSECONDS, uint64 BE. bee-js's `Stamper` uses milliseconds, and a
 *               millisecond stamp can never replace a nanosecond one, so do not mix them.
 *   signature = personal-sign(keccak256(address || batchId || index || timestamp))
 *
 * Signed with `@woco/shared`'s noble-based `personalSignKeccak`, never bee-js's
 * `PrivateKey`: that one runs the long-term key through a BigInt scalar
 * multiplication that branches on secret bits, and this key signs on request
 * paths anyone can trigger. The public address is derived once, at load.
 */

import { BatchId, MerkleTree, type EnvelopeWithBatchId } from "@ethersphere/bee-js";
import { addressForPrivateKey, personalSignKeccak } from "@woco/shared";

/** Chunks per bucket is 2^(depth - BUCKET_DEPTH); every batch we buy uses 16. */
export const BUCKET_DEPTH = 16;

const CHUNK_PAYLOAD_SIZE = 4096;

export function bucketOf(address: Uint8Array): number {
  return (address[0] << 8) | address[1];
}

export function slotsPerBucket(depth: number): number {
  if (!Number.isInteger(depth) || depth <= BUCKET_DEPTH || depth > 40) {
    throw new Error(`attendee batch depth must be an integer in ${BUCKET_DEPTH + 1}..40, got ${depth}`);
  }
  return 2 ** (depth - BUCKET_DEPTH);
}

function uint32BE(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, false);
  return out;
}

export function encodeTimestampNs(ns: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, ns, false);
  return out;
}

export function decodeTimestampNs(bytes: Uint8Array): bigint {
  return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, false);
}

/**
 * A timestamp for a new stamp on a slot whose current stamp is `after`
 * (0n for a slot never used). Strictly greater even if the clock stepped back,
 * because a storer refuses an equal or older stamp for an occupied slot.
 */
export function nextTimestampNs(after: bigint = 0n, nowMs: number = Date.now()): bigint {
  const now = BigInt(nowMs) * 1_000_000n;
  return now > after ? now : after + 1n;
}

/** The stamper: raw key bytes and the address derived from them once. */
export interface StamperKey {
  privateKey: Uint8Array;
  /** 20 bytes. */
  address: Uint8Array;
  /** 0x-prefixed, lowercase. */
  addressHex: string;
}

export function stamperKeyFromHex(hex: string): StamperKey {
  const clean = hex.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(clean)) throw new Error("stamper key must be 32 bytes of hex");
  const privateKey = Uint8Array.from(Buffer.from(clean, "hex"));
  const addressHex = addressForPrivateKey(privateKey).toLowerCase();
  return { privateKey, address: Uint8Array.from(Buffer.from(addressHex.slice(2), "hex")), addressHex };
}

export function signStamp(
  key: StamperKey,
  batchId: BatchId,
  address: Uint8Array,
  slot: number,
  timestampNs: bigint,
): EnvelopeWithBatchId {
  if (address.length !== 32) throw new Error(`chunk address must be 32 bytes, got ${address.length}`);
  if (!Number.isInteger(slot) || slot < 0 || slot > 0xffffffff) throw new Error(`invalid slot ${slot}`);
  const index = new Uint8Array(8);
  index.set(uint32BE(bucketOf(address)), 0);
  index.set(uint32BE(slot), 4);
  const timestamp = encodeTimestampNs(timestampNs);
  const batch = batchId.toUint8Array();
  const data = new Uint8Array(32 + 32 + 8 + 8);
  data.set(address, 0);
  data.set(batch, 32);
  data.set(index, 64);
  data.set(timestamp, 72);
  return {
    batchId,
    index,
    issuer: key.address,
    signature: personalSignKeccak(data, key.privateKey),
    timestamp,
  };
}

export interface SplitChunk {
  address: Uint8Array;
  /** Span (8 bytes LE) + the bytes actually written, what `POST /chunks` takes. */
  body: Uint8Array;
}

/**
 * Split a payload into the chunks bee's `/bytes` would store for it (no
 * erasure coding, no encryption), leaves first and the root LAST. The root's
 * address is the reference every existing reader already uses.
 *
 * `Chunk.build()` returns the whole 4096-byte buffer, zero-padded. The address
 * is the same either way (the BMT pads with zeros), but bee's own splitter
 * stores only the written bytes, so the body is trimmed to match it exactly.
 */
export async function splitPayload(payload: Uint8Array): Promise<{ root: Uint8Array; chunks: SplitChunk[] }> {
  const chunks: SplitChunk[] = [];
  const tree = new MerkleTree(async (chunk) => {
    const written = CHUNK_PAYLOAD_SIZE - chunk.writer.max();
    chunks.push({ address: chunk.hash(), body: chunk.build().slice(0, 8 + written) });
  });
  await tree.append(payload);
  const root = (await tree.finalize()).hash();
  const last = chunks[chunks.length - 1];
  if (!last || !equalBytes(last.address, root)) {
    throw new Error("chunker did not emit the root chunk last");
  }
  return { root, chunks };
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
