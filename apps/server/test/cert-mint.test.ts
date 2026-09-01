/**
 * Minting a badge whose holdings are CERTIFICATES rather than chain slots.
 *
 * Every refusal here fires before any Swarm upload or chain call, which is the
 * property being tested alongside the refusal itself: a half-minted badge — one
 * whose manifest is on Swarm but whose log can never be found — is not
 * recoverable by retrying.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { EditionV1Body, Hex0x, ManifestV2Body } from "@woco/shared";
import { buildEditionTree, issuingAddress, signManifestV2 } from "@woco/shared";
import { issuePodType } from "../src/lib/pod/issuance.js";

/** The issuing key (secp256k1) — its ADDRESS is the v2 issuer identity. */
const ISSUER_PRIV = new Uint8Array(32).fill(7);
const ISSUER = issuingAddress(ISSUER_PRIV);
const CREATOR = "0x1111111111111111111111111111111111111111" as Hex0x;
const LOG_OWNER = "0x2222222222222222222222222222222222222222" as Hex0x;
const CAP = 500;

/** The single real template body a certificate badge commits to. */
function templateBody(seriesId = "cert-badge-1", edition = 1): EditionV1Body {
  return {
    format: "woco.edition.v1",
    seriesId,
    edition,
    metadata: { name: "Century Rider", description: "100 laps" },
    issuer: ISSUER,
  };
}

function manifestFor(bodies: EditionV1Body[], totalSupply = CAP) {
  const { root } = buildEditionTree(bodies);
  const body: ManifestV2Body = {
    format: "woco.manifest.v2",
    totalSupply,
    issuer: ISSUER,
    metadataRoot: root,
    encoding: "cbor-v1",
    treeScheme: "oz-simple-v1",
  };
  return signManifestV2(body, ISSUER_PRIV);
}

function certOpts(over: Record<string, unknown> = {}) {
  const bodies = [templateBody()];
  return {
    creatorAddress: CREATOR,
    kind: "badge" as const,
    name: "Century Rider",
    supply: CAP,
    holdingSource: "pod-cert" as const,
    certLogOwner: LOG_OWNER,
    signedManifest: manifestFor(bodies),
    editionBodies: bodies,
    ...over,
  };
}

test("a certificate badge without a log owner is refused before anything is written", async () => {
  // The badge would otherwise mint fine and its log be unfindable forever: the
  // topic is derivable from the manifest by anyone, but the owner half of a
  // chunk address appears in no public artifact.
  await assert.rejects(
    () => issuePodType(certOpts({ certLogOwner: undefined })),
    /certLogOwner|log can never be found/,
  );
});

test("a certificate badge commits to exactly one template body, not one per unit of supply", async () => {
  // Nothing on this rail ever claims an edition, so pre-signing 500 bodies
  // would cost 500 signatures and 500 uploads to commit to bytes no reader
  // reads. The cap lives in the manifest's totalSupply instead.
  const many = [templateBody("a", 1), templateBody("a", 2)];
  await assert.rejects(
    () => issuePodType(certOpts({ editionBodies: many, signedManifest: manifestFor(many) })),
    /exactly 1 template edition body, got 2/,
  );
});

test("the single template body is a REAL leaf — a mismatched root is still refused", async () => {
  // The degenerate tree is genuine, not a sentinel: metadataRoot commits to
  // bytes that exist and are fetchable, so verifySignedManifest needs no
  // special case for this rail.
  const bodies = [templateBody()];
  await assert.rejects(
    () => issuePodType(certOpts({ editionBodies: bodies, signedManifest: manifestFor([templateBody("other")]) })),
    /Merkle root mismatch/,
  );
});

test("the manifest's totalSupply must be the declared cap", async () => {
  const bodies = [templateBody()];
  await assert.rejects(
    () => issuePodType(certOpts({ editionBodies: bodies, signedManifest: manifestFor(bodies, 7) })),
    /totalSupply does not match/,
  );
});

test("a tampered manifest signature is refused on this rail too", async () => {
  const bodies = [templateBody()];
  const signed = manifestFor(bodies);
  await assert.rejects(
    () =>
      issuePodType(
        certOpts({
          editionBodies: bodies,
          signedManifest: { ...signed, signature: `0x${"00".repeat(64)}1b` },
        }),
      ),
    /Manifest signature invalid/,
  );
});

test("a legacy woco.manifest.v1 object is REFUSED at dispatch — the v1 cutoff", async () => {
  const bodies = [templateBody()];
  const v1Shaped = {
    body: {
      format: "woco.manifest.v1",
      eventId: `0x${"11".repeat(32)}`,
      totalSupply: CAP,
      issuerPubkey: "ab".repeat(32),
      metadataRoot: `0x${"22".repeat(32)}`,
      encoding: "cbor-v1",
      treeScheme: "oz-simple-v1",
    },
    signature: "cd".repeat(64),
  };
  await assert.rejects(
    () => issuePodType(certOpts({ editionBodies: bodies, signedManifest: v1Shaped })),
    /Manifest signature invalid/,
  );
});
