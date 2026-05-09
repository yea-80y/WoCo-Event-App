/**
 * Merkle tree + manifest signing test vectors.
 *
 * Covers the full producer/verifier round-trip:
 *  - Tree builds correctly across edge supply counts (1, 2, 3, 1000, 50000)
 *  - Proofs verify against the root for every edition
 *  - Edition-swap rejected (leaf-A's proof + POD-B fails)
 *  - Tampered POD body rejected
 *  - Tampered manifest digest rejected (signature verify fails)
 *  - Cross-pod proof rejection (proof for one tree against another's root)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";
import {
  buildPodTree,
  getEditionProof,
  signManifest,
  verifyEditionProof,
  verifySignedManifest,
} from "../../src/pod/merkle.js";
import { bytesToHex0x } from "../../src/pod/canonical.js";
import type { ManifestV1Body, PodV2Body } from "../../src/pod/types.js";

const ZERO_EVENT_ID =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

function makePod(edition: number, overrides: Partial<PodV2Body> = {}): PodV2Body {
  return {
    format: "woco.ticket.v2",
    eventId: ZERO_EVENT_ID,
    seriesId: "series-a",
    edition,
    metadata: { name: "GA", image: "ref:abc" },
    issuer: "00".repeat(32),
    ...overrides,
  };
}

function makePods(n: number, issuerPubkeyHex = "00".repeat(32)): PodV2Body[] {
  return Array.from({ length: n }, (_, i) =>
    makePod(i + 1, { issuer: issuerPubkeyHex }),
  );
}

// ---------------------------------------------------------------------------
// Tree build — edge supply counts
// ---------------------------------------------------------------------------

test("tree: builds for supply=1", () => {
  const { tree, leaves, root } = buildPodTree(makePods(1));
  assert.equal(leaves.length, 1);
  // For a single leaf, the root is that leaf (OZ's tree convention).
  assert.equal(root, bytesToHex0x(leaves[0]!));
  assert.equal(tree.root, root);
});

test("tree: builds for supply=2", () => {
  const { leaves, root } = buildPodTree(makePods(2));
  assert.equal(leaves.length, 2);
  assert.notEqual(root, bytesToHex0x(leaves[0]!));
  assert.notEqual(root, bytesToHex0x(leaves[1]!));
});

test("tree: builds for supply=3 (non-power-of-2)", () => {
  const { leaves, root } = buildPodTree(makePods(3));
  assert.equal(leaves.length, 3);
  assert.match(root, /^0x[0-9a-f]{64}$/);
});

test("tree: builds for supply=1000", () => {
  const { leaves, root } = buildPodTree(makePods(1000));
  assert.equal(leaves.length, 1000);
  assert.match(root, /^0x[0-9a-f]{64}$/);
});

test("tree: builds for supply=50000", { timeout: 30_000 }, () => {
  const start = Date.now();
  const { leaves, root } = buildPodTree(makePods(50000));
  const elapsed = Date.now() - start;
  assert.equal(leaves.length, 50000);
  assert.match(root, /^0x[0-9a-f]{64}$/);
  // Sanity: should comfortably build in well under 30s on any laptop.
  assert.ok(elapsed < 30_000, `tree build took ${elapsed}ms — perf regression?`);
});

test("tree: rejects empty pod list", () => {
  assert.throws(() => buildPodTree([]));
});

test("tree: rejects misordered editions", () => {
  const pods = [makePod(1), makePod(3)]; // missing edition 2
  assert.throws(() => buildPodTree(pods), /edition/);
});

test("tree: rejects 1-indexed-from-0 mistake", () => {
  const pods = [makePod(0), makePod(1)]; // started from 0
  assert.throws(() => buildPodTree(pods), /edition/);
});

// ---------------------------------------------------------------------------
// Proof generation + verification — round-trip
// ---------------------------------------------------------------------------

test("proof: every edition verifies (supply=1)", () => {
  const pods = makePods(1);
  const { tree, root } = buildPodTree(pods);
  const proof = getEditionProof(tree, pods[0]!);
  assert.ok(verifyEditionProof(pods[0]!, proof, root));
});

test("proof: every edition verifies (supply=7, non-power-of-2)", () => {
  const pods = makePods(7);
  const { tree, root } = buildPodTree(pods);
  for (const pod of pods) {
    const proof = getEditionProof(tree, pod);
    assert.ok(
      verifyEditionProof(pod, proof, root),
      `edition ${pod.edition} did not verify`,
    );
  }
});

test("proof: every edition verifies (supply=128, power-of-2)", () => {
  const pods = makePods(128);
  const { tree, root } = buildPodTree(pods);
  for (const pod of pods) {
    const proof = getEditionProof(tree, pod);
    assert.ok(verifyEditionProof(pod, proof, root));
  }
});

test("proof: spot-check editions verify (supply=1000)", () => {
  const pods = makePods(1000);
  const { tree, root } = buildPodTree(pods);
  for (const idx of [0, 1, 17, 499, 998, 999]) {
    const pod = pods[idx]!;
    const proof = getEditionProof(tree, pod);
    assert.ok(verifyEditionProof(pod, proof, root), `edition ${pod.edition} failed`);
  }
});

// ---------------------------------------------------------------------------
// Attack vectors — edition swap, tampering, cross-tree replay
// ---------------------------------------------------------------------------

test("attack: edition-swap proof rejected", () => {
  // Generate proof for edition 5, then try to verify it against a POD whose
  // edition field has been swapped to 6. Even if all other metadata matched,
  // the leaf hash differs because edition is bound into it.
  const pods = makePods(10);
  const { tree, root } = buildPodTree(pods);
  const proofForFive = getEditionProof(tree, pods[4]!);
  const tamperedPod: PodV2Body = { ...pods[4]!, edition: 6 };
  assert.equal(verifyEditionProof(tamperedPod, proofForFive, root), false);
});

test("attack: tampered POD metadata rejected", () => {
  const pods = makePods(5);
  const { tree, root } = buildPodTree(pods);
  const proof = getEditionProof(tree, pods[2]!);
  const tampered: PodV2Body = {
    ...pods[2]!,
    metadata: { ...pods[2]!.metadata, name: "VIP — FAKE UPGRADE" },
  };
  assert.equal(verifyEditionProof(tampered, proof, root), false);
});

test("attack: tampered POD seriesId rejected", () => {
  const pods = makePods(5);
  const { tree, root } = buildPodTree(pods);
  const proof = getEditionProof(tree, pods[2]!);
  const tampered: PodV2Body = { ...pods[2]!, seriesId: "different-series" };
  assert.equal(verifyEditionProof(tampered, proof, root), false);
});

test("attack: cross-tree proof replay rejected", () => {
  // Two events with similar but distinct metadata. A proof from event A
  // must not verify against event B's root.
  const podsA = makePods(20).map((p) => ({ ...p, eventId: ("0x" + "11".repeat(32)) }));
  const podsB = makePods(20).map((p) => ({ ...p, eventId: ("0x" + "22".repeat(32)) }));
  const { tree: treeA } = buildPodTree(podsA);
  const { root: rootB } = buildPodTree(podsB);
  const proofA = getEditionProof(treeA, podsA[5]!);
  // Replaying the proof against B's root must fail.
  assert.equal(verifyEditionProof(podsA[5]!, proofA, rootB), false);
});

test("attack: leaf field swap (proof.leaf doesn't match POD) rejected", () => {
  const pods = makePods(10);
  const { tree, root } = buildPodTree(pods);
  const proofFor3 = getEditionProof(tree, pods[2]!);
  const proofFor7 = getEditionProof(tree, pods[6]!);
  // Try to attach edition-3's POD to edition-7's proof bundle.
  const forged = { ...proofFor7, edition: 3, leaf: proofFor3.leaf };
  assert.equal(verifyEditionProof(pods[2]!, forged, root), false);
});

// ---------------------------------------------------------------------------
// Manifest signing + verification
// ---------------------------------------------------------------------------

function makeManifestForRoot(root: string, pubkeyHex: string, totalSupply: number): ManifestV1Body {
  return {
    format: "woco.manifest.v1",
    eventId: ZERO_EVENT_ID,
    totalSupply,
    issuerPubkey: pubkeyHex,
    metadataRoot: root,
    encoding: "cbor-v1",
    treeScheme: "oz-simple-v1",
  };
}

test("manifest: sign + verify round-trip", () => {
  const priv = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(priv);
  const pubHex = bytesToHex0xNoPrefix(pub);
  const pods = makePods(50, pubHex);
  const { root } = buildPodTree(pods);
  const body = makeManifestForRoot(root, pubHex, pods.length);
  const signed = signManifest(body, priv);
  assert.ok(verifySignedManifest(signed));
});

test("manifest: tampered metadataRoot fails verification", () => {
  const priv = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(priv);
  const pubHex = bytesToHex0xNoPrefix(pub);
  const pods = makePods(10, pubHex);
  const { root } = buildPodTree(pods);
  const body = makeManifestForRoot(root, pubHex, pods.length);
  const signed = signManifest(body, priv);
  const tampered = {
    ...signed,
    body: {
      ...signed.body,
      metadataRoot: ("0x" + "ff".repeat(32)),
    },
  };
  assert.equal(verifySignedManifest(tampered), false);
});

test("manifest: tampered totalSupply fails verification", () => {
  const priv = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(priv);
  const pubHex = bytesToHex0xNoPrefix(pub);
  const pods = makePods(10, pubHex);
  const { root } = buildPodTree(pods);
  const body = makeManifestForRoot(root, pubHex, pods.length);
  const signed = signManifest(body, priv);
  const tampered = { ...signed, body: { ...signed.body, totalSupply: 99999 } };
  assert.equal(verifySignedManifest(tampered), false);
});

test("manifest: signature from wrong key fails", () => {
  const priv1 = ed25519.utils.randomPrivateKey();
  const priv2 = ed25519.utils.randomPrivateKey();
  const pub1Hex = bytesToHex0xNoPrefix(ed25519.getPublicKey(priv1));
  const pods = makePods(5, pub1Hex);
  const { root } = buildPodTree(pods);
  const body = makeManifestForRoot(root, pub1Hex, pods.length);
  // Sign with priv2 but claim issuerPubkey is pub1 — verifier must reject.
  const wrongSigned = signManifest(body, priv2);
  assert.equal(verifySignedManifest(wrongSigned), false);
});

test("manifest: malformed signature fails gracefully (no throw)", () => {
  const priv = ed25519.utils.randomPrivateKey();
  const pubHex = bytesToHex0xNoPrefix(ed25519.getPublicKey(priv));
  const pods = makePods(3, pubHex);
  const { root } = buildPodTree(pods);
  const body = makeManifestForRoot(root, pubHex, pods.length);
  const signed = signManifest(body, priv);
  const malformed = { ...signed, signature: "deadbeef" }; // wrong length
  assert.equal(verifySignedManifest(malformed), false);
});

// ---------------------------------------------------------------------------
// End-to-end — mimic verifier's real path
// ---------------------------------------------------------------------------

test("e2e: full verifier path against fixed-issuer reference event", () => {
  // Simulate exactly what an offline scanner does:
  //   1. Verify manifest sig.
  //   2. Recompute manifest digest (== chain manifestRef).
  //   3. Recompute leaf for scanned edition.
  //   4. Verify Merkle proof against manifest.metadataRoot.
  const priv = ed25519.utils.randomPrivateKey();
  const pubHex = bytesToHex0xNoPrefix(ed25519.getPublicKey(priv));
  const pods = makePods(42, pubHex);
  const { tree, root } = buildPodTree(pods);
  const body = makeManifestForRoot(root, pubHex, pods.length);
  const signed = signManifest(body, priv);

  // Offline verifier:
  assert.ok(verifySignedManifest(signed), "step 1: manifest sig invalid");
  assert.equal(signed.body.metadataRoot, root, "step 2: root mismatch");

  // Pick a random edition to "scan":
  const scanned = pods[16]!;
  const proof = getEditionProof(tree, scanned);
  assert.ok(
    verifyEditionProof(scanned, proof, signed.body.metadataRoot),
    "step 3-4: proof did not verify",
  );
});

// ---------------------------------------------------------------------------
// Helpers — local hex helper using no-0x form (matches existing verify.ts)
// ---------------------------------------------------------------------------

function bytesToHex0xNoPrefix(bytes: Uint8Array): string {
  return bytesToHex0x(bytes).slice(2);
}
