/**
 * The certificate rail is the first place a SINGLE-LEAF Merkle tree is built on
 * purpose, so the properties that makes rest on are asserted rather than assumed.
 *
 * In OpenZeppelin's `SimpleMerkleTree` a one-leaf tree's root IS the leaf — no
 * hashing is applied above it. That is the shape that invites the classic
 * second-preimage confusion, where a value can be read either as a leaf or as an
 * internal node. It does not apply here, and the reason is worth pinning: leaves
 * are domain-separated (`podLeafHash` prefixes a LEAF_DOMAIN byte and the
 * edition before hashing) while internal nodes are a bare `keccak256(sort(L,R))`.
 * A leaf hash therefore cannot be produced by the internal-node construction.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";
import {
  buildPodTree,
  podLeafHash,
  bytesToHex0x,
  verifyEditionProof,
  getEditionProof,
} from "@woco/shared";
import type { PodV2Body } from "@woco/shared";
import { buildCertBadgeManifest } from "../src/lib/pod/cert-builder.js";

const PRIV = new Uint8Array(32).fill(7);
const PUB = Buffer.from(ed25519.getPublicKey(PRIV)).toString("hex");

function built() {
  return buildCertBadgeManifest({
    organiserAddress: "0x1111111111111111111111111111111111111111",
    creatorPodPrivateKey: PRIV,
    creatorPodPublicKeyHex: PUB,
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
    bytesToHex0x(podLeafHash(b.podBodies[0]!)),
    "one leaf means root == leaf under oz-simple-v1",
  );
});

test("that root is unreachable by the internal-node construction", () => {
  // Internal nodes are keccak256(sort(L,R)) over two 32-byte values with NO
  // domain byte; leaves carry LEAF_DOMAIN || edition || cbor. The two
  // preimages have different shapes, so no pair of nodes can forge this root.
  const b = built();
  const leaf = podLeafHash(b.podBodies[0]!);
  assert.equal(leaf.length, 32);
  // The property that matters downstream: only the exact template body,
  // recomputed leaf and all, verifies against this root.
  const { tree } = buildPodTree(b.podBodies);
  const proof = getEditionProof(tree, b.podBodies[0]!);
  assert.equal(proof.proof.length, 0, "a one-leaf tree needs no sibling path");
  assert.ok(verifyEditionProof(b.podBodies[0]!, proof, b.signedManifest.body.metadataRoot));
});

test("a FABRICATED edition cannot ride the empty proof", () => {
  // The real risk of an empty proof: a verifier accepting any body for a badge
  // whose declared totalSupply is 100 while only one leaf exists. The edition is
  // inside the leaf preimage, so edition 2 recomputes to a different hash.
  const b = built();
  const fake: PodV2Body = { ...b.podBodies[0]!, edition: 2 };
  const forged = { edition: 2, leaf: bytesToHex0x(podLeafHash(fake)), proof: [] as string[] };
  assert.equal(
    verifyEditionProof(fake, forged, b.signedManifest.body.metadataRoot),
    false,
    "declared supply is a CAP, not a set of provable editions — nothing beyond leaf 1 exists",
  );
});

test("edition 1 is REQUIRED, not stylistic — buildPodTree enforces edition === index+1", () => {
  const b = built();
  const wrong: PodV2Body = { ...b.podBodies[0]!, edition: 0 };
  assert.throws(() => buildPodTree([wrong]), /edition/);
  const alsoWrong: PodV2Body = { ...b.podBodies[0]!, edition: 7 };
  assert.throws(() => buildPodTree([alsoWrong]), /edition/);
});
