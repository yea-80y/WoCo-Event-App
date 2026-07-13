/**
 * Locked cryptographic spec for `woco.ticket.v2` / `woco.manifest.v1`.
 *
 * Producer (event creation) and verifier (door scanner, ticket page,
 * dashboard) MUST agree byte-for-byte on:
 *
 *  1. Canonical POD encoding — DAG-CBOR (RFC 8949 deterministic) via
 *     `@ipld/dag-cbor`. Round-trip-safe in browsers and Node.
 *  2. Leaf hash — `keccak256(LEAF_DOMAIN || u32_be(edition) || dagCbor(pod))`.
 *     The 1-byte domain separator + edition prefix prevent
 *     edition-swap and second-preimage attacks.
 *  3. Manifest digest — `keccak256(dagCbor(manifestBody))`. This is what
 *     the chain stores as `manifestRef`, and what the ed25519 signature
 *     covers — binding the signature to the on-chain commitment.
 *
 * Tree topology is delegated to `@openzeppelin/merkle-tree`'s
 * `SimpleMerkleTree` (see `merkle.ts`). Internal nodes use
 * `keccak256(sort(L, R))` — OZ's audited scheme, NOT RFC 6962. Documented
 * here so it's not a surprise to the contract / scanner devs reading the
 * spec.
 *
 * DO NOT modify any constant or function in this file without a format
 * version bump (`woco.ticket.v3` / `woco.manifest.v2`). All test vectors
 * in `../../test/pod/` will need new fixtures alongside.
 */

import * as dagCbor from "@ipld/dag-cbor";
import { keccak_256 } from "@noble/hashes/sha3.js";
import type { ManifestV1Body, PodV2Body } from "./types.js";

/** Domain separator for leaf hashing. Any byte other than 0x00/0x01 would do; 0x00 chosen for clarity. */
export const LEAF_DOMAIN: number = 0x00;

/**
 * Canonically encode a `woco.ticket.v2` POD body to DAG-CBOR bytes.
 *
 * @ipld/dag-cbor is deterministic by construction:
 *  - Map keys are sorted by their CBOR-encoded byte form (RFC 8949 §4.2.1).
 *  - Smallest-form integer encoding.
 *  - No floats outside what dag-cbor permits (NaN/Infinity rejected).
 *  - No tags except CIDs (we don't use CIDs).
 *
 * Producers and verifiers therefore get identical bytes from identical
 * inputs, regardless of object key insertion order.
 */
export function canonicalEncodePod(pod: PodV2Body): Uint8Array {
  return dagCbor.encode(pod);
}

/**
 * Canonically encode a `woco.manifest.v1` body to DAG-CBOR bytes.
 * Identical determinism guarantees as `canonicalEncodePod`.
 */
export function canonicalEncodeManifest(body: ManifestV1Body): Uint8Array {
  return dagCbor.encode(body);
}

/**
 * Decode a previously-canonical-encoded POD. Useful for verifier-side
 * round-trip tests.
 */
export function canonicalDecodePod(bytes: Uint8Array): PodV2Body {
  return dagCbor.decode(bytes) as PodV2Body;
}

/**
 * Encode a u32 as 4 big-endian bytes. Caller-checked range [0, 2^32-1].
 */
export function u32be(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    throw new RangeError(`u32be: ${n} out of range`);
  }
  const out = new Uint8Array(4);
  out[0] = (n >>> 24) & 0xff;
  out[1] = (n >>> 16) & 0xff;
  out[2] = (n >>> 8) & 0xff;
  out[3] = n & 0xff;
  return out;
}

/**
 * Compute the Merkle leaf hash for a single edition.
 *
 *   leaf_n = keccak256( LEAF_DOMAIN || u32_be(edition) || dagCbor(pod) )
 *
 * Binding `edition` into the leaf bytes is the second-preimage / edition-swap
 * defence: even if two PODs share metadata, their leaves differ. The
 * 1-byte domain separator distinguishes leaves from internal nodes (OZ's
 * `keccak256(sort(L, R))` over two 32-byte values can never produce input
 * that starts with our 5-byte `LEAF || u32` prefix in a colliding way).
 *
 * Returns a 32-byte Uint8Array (no 0x prefix). Use `bytesToHex0x` to format
 * for OZ APIs which expect hex.
 */
export function podLeafHash(pod: PodV2Body): Uint8Array {
  const podBytes = canonicalEncodePod(pod);
  const buf = new Uint8Array(1 + 4 + podBytes.length);
  buf[0] = LEAF_DOMAIN;
  buf.set(u32be(pod.edition), 1);
  buf.set(podBytes, 5);
  return keccak_256(buf);
}

/**
 * Compute the manifest digest — keccak256 over the canonical CBOR encoding
 * of the manifest body. This 32-byte value is:
 *  - what the ed25519 signature covers,
 *  - what the chain stores as `events[eventId].manifestRef`,
 *  - what offline scanners recompute from cached manifest bodies.
 */
export function manifestDigest(body: ManifestV1Body): Uint8Array {
  return keccak_256(canonicalEncodeManifest(body));
}

// ---------------------------------------------------------------------------
// Hex helpers — OZ's merkle-tree expects 0x-prefixed hex strings.
// ---------------------------------------------------------------------------

const HEX_LOOKUP = "0123456789abcdef";

export function bytesToHex0x(bytes: Uint8Array): string {
  let out = "0x";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    out += HEX_LOOKUP[b >>> 4]! + HEX_LOOKUP[b & 0xf]!;
  }
  return out;
}

export function hex0xToBytes(hex: string): Uint8Array {
  const s = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (s.length % 2 !== 0) throw new Error(`hex0xToBytes: odd-length input`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = parseInt(s[i * 2]!, 16);
    const lo = parseInt(s[i * 2 + 1]!, 16);
    if (Number.isNaN(hi) || Number.isNaN(lo)) {
      throw new Error(`hex0xToBytes: bad hex char at ${i * 2}`);
    }
    out[i] = (hi << 4) | lo;
  }
  return out;
}
