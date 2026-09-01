/**
 * validateSeriesManifest — the TICKET rail's only manifest-signature check
 * (PR 1, #444 audit; on the v2 issuer curve since PR 5a).
 *
 * The charge-time binding (onchain-binding.ts) compares DIGESTS, deliberately
 * not signatures: an attacker pointing a series at a victim's public blob is
 * caught by the digest anchor, and the signature check would not help there.
 * Which means the signature is verified exactly once on this rail — at the
 * write boundary, by this function.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildEditionTree,
  buildManifestV2Message,
  issuingAddress,
  manifestV2Digest,
  signManifestV2,
  signPersonalMessage,
  type EditionV1Body,
  type ManifestV2Body,
} from "@woco/shared";
import { validateSeriesManifest } from "../src/lib/event/service.js";

const ISSUER_PRIV = new Uint8Array(32).fill(7);
const ISSUER = issuingAddress(ISSUER_PRIV);
const ATTACKER_PRIV = new Uint8Array(32).fill(11);

function bodies(n: number): EditionV1Body[] {
  return Array.from({ length: n }, (_, i) => ({
    format: "woco.edition.v1",
    seriesId: "ga",
    edition: i + 1,
    metadata: { name: "GA" },
    issuer: ISSUER,
  }));
}

function series(n = 3) {
  const editionBodies = bodies(n);
  const { root } = buildEditionTree(editionBodies);
  const body: ManifestV2Body = {
    format: "woco.manifest.v2",
    totalSupply: n,
    issuer: ISSUER,
    metadataRoot: root,
    encoding: "cbor-v1",
    treeScheme: "oz-simple-v1",
  };
  return {
    seriesId: "ga",
    totalSupply: n,
    signedManifest: signManifestV2(body, ISSUER_PRIV),
    editionBodies,
  };
}

test("a well-formed series passes", () => {
  assert.doesNotThrow(() => validateSeriesManifest(series()));
});

test("a tampered manifest signature is refused", () => {
  const s = series();
  const tampered = {
    ...s,
    signedManifest: { ...s.signedManifest, signature: `0x${"00".repeat(64)}1b` as `0x${string}` },
  };
  assert.throws(() => validateSeriesManifest(tampered), /manifest signature invalid/);
});

test("a manifest signed by a DIFFERENT key over the same body is refused", () => {
  // `signManifestV2` itself refuses a key that is not the body's issuer, so
  // the forgery has to be assembled by hand: the attacker's valid signature
  // over the true digest. Verification recovers the attacker's address, which
  // is not `body.issuer` — refused.
  const s = series();
  const forged = {
    ...s,
    signedManifest: {
      body: s.signedManifest.body,
      signature: signPersonalMessage(
        buildManifestV2Message(manifestV2Digest(s.signedManifest.body)),
        ATTACKER_PRIV,
      ),
    },
  };
  assert.throws(() => validateSeriesManifest(forged), /manifest signature invalid/);
});

test("edition bodies that do not merkle to the declared metadataRoot are refused", () => {
  const s = series();
  const swapped = bodies(3);
  swapped[1] = { ...swapped[1]!, metadata: { name: "VIP upgrade the manifest never signed" } };
  assert.throws(() => validateSeriesManifest({ ...s, editionBodies: swapped }), /Merkle root mismatch/);
});

test("a body-count/supply mismatch is refused before any crypto", () => {
  const s = series();
  assert.throws(
    () => validateSeriesManifest({ ...s, totalSupply: 4 }),
    /expected 4 edition bodies, got 3/,
  );
});

test("a legacy woco.manifest.v1 payload is REFUSED at dispatch — the v1 cutoff", () => {
  // Hand-built v1 shape; no v1 signing machinery survives to make it "valid",
  // and none is needed: the closed v2 schema refuses the FORMAT before any
  // cryptography runs, so even a correctly ed25519-signed v1 manifest dies here.
  const s = series();
  const v1Shaped = {
    body: {
      format: "woco.manifest.v1",
      eventId: `0x${"11".repeat(32)}`,
      totalSupply: 3,
      issuerPubkey: "ab".repeat(32),
      metadataRoot: s.signedManifest.body.metadataRoot,
      encoding: "cbor-v1",
      treeScheme: "oz-simple-v1",
    },
    signature: "cd".repeat(64),
  };
  assert.throws(
    () =>
      validateSeriesManifest({
        ...s,
        signedManifest: v1Shaped as unknown as ReturnType<typeof series>["signedManifest"],
      }),
    /manifest signature invalid/,
  );
});
