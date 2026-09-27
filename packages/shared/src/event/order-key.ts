/**
 * The organiser's ORDER key, published by content address (#642).
 *
 * An event names the key its buyers seal their order data to. That key is the
 * organiser's X-Wing public key (1216 bytes), too big to sit in every event feed
 * without pushing most feeds past one 4096-byte chunk. So it is stored once as its
 * own Swarm chunk and the event feed carries only `encryptionKeyRef`: the chunk's
 * content address. An organiser's key is the same for all their events, so every
 * event shares one chunk.
 *
 * WHAT THE CHECK HERE PROVES, and what it does not. A reader recomputes the address
 * of the bytes it fetched and refuses them unless it equals the ref — so a gateway
 * that serves corrupt, stale or swapped bytes is caught. It does not make the REF
 * itself trustworthy: that is exactly as trustworthy as the event feed the reader
 * took it from (a verified SOC in the app; the server's `/api/events/:id` answer in
 * the embed, which already trusts the server for the price).
 *
 * Dependency-light on purpose (keccak only): the embed and the server import it
 * without the post-quantum code.
 */

import { calculateCacAddress, encodeSpan } from "../swarm/soc.js";

/** An X-Wing public key's length. `test/crypto/xwing.test.ts` pins it equal to
 *  `XWING_PUBLIC_KEY_BYTES`. */
export const ORDER_KEY_BYTES = 1216;

const SPAN_BYTES = 8;
const REF_RE = /^[0-9a-f]{64}$/;

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** Thrown when a fetched chunk is not the key its ref names. */
export class OrderKeyMismatchError extends Error {
  constructor(detail: string) {
    super(`order key chunk rejected: ${detail}`);
    this.name = "OrderKeyMismatchError";
  }
}

/** The content address a published order key is stored under (lowercase hex, no 0x). */
export function orderKeyRef(publicKey: Uint8Array): string {
  if (publicKey.length !== ORDER_KEY_BYTES) {
    throw new Error(`order key must be ${ORDER_KEY_BYTES} bytes, got ${publicKey.length}`);
  }
  return hex(calculateCacAddress(encodeSpan(publicKey.length), publicKey));
}

/** A well-formed `encryptionKeyRef`: 64 lowercase hex characters. */
export function isOrderKeyRef(x: unknown): x is string {
  return typeof x === "string" && REF_RE.test(x);
}

/**
 * The key inside a raw chunk (`span ‖ payload`, as `GET /chunks/{ref}` returns it),
 * or a throw. The span must say exactly 1216, the payload must be exactly that, and
 * its content address must be `ref`. Never returns anything a caller could seal to
 * that is not the key the event named.
 */
export function verifyOrderKeyChunk(ref: string, chunk: Uint8Array): Uint8Array {
  const want = ref.toLowerCase();
  if (!REF_RE.test(want)) throw new OrderKeyMismatchError("ref is not 64 hex characters");
  if (chunk.length !== SPAN_BYTES + ORDER_KEY_BYTES) {
    throw new OrderKeyMismatchError(`chunk is ${chunk.length} bytes, expected ${SPAN_BYTES + ORDER_KEY_BYTES}`);
  }
  const span = chunk.subarray(0, SPAN_BYTES);
  const payload = chunk.slice(SPAN_BYTES);
  if (hex(span) !== hex(encodeSpan(ORDER_KEY_BYTES))) {
    throw new OrderKeyMismatchError("span does not declare a 1216-byte key");
  }
  if (hex(calculateCacAddress(span, payload)) !== want) {
    throw new OrderKeyMismatchError("bytes do not hash to the ref");
  }
  return payload;
}

/**
 * Fetch and verify an order key from a gateway's `/chunks/{ref}`. `gatewayUrl` must
 * be one a browser can read (the WoCo gateway — Etherna sends no CORS headers).
 * Throws on any failure; a caller with an order form must then NOT take the order
 * rather than take it unsealed.
 */
export async function fetchOrderKey(
  ref: string,
  gatewayUrl: string,
  doFetch: typeof fetch = fetch,
): Promise<Uint8Array> {
  if (!isOrderKeyRef(ref)) throw new OrderKeyMismatchError("ref is not 64 hex characters");
  const base = gatewayUrl.replace(/\/+$/, "");
  const resp = await doFetch(`${base}/chunks/${ref}`);
  if (!resp.ok) throw new Error(`order key unavailable (${resp.status})`);
  return verifyOrderKeyChunk(ref, new Uint8Array(await resp.arrayBuffer()));
}
