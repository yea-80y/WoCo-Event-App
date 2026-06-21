/**
 * Single-Owner-Chunk (SOC) primitives shared between the client SOC writer and
 * the server stamp+upload endpoint.
 *
 * Phase A (CLIENT_FEED_SIGNER_HANDOVER.md) lets a client SIGN a SOC locally and
 * have the server STAMP+UPLOAD it. The server must independently re-derive the
 * content-addressed chunk (CAC) address from the submitted span+payload to verify
 * the client's signature commits to exactly those bytes — otherwise it would
 * stamp a chunk whose signature recovers to a different owner. Both ends MUST
 * compute the BMT address byte-identically, so the algorithm lives here.
 *
 * The implementation mirrors bee-js@11 `chunk/bmt.js#calculateChunkAddress`
 * (verified against the installed package): the chunk address is
 * `keccak256( span(8) || bmtRoot(payload) )`, where `bmtRoot` is the binary
 * Merkle tree root over the payload zero-padded to 4096 bytes, in 32-byte
 * segments, reduced pairwise with keccak256. We re-implement it with keccak only
 * (no bee-js dep) so `@woco/shared` stays free of the Bee SDK.
 */

import { keccak_256 } from "@noble/hashes/sha3";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils";
import type { RecoveryEnvelope } from "../recovery/types.js";

/** Max SOC/CAC payload (bytes). */
export const SOC_MAX_PAYLOAD_SIZE = 4096;
/** BMT segment size (bytes). */
const SEGMENT_SIZE = 32;
/** Swarm span field width (bytes) — little-endian uint64 payload length. */
export const SOC_SPAN_SIZE = 8;
/** secp256k1 signature length on a SOC (bytes). */
export const SOC_SIGNATURE_SIZE = 65;
/** SOC identifier length (bytes). */
export const SOC_IDENTIFIER_SIZE = 32;

/** Encode a payload length as the 8-byte little-endian Swarm span. */
export function encodeSpan(length: number): Uint8Array {
  const span = new Uint8Array(SOC_SPAN_SIZE);
  let n = BigInt(length);
  for (let i = 0; i < SOC_SPAN_SIZE; i++) {
    span[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return span;
}

/**
 * BMT root over a chunk payload: zero-pad to 4096, split into 32-byte segments,
 * then reduce adjacent pairs with keccak256 until a single 32-byte hash remains.
 */
function bmtRootHash(payload: Uint8Array): Uint8Array {
  if (payload.length > SOC_MAX_PAYLOAD_SIZE) {
    throw new Error(`payload ${payload.length} exceeds max chunk size ${SOC_MAX_PAYLOAD_SIZE}`);
  }
  const input = new Uint8Array(SOC_MAX_PAYLOAD_SIZE);
  input.set(payload);

  let level: Uint8Array[] = [];
  for (let off = 0; off < SOC_MAX_PAYLOAD_SIZE; off += SEGMENT_SIZE) {
    level.push(input.subarray(off, off + SEGMENT_SIZE));
  }
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(keccak_256(concatBytes(level[i], level[i + 1])));
    }
    level = next;
  }
  return level[0];
}

/**
 * Content-addressed chunk (CAC) address for `span || payload` — the value a SOC
 * signature commits to (alongside the identifier). `span` MUST be the 8-byte
 * encoding of `payload.length` (see {@link encodeSpan}).
 */
export function calculateCacAddress(span: Uint8Array, payload: Uint8Array): Uint8Array {
  if (span.length !== SOC_SPAN_SIZE) throw new Error("span must be 8 bytes");
  return keccak_256(concatBytes(span, bmtRootHash(payload)));
}

/**
 * The SOC's own Swarm address (where it is stored/read): `keccak256(identifier || owner)`.
 * `owner` is the 20-byte Ethereum address; `identifier` is 32 bytes.
 */
export function calculateSocAddress(identifier: Uint8Array, owner: Uint8Array): Uint8Array {
  if (identifier.length !== SOC_IDENTIFIER_SIZE) throw new Error("identifier must be 32 bytes");
  if (owner.length !== 20) throw new Error("owner must be 20 bytes");
  return keccak_256(concatBytes(identifier, owner));
}

/** The digest a SOC owner signs: `concat(identifier, cacAddress)`. */
export function socSignDigest(identifier: Uint8Array, cacAddress: Uint8Array): Uint8Array {
  return concatBytes(identifier, cacAddress);
}

// ---------------------------------------------------------------------------
// Cross-device recovery portability envelope (CROSS_DEVICE_RECOVERY.md §3)
// ---------------------------------------------------------------------------

/**
 * Fixed input hashed (keccak256) into the SOC identifier for the recovery
 * portability envelope. A constant identifier makes the envelope overwrite-in-
 * place (same owner+identifier) and discoverable on any device without feed-index
 * logic — it is read by computed chunk address, never via `/feeds` (Etherna-safe).
 */
export const PORTABILITY_SOC_IDENTIFIER_INPUT = "woco/recovery/portability/v1";

/**
 * Domain-separation tags for the two keys derived from the passkey PRF secret.
 * Distinct domains so neither derived key reveals the other (handover step 3).
 */
export const PORTABILITY_SOC_OWNER_DOMAIN = "woco/recovery/portability/soc-owner/v1";
export const PORTABILITY_HPKE_DOMAIN = "woco/recovery/portability/hpke/v1";

/**
 * Current portability-envelope payload version.
 * v2 (2026-06-21) closed the privacy leak: `preservedKernelAddress` moved from
 * cleartext into the sealed bundle, and the envelope is sealed under the public
 * PRF-derived `socOwnerAddress` (not the real Kernel) so nothing on the chunk
 * links the pseudonymous SOC owner to the user's real Kernel account. v1 SOCs no
 * longer parse → the login back-fill rewrites them (no real users → no migration).
 */
export const PORTABILITY_ENVELOPE_VERSION = 2 as const;

/**
 * The plaintext stored (sealed) inside the portability SOC. `envelope` is the
 * SAME audited `RecoveryEnvelope` produced by `recovery-escrow.ts`, sealed to one
 * extra HPKE recipient (a PRF-derived X25519 key) AND bound (AAD + its cleartext
 * `kernelAddress` field) to the PRF-derived `socOwnerAddress` pseudonym — never
 * the real Kernel. The sealed bundle inside `envelope` carries
 * `{ preservedKernelAddress, podSeed[, feedSignerPrivKey] }`: the new device reads
 * the preserved Kernel post-decrypt and verifies it on-chain before applying any
 * override. The feed-signer slot is reserved for Phase B as a pure content change.
 */
export interface PortabilityEnvelope {
  v: typeof PORTABILITY_ENVELOPE_VERSION;
  envelope: RecoveryEnvelope;
}

/** keccak256 of the fixed portability identifier input → the 32-byte SOC identifier. */
export function portabilitySocIdentifier(): Uint8Array {
  return keccak_256(utf8ToBytes(PORTABILITY_SOC_IDENTIFIER_INPUT));
}

// ---------------------------------------------------------------------------
// Client-owned content feeds (Phase B — CLIENT_FEED_SIGNER_HANDOVER.md Task 2)
// ---------------------------------------------------------------------------

/**
 * Domain for deriving a user's content-feed SIGNING key from their root login
 * secret (Web3Auth secp256k1 key / passkey PRF output). Domain-separated from the
 * POD seed and the recovery/portability keys so the feed signer is an INDEPENDENT
 * identity: rotating or leaking it never exposes POD, encryption, or funds.
 *
 * The derived secp256k1 key's ADDRESS is the OWNER of every content SOC the user
 * writes (`keccak256(identifier || ownerAddress)`), so the USER — not the platform
 * — owns the feed. The platform only lends postage (stamps) at write time; this is
 * a swappable transport (per-user batch / browser-Bee later) that does not touch
 * ownership. Recovery for the web3auth/passkey kinds is by re-deriving from the
 * same root secret on re-login — no escrow needed for this key (the recovery
 * portability bundle still reserves a `feedSignerPrivKey` slot for the passkey kind
 * if we ever move it to an independent random secret; deriving keeps launch simple).
 */
export const CONTENT_FEED_SIGNER_DOMAIN = "woco/feed-signer/v1";

/**
 * SOC identifier for a content feed addressed by its stable topic string
 * (e.g. `"woco/profile/data/0xabc…"` or a paged `"…/p1"`). `keccak256(topic)` →
 * an overwrite-in-place SOC owned by the user's content-feed-signer address, read
 * by computed chunk address (Etherna-safe — never `/feeds`). Replaces the
 * sequential bee-js feed index for single-writer content: a SOC at a fixed
 * (owner, identifier) is mutable in place, so no per-topic index bookkeeping.
 */
export function contentFeedSocIdentifier(topic: string): Uint8Array {
  return keccak_256(utf8ToBytes(topic));
}
