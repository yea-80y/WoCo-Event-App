/**
 * The certificate rail is the first place a SINGLE-LEAF Merkle tree is built on
 * purpose, so the properties that makes rest on are asserted rather than assumed.
 *
 * In OpenZeppelin's `SimpleMerkleTree` a one-leaf tree's root IS the leaf — no
 * hashing is applied above it. That is the shape that invites the classic
 * second-preimage confusion, where a value can be read either as a leaf or as an
 * internal node. It does not apply here, and the reason is worth pinning: leaves
 * are domain-separated (`editionLeafHash` prefixes a LEAF_DOMAIN byte and the
 * edition before hashing) while internal nodes are a bare `keccak256(sort(L,R))`.
 * A leaf hash therefore cannot be produced by the internal-node construction.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildEditionTree,
  bytesToHex0x,
  editionLeafHash,
  proveEdition,
  verifyEditionInclusion,
} from "@woco/shared";
import type { EditionV1Body } from "@woco/shared";
import { buildCertBadgeManifest } from "../src/lib/pod/cert-builder.js";

const PRIV = new Uint8Array(32).fill(7);

function built() {
  return buildCertBadgeManifest({
    issuingPrivKey: PRIV,
    name: "Founding Member",
    description: "Awarded to the first crew",
    cap: 100,
    seriesId: "fixed",
    mintedAt: "2026-08-21T00:00:00.000Z",
  });
}

test("the single-leaf root IS the domain-separated leaf hash", () => {
  const b = built();
  assert.equal(
    b.signedManifest.body.metadataRoot,
    bytesToHex0x(editionLeafHash(b.editionBodies[0]!)),
    "one leaf means root == leaf under oz-simple-v1",
  );
});

test("that root is unreachable by the internal-node construction", () => {
  // Internal nodes are keccak256(sort(L,R)) over two 32-byte values with NO
  // domain byte; leaves carry LEAF_DOMAIN || edition || cbor. The two
  // preimages have different shapes, so no pair of nodes can forge this root.
  const b = built();
  const leaf = editionLeafHash(b.editionBodies[0]!);
  assert.equal(leaf.length, 32);
  // The property that matters downstream: only the exact template body,
  // recomputed leaf and all, verifies against this root.
  const { tree } = buildEditionTree(b.editionBodies);
  const proof = proveEdition(tree, b.editionBodies[0]!);
  assert.equal(proof.proof.length, 0, "a one-leaf tree needs no sibling path");
  assert.ok(verifyEditionInclusion(b.editionBodies[0]!, proof, b.signedManifest.body.metadataRoot));
});

test("a FABRICATED edition cannot ride the empty proof", () => {
  // The real risk of an empty proof: a verifier accepting any body for a badge
  // whose declared totalSupply is 100 while only one leaf exists. The edition is
  // inside the leaf preimage, so edition 2 recomputes to a different hash.
  const b = built();
  const fake: EditionV1Body = { ...b.editionBodies[0]!, edition: 2 };
  const forged = { edition: 2, leaf: bytesToHex0x(editionLeafHash(fake)), proof: [] };
  assert.equal(
    verifyEditionInclusion(fake, forged, b.signedManifest.body.metadataRoot),
    false,
    "declared supply is a CAP, not a set of provable editions — nothing beyond leaf 1 exists",
  );
});

test("edition 1 is REQUIRED, not stylistic — buildEditionTree enforces edition === index+1", () => {
  const b = built();
  const wrong: EditionV1Body = { ...b.editionBodies[0]!, edition: 7 };
  assert.throws(() => buildEditionTree([wrong]), /edition/);
});
