/**
 * GOLDEN VECTORS for the two manifest builders, on the v2 issuer curve.
 *
 * These exist for one reason: the certificate rail and the ticket rail share a
 * seal-and-sign core, and a shared core is only worth having if a change to it
 * cannot silently move the TICKET rail's signed bytes. `buildEventManifests`
 * output is what `PublishButton` commits on chain for real, saleable events —
 * a moved digest there is a manifest that no longer matches its registration.
 *
 * So the digests below are pinned. If a refactor moves one, that is the finding,
 * not a value to update: recompute deliberately and say why in the commit.
 *
 * RECOMPUTED ONCE, deliberately, for the issuer-curve migration (PR 4): the
 * builders now emit `woco.manifest.v2` + `woco.edition.v1` signed by the
 * derived secp256k1 issuing key, so the v1 pins could not survive by
 * definition. These are the byte identity of the v2 rails from here on.
 * Reproducible on any correct stack: secp256k1 signing is RFC-6979
 * deterministic, and both variance sources (seriesId, mintedAt) are fixed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { issuingAddress } from "@woco/shared";
import { buildEventManifests } from "../src/lib/pod/event-builder.js";
import { buildCertBadgeManifest } from "../src/lib/pod/cert-builder.js";

const PRIV = new Uint8Array(32).fill(7);
const AT = "2026-08-21T00:00:00.000Z";

function ticket() {
  const [built] = buildEventManifests({
    issuingPrivKey: PRIV,
    eventMeta: { startDate: "2026-09-01", location: "Bristol", imageHash: "ab".repeat(32) },
    series: [{ seriesId: "golden-series", name: "GA", description: "General admission", totalSupply: 3 }],
    mintedAt: AT,
  });
  return built!;
}

function cert() {
  return buildCertBadgeManifest({
    issuingPrivKey: PRIV,
    name: "Founding Member",
    description: "Awarded to the first crew",
    cap: 100,
    seriesId: "golden-series",
    mintedAt: AT,
  });
}

/** The fixed key's issuing address — the issuer identity in every pinned body. */
const ISSUER_GOLDEN = "0x4a62316623ad457f02cdc5d997ded67a383ec569";

/** Captured 2026-09-01 from the PR 4 v2 builders. */
const TICKET_GOLDEN = {
  manifestDigestHex: "0xa67670b6c0aac23a3c8c413952d9e751f40ce3c61fc76db49e6c517cea819476",
  metadataRoot: "0x331e32a49ec51f7aff38d1dee8f3825b19abe2551ef0c8c19ffc6cb79e244122",
  signature:
    "0x2b6dd512121deb9e66bcea57d160c81036b56ec1014d8eda16613da4343bcadc1e14c86f2a6f6cf3f458d98bc9aa5c130cc38e50c3ed274c7b17778b934c50b81c",
} as const;

const CERT_GOLDEN = {
  manifestDigestHex: "0xff0ac19ef4e05e8723e2a9d149e38e414acc26dd211c17bda3552fd048a3a2f1",
  metadataRoot: "0x653268f3397a2f57d8c9547f9a6af103fbcb6ffb46acb127a0ec8d9d1b8132e9",
  signature:
    "0x71d23ba3db25047cb5486d6259099f692d1a42f7ab67562963ac10f3575dc7a314116675a7796fe5ef7863147a60c55803eff6f13ae1e0bd85710910145cd20c1c",
} as const;

test("TICKET RAIL byte identity — unchanged by the shared seal-and-sign core", () => {
  const built = ticket();
  assert.equal(built.manifestDigestHex, TICKET_GOLDEN.manifestDigestHex);
  assert.equal(built.signedManifest.body.metadataRoot, TICKET_GOLDEN.metadataRoot);
  assert.equal(built.signedManifest.body.issuer, ISSUER_GOLDEN);
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
  assert.equal(built.signedManifest.body.issuer, ISSUER_GOLDEN);
  assert.equal(built.signedManifest.signature, CERT_GOLDEN.signature);
});

test("the fixed key's issuing address is itself pinned", () => {
  // The two signature pins above only bind the SIGNER given the message; this
  // binds the identity the bodies carry. All three would move together on a
  // curve or address-derivation change — this one names the failure.
  assert.equal(issuingAddress(PRIV), ISSUER_GOLDEN);
});

test("the two rails do not collide on any pinned value", () => {
  assert.notEqual(TICKET_GOLDEN.manifestDigestHex, CERT_GOLDEN.manifestDigestHex);
  assert.notEqual(TICKET_GOLDEN.metadataRoot, CERT_GOLDEN.metadataRoot);
});
