/**
 * GOLDEN VECTORS for the two manifest builders.
 *
 * These exist for one reason: the certificate rail and the ticket rail share a
 * seal-and-sign core, and a shared core is only worth having if a change to it
 * cannot silently move the TICKET rail's signed bytes. `buildEventManifests`
 * output is what `PublishButton` commits on chain for real, saleable events —
 * a moved digest there is a manifest that no longer matches its registration.
 *
 * So the digests below are pinned. If a refactor moves one, that is the finding,
 * not a value to update: recompute deliberately and say why in the commit.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";
import { buildEventManifests } from "../src/lib/pod/event-builder.js";
import { buildCertBadgeManifest } from "../src/lib/pod/cert-builder.js";

const PRIV = new Uint8Array(32).fill(7);
const PUB = Buffer.from(ed25519.getPublicKey(PRIV)).toString("hex");
const ORG = "0x1111111111111111111111111111111111111111";
const AT = "2026-08-21T00:00:00.000Z";

function ticket() {
  const [built] = buildEventManifests({
    organiserAddress: ORG,
    organiserNonce: 0n,
    creatorPodPrivateKey: PRIV,
    creatorPodPublicKeyHex: PUB,
    eventMeta: { startDate: "2026-09-01", location: "Bristol", imageHash: "ab".repeat(32) },
    series: [{ seriesId: "golden-series", name: "GA", description: "General admission", totalSupply: 3 }],
    mintedAt: AT,
  });
  return built!;
}

function cert() {
  return buildCertBadgeManifest({
    organiserAddress: ORG,
    creatorPodPrivateKey: PRIV,
    creatorPodPublicKeyHex: PUB,
    name: "Founding Member",
    description: "Awarded to the first crew",
    cap: 100,
    seriesId: "golden-series",
    mintedAt: AT,
  });
}

/**
 * Captured 2026-08-21 from the pre-refactor `buildEventManifests`, BEFORE the
 * seal-and-sign core was shared with the certificate rail. This is the byte
 * identity of the live ticket rail.
 */
const TICKET_GOLDEN = {
  manifestDigestHex: "0xb9a75a260675eca2a07950e814074489ebc1c9f94c0dde5bade7603daeb730da",
  metadataRoot: "0x2098b06e6eb5d565032c4edae1be8fbb837bcb4a795be630f648f8d4ac8cfc3a",
  signature:
    "778d7a478a4e91ae1422571f258448c6fc6761b14bb7442e092b48f89a14c7474b34eafa11694d19ef997cdc526367ee0b1586e9b4e497250ba17c0a11fcc909",
} as const;

const CERT_GOLDEN = {
  manifestDigestHex: "0x5f405c61285886f3a0eed5af1210652a53b85cd61a9f60c45b41e104fb84ceb4",
  metadataRoot: "0x5c2952cea5e9d6152f746ac39e6db69032b7378846086fd20215cd22e25dec09",
  signature:
    "679c17565431918a725d2484599abd58c2e7dadb63fe0bb6ee8184720b5f8f652d4f144f173bd02dfb2963484afc25db07efc110fd28057a9069c6ad1f886006",
} as const;

test("TICKET RAIL byte identity — unchanged by the shared seal-and-sign core", () => {
  const built = ticket();
  assert.equal(built.manifestDigestHex, TICKET_GOLDEN.manifestDigestHex);
  assert.equal(built.signedManifest.body.metadataRoot, TICKET_GOLDEN.metadataRoot);
  assert.equal(
    built.signedManifest.signature,
    TICKET_GOLDEN.signature,
    "the ticket rail's SIGNED BYTES moved — this is a finding, not a value to update",
  );
});

test("CERTIFICATE RAIL byte identity", () => {
  const built = cert();
  assert.equal(built.manifestDigestHex, CERT_GOLDEN.manifestDigestHex);
  assert.equal(built.signedManifest.body.metadataRoot, CERT_GOLDEN.metadataRoot);
  assert.equal(built.signedManifest.signature, CERT_GOLDEN.signature);
});

test("the two rails do not collide on any pinned value", () => {
  assert.notEqual(TICKET_GOLDEN.manifestDigestHex, CERT_GOLDEN.manifestDigestHex);
  assert.notEqual(TICKET_GOLDEN.metadataRoot, CERT_GOLDEN.metadataRoot);
});
