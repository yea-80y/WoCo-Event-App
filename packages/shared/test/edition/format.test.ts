/**
 * `woco.manifest.v2` / `woco.edition.v1` format tests (PR 3).
 *
 * The golden vectors pin the digest, the leaf recipe, the 83-byte signing
 * message and the deterministic (RFC 6979) signature to fixed bytes. Do NOT
 * paste new values on a mismatch — a moved vector means every v2 manifest and
 * on-chain `manifestRef` just changed meaning.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { deriveIssuingKey } from "../../src/crypto/issuing.js";
import { asIssuerAddress } from "../../src/crypto/brands.js";
import {
  buildManifestV2Message,
  canonicalEncodeEdition,
  editionLeafHash,
  manifestV2Digest,
} from "../../src/edition/canonical.js";
import {
  validateEditionV1Body,
  validateManifestV2Body,
  validateSignedManifestV2,
  type EditionV1Body,
  type ManifestV2Body,
} from "../../src/edition/types.js";
import { signManifestV2, verifyManifestV2 } from "../../src/edition/merkle.js";
import { signManifest } from "../../src/pod/merkle.js";
import type { ManifestV1Body } from "../../src/pod/types.js";

const SEED = "0x" + "ab".repeat(32);
const { privateKey: ISSUING_PRIV, address: ISSUER } = deriveIssuingKey(SEED, 0);

const manifestBody = (): ManifestV2Body => ({
  format: "woco.manifest.v2",
  totalSupply: 3,
  issuer: ISSUER,
  metadataRoot: ("0x" + "11".repeat(32)) as ManifestV2Body["metadataRoot"],
  encoding: "cbor-v1",
  treeScheme: "oz-simple-v1",
});

const editionBody = (): EditionV1Body => ({
  format: "woco.edition.v1",
  seriesId: "series-golden",
  edition: 2,
  metadata: { name: "Golden", n: 7 },
  issuer: ISSUER,
});

// --- golden vectors ---------------------------------------------------------

test("golden: manifest digest, message and deterministic signature are pinned", () => {
  const digest = manifestV2Digest(manifestBody());
  assert.equal(
    bytesToHex(digest),
    "c9f14ec2d65a7a654feec131736bbfdf8f934184a1dc9fa974b295dddc010998",
    "manifest digest moved — encoder or body canonicalisation changed",
  );
  const message = buildManifestV2Message(digest);
  assert.equal(message.length, 83, "the signing message must be exactly 83 ASCII bytes");
  assert.equal(
    message,
    "woco-manifest-v2\n0xc9f14ec2d65a7a654feec131736bbfdf8f934184a1dc9fa974b295dddc010998",
  );
  const signed = signManifestV2(manifestBody(), ISSUING_PRIV);
  assert.equal(
    signed.signature,
    "0x073ba08808c05a8e0baad751b03b518f9156147988c3e594e82cd6131a7149aa536b4d6dd06b4afd14e996fce475d186d4628d2e3533fc2f5703be03961217821b",
    "signature moved — RFC 6979 signing or the message recipe changed",
  );
});

test("golden: edition leaf recipe is pinned (0x00 || u32be(edition) || dagCbor)", () => {
  assert.equal(
    bytesToHex(editionLeafHash(editionBody())),
    "b559024840988ac37e0d4fc0104e13b83d7578aad1b91469361ffc977e9f0f9f",
    "leaf recipe moved — domain byte, edition prefix or encoder changed",
  );
});

test("edition encoding is key-order independent (canonical CBOR)", () => {
  const reordered = {
    issuer: ISSUER,
    metadata: { n: 7, name: "Golden" },
    edition: 2,
    seriesId: "series-golden",
    format: "woco.edition.v1",
  } as EditionV1Body;
  assert.equal(bytesToHex(canonicalEncodeEdition(reordered)), bytesToHex(canonicalEncodeEdition(editionBody())));
});

// --- sign / verify ----------------------------------------------------------

test("sign → verify round-trips; tampering any body field fails", () => {
  const signed = signManifestV2(manifestBody(), ISSUING_PRIV);
  assert.ok(verifyManifestV2(signed));
  assert.ok(!verifyManifestV2({ ...signed, body: { ...signed.body, totalSupply: 4 } }));
  assert.ok(
    !verifyManifestV2({
      ...signed,
      body: { ...signed.body, metadataRoot: "0x" + "22".repeat(32) },
    }),
  );
});

test("signManifestV2 refuses a key that is not body.issuer", () => {
  const otherKey = deriveIssuingKey(SEED, 1).privateKey;
  assert.throws(() => signManifestV2(manifestBody(), otherKey), /issuing key mismatch/);
});

test("a signature by a different issuing generation does not verify", () => {
  const gen1 = deriveIssuingKey(SEED, 1);
  const body = { ...manifestBody(), issuer: gen1.address };
  const signed = signManifestV2(body, gen1.privateKey);
  assert.ok(verifyManifestV2(signed));
  // swap the claimed issuer back to gen 0: recovery no longer matches
  assert.ok(!verifyManifestV2({ ...signed, body: { ...body, issuer: ISSUER } }));
});

test("verifyManifestV2 REFUSES a valid v1 manifest at dispatch", () => {
  const edPriv = new Uint8Array(32).fill(5);
  const edPub = bytesToHex(ed25519.getPublicKey(edPriv));
  const v1Body: ManifestV1Body = {
    format: "woco.manifest.v1",
    eventId: "0x" + "00".repeat(32),
    totalSupply: 3,
    issuerPubkey: edPub,
    metadataRoot: "0x" + "11".repeat(32),
    encoding: "cbor-v1",
    treeScheme: "oz-simple-v1",
  };
  const signedV1 = signManifest(v1Body, edPriv);
  assert.ok(
    !verifyManifestV2(signedV1 as unknown),
    "a woco.manifest.v1 envelope verified as v2 — the format dispatch refusal is gone",
  );
});

test("a malleated high-s manifest signature is refused", async () => {
  const { secp256k1 } = await import("@noble/curves/secp256k1.js");
  const N = secp256k1.Point.Fn.ORDER;
  const signed = signManifestV2(manifestBody(), ISSUING_PRIV);
  const raw = hexToBytes(signed.signature.slice(2));
  const s = BigInt("0x" + bytesToHex(raw.subarray(32, 64)));
  const malleated = ("0x" +
    bytesToHex(raw.subarray(0, 32)) +
    (N - s).toString(16).padStart(64, "0") +
    (raw[64] === 27 ? "1c" : "1b")) as typeof signed.signature;
  assert.ok(!verifyManifestV2({ ...signed, signature: malleated }));
});

// --- closed-schema refusals --------------------------------------------------

test("manifest schema refuses non-canonical and extra input", () => {
  const ok = manifestBody();
  assert.ok(validateManifestV2Body(ok));
  assert.ok(!validateManifestV2Body({ ...ok, extra: 1 }), "unknown key accepted");
  assert.ok(!validateManifestV2Body({ ...ok, issuer: ISSUER.toUpperCase() }), "uppercase issuer accepted");
  assert.ok(!validateManifestV2Body({ ...ok, issuer: ISSUER.slice(2) }), "0x-less issuer accepted");
  assert.ok(!validateManifestV2Body({ ...ok, metadataRoot: "0x" + "AA".repeat(32) }), "uppercase root accepted");
  assert.ok(!validateManifestV2Body({ ...ok, totalSupply: 0 }));
  assert.ok(!validateManifestV2Body({ ...ok, totalSupply: 1.5 }));
  assert.ok(!validateManifestV2Body({ ...ok, format: "woco.manifest.v1" }), "v1 format accepted");
  assert.ok(!validateManifestV2Body({ ...ok, editionTemplate: { bad: 0.5 } }), "float template accepted");
  assert.ok(!validateManifestV2Body({ ...ok, editionTemplate: null }), "null template accepted");
  const { editionTemplate: _t, ...rest } = { ...ok, editionTemplate: { name: "x" } };
  assert.ok(validateManifestV2Body({ ...rest, editionTemplate: { name: "x" } }));
});

test("edition schema refuses non-canonical and extra input", () => {
  const ok = editionBody();
  assert.ok(validateEditionV1Body(ok));
  assert.ok(!validateEditionV1Body({ ...ok, eventId: "0x" + "00".repeat(32) }), "#443: eventId must be refused, not ignored");
  assert.ok(!validateEditionV1Body({ ...ok, format: "woco.ticket.v2" }), "v1 ticket format accepted");
  assert.ok(!validateEditionV1Body({ ...ok, edition: 0 }));
  assert.ok(!validateEditionV1Body({ ...ok, edition: 2 ** 32 }));
  assert.ok(!validateEditionV1Body({ ...ok, seriesId: "" }));
  assert.ok(!validateEditionV1Body({ ...ok, metadata: { bad: Number.NaN } }));
  assert.ok(!validateEditionV1Body({ ...ok, metadata: { bad: null } }));
  assert.ok(!validateEditionV1Body({ ...ok, issuer: ISSUER.slice(2) }));
});

test("signed-envelope schema refuses malformed signatures", () => {
  const signed = signManifestV2(manifestBody(), ISSUING_PRIV);
  assert.ok(validateSignedManifestV2(signed));
  assert.ok(!validateSignedManifestV2({ ...signed, signature: signed.signature.slice(2) }));
  assert.ok(!validateSignedManifestV2({ ...signed, signature: signed.signature.slice(0, -2) }));
  assert.ok(!validateSignedManifestV2({ ...signed, extra: true }));
});

test("digest/message builders throw on invalid input (no digest of the unvalidated)", () => {
  assert.throws(() => manifestV2Digest({ ...manifestBody(), totalSupply: 0 }));
  assert.throws(() => buildManifestV2Message(new Uint8Array(31)), /32 bytes/);
});

test("issuer address round-trips the brand boundary", () => {
  assert.equal(asIssuerAddress(ISSUER), ISSUER);
});

test("encoder pin: -0 in metadata encodes as integer 0 (JSON hop cannot move a digest)", async () => {
  // JSON round-trips -0 to +0, and -0 passes the safe-integer gate — so the
  // digest is only stable because @ipld/dag-cbor normalises -0 to the integer
  // encoding. Pinned here so an encoder bump that changes that fails loudly
  // instead of silently re-keying every signed manifest.
  const dagCbor = await import("@ipld/dag-cbor");
  assert.deepEqual(dagCbor.encode({ x: -0 }), dagCbor.encode({ x: 0 }));
});
