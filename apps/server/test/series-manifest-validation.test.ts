/**
 * validateSeriesManifest — the TICKET rail's only manifest-signature check
 * (PR 1, #444 audit).
 *
 * The charge-time binding (onchain-binding.ts) compares DIGESTS, deliberately
 * not signatures: an attacker pointing a series at a victim's public blob is
 * caught by the digest anchor, and the signature check would not help there.
 * Which means the signature is verified exactly once on this rail — at the
 * write boundary, by this function. Until this file that check had no test:
 * only the certificate rail's twin (issuance.ts, pod-cert-mint.test.ts) did.
 *
 * ("POD" survives here only inside existing identifiers — the vocabulary
 * itself is being retired with the curve migration's format bump.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  signManifest,
  buildPodTree,
  type ManifestV1Body,
  type PodV2Body,
} from "@woco/shared";
import { validateSeriesManifest } from "../src/lib/event/service.js";

// Fixed keys; pubkeys precomputed (the server workspace resolves the hoisted
// @noble/curves v1, whose exports lack the ./ed25519.js subpath — all actual
// signing goes through shared's signManifest, which uses shared's own noble v2).
const ISSUER_PRIV = new Uint8Array(32).fill(7);
const ISSUER = "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c";
const ATTACKER_PRIV = new Uint8Array(32).fill(11);
const EVENT_ID = `0x${"11".repeat(32)}`;

function bodies(n: number): PodV2Body[] {
  return Array.from({ length: n }, (_, i) => ({
    format: "woco.ticket.v2",
    eventId: EVENT_ID,
    seriesId: "ga",
    edition: i + 1,
    metadata: { name: "GA" },
    issuer: ISSUER,
  }));
}

function series(n = 3) {
  const podBodies = bodies(n);
  const { root } = buildPodTree(podBodies);
  const body: ManifestV1Body = {
    format: "woco.manifest.v1",
    eventId: EVENT_ID,
    totalSupply: n,
    issuerPubkey: ISSUER,
    metadataRoot: root,
    encoding: "cbor-v1",
    treeScheme: "oz-simple-v1",
  };
  return {
    seriesId: "ga",
    totalSupply: n,
    signedManifest: signManifest(body, ISSUER_PRIV),
    podBodies,
  };
}

test("a well-formed series passes", () => {
  assert.doesNotThrow(() => validateSeriesManifest(series()));
});

test("a tampered manifest signature is refused", () => {
  const s = series();
  const tampered = { ...s, signedManifest: { ...s.signedManifest, signature: "0".repeat(128) } };
  assert.throws(() => validateSeriesManifest(tampered), /manifest signature invalid/);
});

test("a manifest signed by a DIFFERENT key over the same body is refused", () => {
  const s = series();
  const wrongKey = signManifest(s.signedManifest.body, ATTACKER_PRIV);
  // wrongKey's signature is valid for the attacker's key — but the body names
  // ISSUER as issuerPubkey, so verification must refuse it.
  assert.throws(
    () => validateSeriesManifest({ ...s, signedManifest: wrongKey }),
    /manifest signature invalid/,
  );
});

test("pod bodies that do not merkle to the declared metadataRoot are refused", () => {
  const s = series();
  const swapped = bodies(3);
  swapped[1] = { ...swapped[1]!, metadata: { name: "VIP upgrade the manifest never signed" } };
  assert.throws(() => validateSeriesManifest({ ...s, podBodies: swapped }), /Merkle root mismatch/);
});

test("a body-count/supply mismatch is refused before any crypto", () => {
  const s = series();
  assert.throws(
    () => validateSeriesManifest({ ...s, totalSupply: 4 }),
    /expected 4 pod bodies, got 3/,
  );
});
