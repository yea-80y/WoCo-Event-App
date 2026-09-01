/**
 * Locked cryptographic spec for `woco.edition.v1` / `woco.manifest.v2`.
 *
 * The recipes are BYTE-IDENTICAL to the v1 spec in `pod/canonical.ts` — same
 * DAG-CBOR encoder, same 0x00 leaf domain, same u32be edition prefix, same
 * keccak256 digest — only the body shapes and the signature scheme moved
 * (see `types.ts`). Golden vectors in `test/edition/` pin every recipe here;
 * DO NOT modify any constant or function without a format version bump.
 *
 * The digest/leaf helpers VALIDATE before encoding and throw on an invalid
 * body — a digest of an unvalidated object must never exist. Verifiers wrap
 * them in try/catch and return false (`merkle.ts`).
 */

import * as dagCbor from "@ipld/dag-cbor";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  canonicalEditionV1Body,
  canonicalManifestV2Body,
  validateEditionV1Body,
  validateManifestV2Body,
  type EditionV1Body,
  type ManifestV2Body,
} from "./types.js";

/** Leaf-hash domain separator — same value, same job as v1's. */
const LEAF_DOMAIN = 0x00;

function u32be(n: number): Uint8Array {
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
 * Merkle leaf hash for one edition:
 *
 *   leaf_n = keccak256( 0x00 || u32be(edition) || dagCbor(body) )
 *
 * The edition prefix is the edition-swap / second-preimage defence; the domain
 * byte separates leaves from OZ's internal nodes. Throws on an invalid body.
 */
export function editionLeafHash(body: EditionV1Body): Uint8Array {
  if (!validateEditionV1Body(body)) throw new Error("invalid woco.edition.v1 body");
  const bodyBytes = dagCbor.encode(canonicalEditionV1Body(body));
  const buf = new Uint8Array(1 + 4 + bodyBytes.length);
  buf[0] = LEAF_DOMAIN;
  buf.set(u32be(body.edition), 1);
  buf.set(bodyBytes, 5);
  return keccak_256(buf);
}

/**
 * The manifest digest — `keccak256(dagCbor(body))`. This 32-byte value is:
 *  - what the issuing key's personal-sign message commits to,
 *  - what the chain stores as `events[eventId].manifestRef`,
 *  - what offline verifiers recompute from cached manifest bodies.
 * Throws on an invalid body.
 */
export function manifestV2Digest(body: ManifestV2Body): Uint8Array {
  if (!validateManifestV2Body(body)) throw new Error("invalid woco.manifest.v2 body");
  return keccak_256(dagCbor.encode(canonicalManifestV2Body(body)));
}

/** The personal-sign domain line for manifest signatures. */
export const MANIFEST_V2_SIGNING_DOMAIN = "woco-manifest-v2";

/**
 * The EXACT ASCII message the issuing key personal-signs for a manifest:
 *
 *   woco-manifest-v2\n{0x + 64-hex digest}
 *
 * Always 83 bytes — never 32, so it can never collide with the feed signer's
 * personal-signed SOC digests (bee-js wraps exactly 32 raw bytes), and the
 * domain line keeps it disjoint from every other WoCo canonical message.
 * Throws on a digest that is not 32 bytes.
 */
export function buildManifestV2Message(digest: Uint8Array): string {
  if (digest.length !== 32) {
    throw new Error(`manifest digest must be 32 bytes, got ${digest.length}`);
  }
  let hex = "";
  for (const b of digest) hex += b.toString(16).padStart(2, "0");
  return `${MANIFEST_V2_SIGNING_DOMAIN}\n0x${hex}`;
}

/** Canonically encode an edition body (round-trip/debug use). */
export function canonicalEncodeEdition(body: EditionV1Body): Uint8Array {
  if (!validateEditionV1Body(body)) throw new Error("invalid woco.edition.v1 body");
  return dagCbor.encode(canonicalEditionV1Body(body));
}
