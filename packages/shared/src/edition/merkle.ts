/**
 * Merkle tree builder + proof verifier + manifest signer/verifier for the v2
 * formats. Tree topology is unchanged from v1: `@openzeppelin/merkle-tree`
 * `SimpleMerkleTree`, pre-hashed leaves verbatim, internal nodes
 * keccak256(sort(L, R)), `sortLeaves: false` so leaf index maps 1:1 to
 * `edition - 1`.
 *
 * Verification here DISPATCH-REFUSES the v1 formats: every entry point
 * validates the closed v2 schema first, and a `woco.manifest.v1` /
 * `woco.ticket.v2` object fails that dispatch before any cryptography runs.
 */

import { SimpleMerkleTree } from "@openzeppelin/merkle-tree";
import { bytesToHex0x } from "../crypto/hex.js";
import {
  issuingAddress,
  recoverPersonalSigner,
  signPersonalMessage,
} from "../crypto/issuing.js";
import { buildManifestV2Message, editionLeafHash, manifestV2Digest } from "./canonical.js";
import {
  validateEditionV1Body,
  validateSignedManifestV2,
  type EditionProofV1,
  type EditionV1Body,
  type ManifestV2Body,
  type SignedManifestV2,
} from "./types.js";

/** Build a Merkle tree from an ordered list of editions (edition 1..N). */
export function buildEditionTree(bodies: readonly EditionV1Body[]): {
  tree: SimpleMerkleTree;
  leaves: Uint8Array[];
  root: string; // 0x-prefixed bytes32 hex
} {
  if (bodies.length === 0) throw new Error("buildEditionTree: empty edition list");
  // Defence-in-depth: enforce edition === index + 1 before anything is signed.
  for (let i = 0; i < bodies.length; i++) {
    if (bodies[i]!.edition !== i + 1) {
      throw new Error(
        `buildEditionTree: bodies[${i}].edition = ${bodies[i]!.edition}, expected ${i + 1}`,
      );
    }
  }
  const leaves = bodies.map(editionLeafHash);
  const leavesHex = leaves.map(bytesToHex0x);
  const tree = SimpleMerkleTree.of(leavesHex, { sortLeaves: false });
  return { tree, leaves, root: tree.root };
}

/** Generate the membership proof for one edition. */
export function proveEdition(tree: SimpleMerkleTree, body: EditionV1Body): EditionProofV1 {
  const leafHex = bytesToHex0x(editionLeafHash(body));
  return { edition: body.edition, leaf: leafHex, proof: tree.getProof(leafHex) };
}

/**
 * Stand-alone membership verifier — the verifier's view, no tree needed.
 * Recomputes the leaf from the supplied body (closed-schema validated, so a
 * v1 body is refused at dispatch), walks the proof, checks the root. Returns
 * false on any failure; never throws.
 */
export function verifyEditionInclusion(
  body: unknown,
  proof: EditionProofV1,
  expectedRoot: string, // 0x-prefixed bytes32 hex
): boolean {
  try {
    if (!validateEditionV1Body(body)) return false;
    if (body.edition !== proof.edition) return false;
    const recomputedLeaf = bytesToHex0x(editionLeafHash(body));
    if (recomputedLeaf !== proof.leaf.toLowerCase()) return false;
    return SimpleMerkleTree.verify(expectedRoot, recomputedLeaf, proof.proof);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Manifest signing + verification
// ---------------------------------------------------------------------------

/**
 * Sign a manifest body with the derived issuing key.
 *
 * REFUSES a key whose address is not `body.issuer` — a manifest signed by the
 * wrong key of a multi-key organiser verifies against nothing and is
 * discovered only at a door (the same refuse-at-signing rule as the cert
 * rail). Throws on an invalid body or mismatched key.
 */
export function signManifestV2(body: ManifestV2Body, issuingPrivKey: Uint8Array): SignedManifestV2 {
  const digest = manifestV2Digest(body); // validates; throws on a bad body
  const signer = issuingAddress(issuingPrivKey);
  if (signer !== body.issuer) {
    throw new Error(
      "issuing key mismatch: this private key is not the manifest's issuer address",
    );
  }
  return { body, signature: signPersonalMessage(buildManifestV2Message(digest), issuingPrivKey) };
}

/**
 * Full acceptance check for a signed manifest: closed-schema validation
 * (which dispatch-refuses `woco.manifest.v1`) → digest → personal-sign
 * recovery → address comparison against `body.issuer`. Returns false on any
 * failure, never throws.
 *
 * Signature validity alone does not prove this is the manifest the organiser
 * registered — callers on trust-bearing paths MUST also compare
 * `manifestV2Digest(body)` against the chain's `manifestRef` (#444).
 */
export function verifyManifestV2(value: unknown): value is SignedManifestV2 {
  try {
    if (!validateSignedManifestV2(value)) return false;
    const message = buildManifestV2Message(manifestV2Digest(value.body));
    return recoverPersonalSigner(message, value.signature) === value.body.issuer;
  } catch {
    return false;
  }
}
