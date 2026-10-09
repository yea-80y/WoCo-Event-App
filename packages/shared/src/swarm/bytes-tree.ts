/**
 * Swarm `/bytes` trees, verified chunk by chunk (#186): what lets a reader take a
 * multi-chunk blob from ANY gateway and still know it is exactly the bytes a
 * reference names. Unencrypted, no erasure coding - bee's default for `/bytes`.
 *
 *   leaf          span = its data length (≤ 4096), payload = the data
 *   intermediate  span = total data length beneath it, payload = child addresses (32 B each)
 *   address       keccak256(span ‖ bmtRoot(payload))   (`calculateCacAddress`)
 *
 * Every address commits to its span and payload, so checking each chunk against the
 * address its parent names - and the root against the reference - proves the whole
 * blob, whatever grouping the writer's splitter used.
 */

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { calculateCacAddress, encodeSpan, SOC_MAX_PAYLOAD_SIZE, SOC_SPAN_SIZE } from "./soc.js";

const REF = /^[0-9a-f]{64}$/;
const REF_BYTES = 32;
/** Children per intermediate chunk. */
const BRANCHES = SOC_MAX_PAYLOAD_SIZE / REF_BYTES;

/** A blob whose chunks do not add up to the reference it was read under. */
export class BytesTreeMismatchError extends Error {
  constructor(detail: string) {
    super(`bytes tree rejected: ${detail}`);
    this.name = "BytesTreeMismatchError";
  }
}

function decodeSpan(span: Uint8Array): number {
  let n = 0n;
  for (let i = SOC_SPAN_SIZE - 1; i >= 0; i--) n = (n << 8n) | BigInt(span[i]!);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new BytesTreeMismatchError("span out of range");
  return Number(n);
}

/**
 * The `/bytes` reference bee gives `data`, computed locally: one leaf for up to
 * 4096 bytes, else 4096-byte leaves under ONE intermediate chunk. Up to 128 leaves
 * (512 KiB) - deeper trees are refused rather than guessed at, since bee's splitter
 * has carry rules a single level never meets.
 */
export function bytesTreeRoot(data: Uint8Array): string {
  return bytesTreeChunks(data).at(-1)!.address;
}

/**
 * Read the blob at `root`, checking every chunk. `fetchChunk` returns a chunk as
 * `GET /chunks/{address}` does (span ‖ payload) - from any source; nothing it returns
 * is trusted. `maxBytes` bounds the blob before anything beneath the root is fetched.
 */
export async function readBytesTree(
  root: string,
  fetchChunk: (address: string) => Promise<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!REF.test(root)) throw new Error("bytes tree: reference must be 64 lowercase hex characters");

  async function node(address: string): Promise<{ span: number; payload: Uint8Array }> {
    const raw = await fetchChunk(address);
    if (raw.length < SOC_SPAN_SIZE || raw.length > SOC_SPAN_SIZE + SOC_MAX_PAYLOAD_SIZE) {
      throw new BytesTreeMismatchError(`chunk ${address} has an impossible length`);
    }
    const spanBytes = raw.subarray(0, SOC_SPAN_SIZE);
    const payload = raw.slice(SOC_SPAN_SIZE);
    if (bytesToHex(calculateCacAddress(spanBytes, payload)) !== address) {
      throw new BytesTreeMismatchError(`chunk ${address} does not hash to its address`);
    }
    return { span: decodeSpan(spanBytes), payload };
  }

  async function walk(address: string, expectedSpan: number | null): Promise<Uint8Array> {
    const { span, payload } = await node(address);
    if (expectedSpan !== null && span !== expectedSpan) throw new BytesTreeMismatchError("a child's span disagrees with its parent");
    if (span > maxBytes) throw new BytesTreeMismatchError(`blob larger than ${maxBytes} bytes`);
    if (span <= SOC_MAX_PAYLOAD_SIZE) {
      if (payload.length !== span) throw new BytesTreeMismatchError("a leaf's length disagrees with its span");
      return payload;
    }
    if (payload.length === 0 || payload.length % REF_BYTES !== 0) throw new BytesTreeMismatchError("an intermediate chunk is not a list of references");
    // Each child but the last holds the same full subtree size; the last holds the rest.
    // The child count is the one bee's splitter makes for this span, no other: a tree of
    // single-child intermediates would otherwise pass every span check at any depth.
    const children = payload.length / REF_BYTES;
    let full = SOC_MAX_PAYLOAD_SIZE;
    while (full * BRANCHES < span) full *= BRANCHES;
    if (children !== Math.ceil(span / full)) throw new BytesTreeMismatchError("an intermediate chunk does not have the children its span needs");
    const rest = span - full * (children - 1);
    if (rest <= 0 || rest > full) throw new BytesTreeMismatchError("an intermediate chunk's span does not fit its children");
    const out = new Uint8Array(span);
    for (let i = 0; i < children; i++) {
      const child = bytesToHex(payload.subarray(i * REF_BYTES, (i + 1) * REF_BYTES));
      const part = await walk(child, i === children - 1 ? rest : full);
      out.set(part, i * full);
    }
    return out;
  }

  return walk(root, null);
}

/** Split `data` into the chunks `bytesTreeRoot` hashes, root last - for tests and writers that store chunks themselves. */
export function bytesTreeChunks(data: Uint8Array): { address: string; chunk: Uint8Array }[] {
  if (data.length === 0) throw new Error("bytes tree: empty data");
  const out: { address: string; chunk: Uint8Array }[] = [];
  const push = (span: number, payload: Uint8Array) => {
    const s = encodeSpan(span);
    const chunk = new Uint8Array(SOC_SPAN_SIZE + payload.length);
    chunk.set(s, 0);
    chunk.set(payload, SOC_SPAN_SIZE);
    out.push({ address: bytesToHex(calculateCacAddress(s, payload)), chunk });
  };
  if (data.length <= SOC_MAX_PAYLOAD_SIZE) {
    push(data.length, data);
    return out;
  }
  const refs: Uint8Array[] = [];
  for (let off = 0; off < data.length; off += SOC_MAX_PAYLOAD_SIZE) {
    const leaf = data.subarray(off, Math.min(data.length, off + SOC_MAX_PAYLOAD_SIZE));
    push(leaf.length, leaf);
    refs.push(hexToBytes(out[out.length - 1]!.address));
  }
  if (refs.length > BRANCHES) throw new Error(`bytes tree: ${data.length} bytes needs more than one level`);
  const payload = new Uint8Array(refs.length * REF_BYTES);
  refs.forEach((r, i) => payload.set(r, i * REF_BYTES));
  push(data.length, payload);
  return out;
}
