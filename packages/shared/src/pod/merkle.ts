/**
 * Merkle tree builder + proof generator + manifest signer/verifier.
 *
 * Wraps `@openzeppelin/merkle-tree` `SimpleMerkleTree`:
 *  - Pre-hashed bytes32 leaves are used verbatim (we own the leaf hash;
 *    OZ does not re-hash).
 *  - Internal nodes: keccak256(sort(L, R)) — OZ's audited scheme.
 *  - Non-power-of-2 supplies: OZ's unbalanced-binary topology, NOT
 *    duplicate-last-leaf padding. Documented in the manifest's
 *    `treeScheme: "oz-simple-v1"` field.
 *
 * `sortLeaves` is set to `false` so leaf index in the tree maps 1:1 to
 * `edition - 1`. This is purely for human debuggability — OZ's proof
 * verification works either way (proofs are looked up by leaf value, not
 * index). If a future producer flips this, verifiers don't care.
 */

import { SimpleMerkleTree } from "@openzeppelin/merkle-tree";
import { ed25519 } from "@noble/curves/ed25519";
import {
  bytesToHex0x,
  canonicalEncodeManifest,
  hex0xToBytes,
  manifestDigest,
  podLeafHash,
} from "./canonical.js";
import type {
  ManifestV1Body,
  MerkleProofV1,
  PodV2Body,
  SignedManifestV1,
} from "./types.js";

/** Build a Merkle tree from an ordered list of `woco.ticket.v2` PODs (edition 1..N). */
export function buildPodTree(pods: readonly PodV2Body[]): {
  tree: SimpleMerkleTree;
  leaves: Uint8Array[];
  root: string; // 0x-prefixed bytes32 hex
} {
  if (pods.length === 0) throw new Error("buildPodTree: empty pod list");
  // Defence-in-depth: enforce edition === index + 1. Catches off-by-one bugs
  // in the producer before they propagate into a signed manifest.
  for (let i = 0; i < pods.length; i++) {
    if (pods[i]!.edition !== i + 1) {
      throw new Error(
        `buildPodTree: pods[${i}].edition = ${pods[i]!.edition}, expected ${i + 1}`,
      );
    }
  }
  const leaves = pods.map(podLeafHash);
  const leavesHex = leaves.map(bytesToHex0x);
  const tree = SimpleMerkleTree.of(leavesHex, { sortLeaves: false });
  return { tree, leaves, root: tree.root };
}

/** Generate a proof for a specific edition (1-indexed). */
export function getEditionProof(
  tree: SimpleMerkleTree,
  pod: PodV2Body,
): MerkleProofV1 {
  const leafBytes = podLeafHash(pod);
  const leafHex = bytesToHex0x(leafBytes);
  const proof = tree.getProof(leafHex);
  return { edition: pod.edition, leaf: leafHex, proof };
}

/**
 * Stand-alone proof verifier — the verifier's view, doesn't need the tree.
 *
 * Recomputes the leaf from the supplied POD, walks the proof, and checks the
 * resulting root matches `expectedRoot`. Returns false on any failure
 * (mismatched edition, tampered POD body, bad proof) — never throws on
 * normal verification failure paths so callers can branch on a boolean.
 */
export function verifyEditionProof(
  pod: PodV2Body,
  proof: MerkleProofV1,
  expectedRoot: string, // 0x-prefixed bytes32 hex
): boolean {
  try {
    if (pod.edition !== proof.edition) return false;
    const recomputedLeaf = bytesToHex0x(podLeafHash(pod));
    if (recomputedLeaf.toLowerCase() !== proof.leaf.toLowerCase()) return false;
    return SimpleMerkleTree.verify(expectedRoot, recomputedLeaf, proof.proof);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Manifest signing + verification
// ---------------------------------------------------------------------------

/**
 * Sign a manifest body with an ed25519 private key.
 *
 * Signature is over `keccak256(dagCbor(body))` — the same 32-byte digest
 * the chain stores as `manifestRef`, binding the signature to the on-chain
 * commitment.
 *
 * The returned envelope's `signature` is hex-encoded (no 0x prefix, 128
 * chars / 64 bytes) to match the existing `verifyTicketSignature` style in
 * `verify.ts`.
 */
export function signManifest(
  body: ManifestV1Body,
  privateKey: Uint8Array,
): SignedManifestV1 {
  const digest = manifestDigest(body);
  const sigBytes = ed25519.sign(digest, privateKey);
  return {
    body,
    signature: bytesToHexNoPrefix(sigBytes),
  };
}

/**
 * Verify a signed manifest's ed25519 signature against the issuer pubkey
 * embedded in `body.issuerPubkey`. Returns false on any failure.
 *
 * Note: this checks signature validity only. Callers MUST also independently
 * verify that the chain `events[eventId].manifestRef` equals
 * `manifestDigest(body)` — the signature alone does not prove the manifest
 * is the one the organiser registered.
 */
export function verifySignedManifest(signed: SignedManifestV1): boolean {
  try {
    const digest = manifestDigest(signed.body);
    const sigBytes = hex0xToBytes(stripHexPrefix(signed.signature));
    const pubBytes = hex0xToBytes(stripHexPrefix(signed.body.issuerPubkey));
    if (pubBytes.length !== 32) return false;
    if (sigBytes.length !== 64) return false;
    return ed25519.verify(sigBytes, digest, pubBytes);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Local hex helpers (no 0x form for ed25519 sig + pubkey, matches
// existing verify.ts conventions).
// ---------------------------------------------------------------------------

function stripHexPrefix(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

function bytesToHexNoPrefix(bytes: Uint8Array): string {
  const HEX = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    out += HEX[b >>> 4]! + HEX[b & 0xf]!;
  }
  return out;
}

// Re-export so callers don't need to import from canonical.ts for common ops.
export { canonicalEncodeManifest, manifestDigest, podLeafHash, bytesToHex0x, hex0xToBytes } from "./canonical.js";
