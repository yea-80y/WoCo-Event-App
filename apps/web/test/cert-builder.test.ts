/**
 * The certificate badge manifest builder, and the ticket rail it must not touch.
 *
 * Half of this file is about `cert-builder.ts`. The other half pins
 * `event-builder.ts` — the TICKET rail's manifest builder — because the
 * certificate rail was deliberately built as its sibling rather than as a flag
 * on it, and a sibling is only safe for as long as nobody merges them later.
 * `buildEventManifests` is what `PublishButton` uses to publish real, saleable
 * events; a body count that stopped matching `totalSupply` there would produce
 * a manifest whose Merkle root covers fewer editions than the contract sells,
 * and it would fail at CLAIM time, on the money path, long after the publish
 * that caused it looked successful.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";
import { verifySignedManifest, buildPodTree, manifestDigest, bytesToHex0x } from "@woco/shared";
import { buildCertBadgeManifest } from "../src/lib/pod/cert-builder.js";
import { buildEventManifests } from "../src/lib/pod/event-builder.js";

const PRIV = new Uint8Array(32).fill(7);
const PUB = Buffer.from(ed25519.getPublicKey(PRIV)).toString("hex");
const ORG = "0x1111111111111111111111111111111111111111";

function certOpts(over: Record<string, unknown> = {}) {
  return {
    organiserAddress: ORG,
    creatorPodPrivateKey: PRIV,
    creatorPodPublicKeyHex: PUB,
    name: "Founding Member",
    description: "Awarded to the first crew",
    cap: 100,
    seriesId: "fixed-series-id",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The certificate rail
// ---------------------------------------------------------------------------

test("commits to exactly ONE template body, whatever the cap", () => {
  for (const cap of [1, 100, 10_000]) {
    const built = buildCertBadgeManifest(certOpts({ cap }));
    assert.equal(
      built.podBodies.length,
      1,
      `cap ${cap} must still commit one body — issuePodType refuses anything else`,
    );
  }
});

test("totalSupply is the CAP, not the body count", () => {
  const built = buildCertBadgeManifest(certOpts({ cap: 250 }));
  assert.equal(built.signedManifest.body.totalSupply, 250);
  assert.equal(built.podBodies.length, 1);
});

test("the manifest signature verifies, and the root covers the single leaf", () => {
  const built = buildCertBadgeManifest(certOpts());
  assert.ok(verifySignedManifest(built.signedManifest), "manifest must be self-verifying");
  const { root } = buildPodTree(built.podBodies);
  assert.equal(
    built.signedManifest.body.metadataRoot,
    root,
    "metadataRoot must be an honest commitment to bytes that exist",
  );
});

test("manifestDigestHex is the badge id — keccak256(dagCbor(body))", () => {
  const built = buildCertBadgeManifest(certOpts());
  assert.equal(built.manifestDigestHex, bytesToHex0x(manifestDigest(built.signedManifest.body)));
});

test("issuerPubkey is the signer, and a 0x-prefixed input is normalised", () => {
  const bare = buildCertBadgeManifest(certOpts());
  const prefixed = buildCertBadgeManifest(certOpts({ creatorPodPublicKeyHex: `0x${PUB}` }));
  assert.equal(bare.signedManifest.body.issuerPubkey, PUB);
  assert.equal(prefixed.signedManifest.body.issuerPubkey, PUB);
  assert.equal(bare.podBodies[0]!.issuer, PUB);
});

test("TWO MINTS ARE TWO BADGES — the per-mint nonce is load-bearing", () => {
  // Same name, description, cap and artwork. Without a nonce inside the
  // committed body these hash identically, which would silently make them ONE
  // badge sharing ONE certificate log: manifestRef is the identity the
  // directory entry, the gate and the log topic all key on.
  const a = buildCertBadgeManifest(certOpts({ seriesId: undefined }));
  const b = buildCertBadgeManifest(certOpts({ seriesId: undefined }));
  assert.notEqual(a.manifestDigestHex, b.manifestDigestHex);
  assert.notEqual(a.podBodies[0]!.seriesId, b.podBodies[0]!.seriesId);
});

test("fully determined by its inputs — fixed nonce AND fixed clock reproduce the badge", () => {
  // Both sources of per-call variance pinned: the deliberate one (seriesId) and
  // the incidental one (mintedAt). Determinism here is what lets the signed
  // bytes be pinned as a golden vector at all — a signing path whose output
  // cannot be reproduced cannot be proved unchanged by a later refactor.
  const at = "2026-08-21T00:00:00.000Z";
  const a = buildCertBadgeManifest(certOpts({ mintedAt: at }));
  const b = buildCertBadgeManifest(certOpts({ mintedAt: at }));
  assert.equal(a.manifestDigestHex, b.manifestDigestHex);
  assert.equal(a.signedManifest.signature, b.signedManifest.signature);
});

test("the CLOCK is not the uniqueness mechanism — same millisecond, different badge", () => {
  // Two mints inside one millisecond must still be two badges. If uniqueness
  // rested on mintedAt they would collide, share a manifestRef, and therefore
  // share one certificate log.
  const at = "2026-08-21T00:00:00.000Z";
  const a = buildCertBadgeManifest(certOpts({ seriesId: undefined, mintedAt: at }));
  const b = buildCertBadgeManifest(certOpts({ seriesId: undefined, mintedAt: at }));
  assert.notEqual(a.manifestDigestHex, b.manifestDigestHex);
});

test("refuses a cap that is not a positive integer", () => {
  for (const cap of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => buildCertBadgeManifest(certOpts({ cap })), /cap/i, `cap ${cap} must refuse`);
  }
});

// ---------------------------------------------------------------------------
// The ticket rail, pinned — this file's other job
// ---------------------------------------------------------------------------

test("TICKET RAIL: buildEventManifests still emits one body PER EDITION", () => {
  const [built] = buildEventManifests({
    organiserAddress: ORG,
    organiserNonce: 0n,
    creatorPodPrivateKey: PRIV,
    creatorPodPublicKeyHex: PUB,
    eventMeta: {},
    series: [{ seriesId: "s1", name: "GA", description: "", totalSupply: 5 }],
  });
  assert.equal(built!.podBodies.length, 5, "a body per claimable slot — the contract sells each one");
  assert.equal(built!.signedManifest.body.totalSupply, 5);
  assert.deepEqual(
    built!.podBodies.map((b) => b.edition),
    [1, 2, 3, 4, 5],
    "editions stay 1-indexed and contiguous",
  );
  assert.ok(verifySignedManifest(built!.signedManifest));
});

test("TICKET RAIL: multi-series publish still consumes one nonce slot each", () => {
  const built = buildEventManifests({
    organiserAddress: ORG,
    organiserNonce: 3n,
    creatorPodPrivateKey: PRIV,
    creatorPodPublicKeyHex: PUB,
    eventMeta: { startDate: "2026-09-01" },
    series: [
      { seriesId: "a", name: "Early", description: "", totalSupply: 2 },
      { seriesId: "b", name: "Late", description: "", totalSupply: 3 },
    ],
  });
  assert.equal(built.length, 2);
  assert.equal(built[0]!.podBodies.length, 2);
  assert.equal(built[1]!.podBodies.length, 3);
  assert.notEqual(
    built[0]!.predictedOnChainEventId,
    built[1]!.predictedOnChainEventId,
    "each series takes its own nonce",
  );
});

test("THE TWO RAILS PRODUCE DIFFERENT BADGES even from identical inputs", () => {
  // Nothing enforces this at a type level, so it is asserted: a certificate
  // badge and a chain badge must never collide on manifestRef, or one rail's
  // gate would resolve against the other rail's holdings.
  const [chain] = buildEventManifests({
    organiserAddress: ORG,
    organiserNonce: 0n,
    creatorPodPrivateKey: PRIV,
    creatorPodPublicKeyHex: PUB,
    eventMeta: {},
    series: [{ seriesId: "fixed-series-id", name: "Founding Member", description: "Awarded to the first crew", totalSupply: 100 }],
  });
  const cert = buildCertBadgeManifest(certOpts());
  assert.notEqual(chain!.manifestDigestHex, cert.manifestDigestHex);
});
