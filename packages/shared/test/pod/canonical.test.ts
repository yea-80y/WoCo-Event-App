/**
 * Test vectors for the locked POD/manifest cryptographic spec.
 *
 * Run with: npm test --workspace @woco/shared
 *
 * These vectors document and pin the byte-level behaviour of:
 *  - DAG-CBOR canonical encoding (deterministic regardless of key order)
 *  - Leaf hash format (domain prefix + edition binding)
 *  - Manifest digest (signed payload === chain manifestRef)
 *
 * Do NOT update fixture hex strings without a format version bump.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";
import {
  LEAF_DOMAIN,
  bytesToHex0x,
  canonicalEncodePod,
  canonicalEncodeManifest,
  hex0xToBytes,
  manifestDigest,
  podLeafHash,
  u32be,
} from "../../src/pod/canonical.js";
import type { ManifestV1Body, PodV2Body } from "../../src/pod/types.js";

const ZERO_EVENT_ID =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
const ZERO_ROOT =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
const ZERO_PUBKEY = "00".repeat(32);

function makePod(edition: number, overrides: Partial<PodV2Body> = {}): PodV2Body {
  return {
    format: "woco.ticket.v2",
    eventId: ZERO_EVENT_ID,
    seriesId: "series-a",
    edition,
    metadata: { name: "General Admission", image: "ref:abc" },
    issuer: ZERO_PUBKEY,
    ...overrides,
  };
}

function makeManifest(overrides: Partial<ManifestV1Body> = {}): ManifestV1Body {
  return {
    format: "woco.manifest.v1",
    eventId: ZERO_EVENT_ID,
    totalSupply: 1,
    issuerPubkey: ZERO_PUBKEY,
    metadataRoot: ZERO_ROOT,
    encoding: "cbor-v1",
    treeScheme: "oz-simple-v1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// u32be — fixed test vectors
// ---------------------------------------------------------------------------

test("u32be: 0", () => {
  assert.equal(bytesToHex0x(u32be(0)), "0x00000000");
});

test("u32be: 1", () => {
  assert.equal(bytesToHex0x(u32be(1)), "0x00000001");
});

test("u32be: 0x12345678", () => {
  assert.equal(bytesToHex0x(u32be(0x12345678)), "0x12345678");
});

test("u32be: max u32", () => {
  assert.equal(bytesToHex0x(u32be(0xffffffff)), "0xffffffff");
});

test("u32be: rejects negative", () => {
  assert.throws(() => u32be(-1), RangeError);
});

test("u32be: rejects > 2^32-1", () => {
  assert.throws(() => u32be(0x100000000), RangeError);
});

test("u32be: rejects non-integer", () => {
  assert.throws(() => u32be(1.5), RangeError);
});

// ---------------------------------------------------------------------------
// DAG-CBOR determinism — same content, different key order, identical bytes
// ---------------------------------------------------------------------------

test("dagCbor: identical PODs encode to identical bytes", () => {
  const a = makePod(1);
  const b = makePod(1);
  assert.deepEqual(canonicalEncodePod(a), canonicalEncodePod(b));
});

test("dagCbor: PODs assembled with different key insertion order are byte-identical", () => {
  // dag-cbor sorts map keys by their CBOR-encoded form, so JS insertion order
  // doesn't leak into the encoding.
  const a: PodV2Body = {
    format: "woco.ticket.v2",
    eventId: ZERO_EVENT_ID,
    seriesId: "s",
    edition: 1,
    metadata: { name: "X", image: "y" },
    issuer: ZERO_PUBKEY,
  };
  const b: PodV2Body = {
    issuer: ZERO_PUBKEY,
    metadata: { image: "y", name: "X" },
    edition: 1,
    seriesId: "s",
    eventId: ZERO_EVENT_ID,
    format: "woco.ticket.v2",
  };
  assert.deepEqual(canonicalEncodePod(a), canonicalEncodePod(b));
});

test("dagCbor: nested object key order does not affect encoding", () => {
  const a = makePod(1, { metadata: { a: 1, b: 2, c: { x: 1, y: 2 } } });
  const b = makePod(1, { metadata: { c: { y: 2, x: 1 }, b: 2, a: 1 } });
  assert.deepEqual(canonicalEncodePod(a), canonicalEncodePod(b));
});

// ---------------------------------------------------------------------------
// Leaf hash format — edition-swap rejection, tampered body rejection
// ---------------------------------------------------------------------------

test("leaf: domain separator is 0x00", () => {
  // We can't observe the raw input bytes from the library, but we can
  // recompute the digest manually and compare. This pins LEAF_DOMAIN.
  assert.equal(LEAF_DOMAIN, 0x00);
});

test("leaf: same body, different edition → different leaf (edition-swap defence)", () => {
  // Two PODs that share metadata but differ only in edition number must
  // have distinct leaf hashes. Edition is bound into the leaf bytes.
  const podA = makePod(1);
  const podB = makePod(2);
  const leafA = bytesToHex0x(podLeafHash(podA));
  const leafB = bytesToHex0x(podLeafHash(podB));
  assert.notEqual(leafA, leafB);
});

test("leaf: tampered metadata → different leaf", () => {
  const original = makePod(1);
  const tampered = makePod(1, { metadata: { name: "Different", image: "ref:abc" } });
  assert.notEqual(
    bytesToHex0x(podLeafHash(original)),
    bytesToHex0x(podLeafHash(tampered)),
  );
});

test("leaf: identical PODs → identical leaf", () => {
  const a = makePod(42);
  const b = makePod(42);
  assert.equal(bytesToHex0x(podLeafHash(a)), bytesToHex0x(podLeafHash(b)));
});

test("leaf: 32 bytes output", () => {
  const leaf = podLeafHash(makePod(1));
  assert.equal(leaf.length, 32);
});

// ---------------------------------------------------------------------------
// Manifest digest — sig payload === chain manifestRef
// ---------------------------------------------------------------------------

test("manifest digest: 32 bytes", () => {
  const d = manifestDigest(makeManifest());
  assert.equal(d.length, 32);
});

test("manifest digest: tampered field → different digest", () => {
  const a = makeManifest({ totalSupply: 100 });
  const b = makeManifest({ totalSupply: 101 });
  assert.notEqual(bytesToHex0x(manifestDigest(a)), bytesToHex0x(manifestDigest(b)));
});

test("manifest digest: tampered metadataRoot → different digest", () => {
  const root1 =
    "0x1111111111111111111111111111111111111111111111111111111111111111";
  const root2 =
    "0x2222222222222222222222222222222222222222222222222222222222222222";
  assert.notEqual(
    bytesToHex0x(manifestDigest(makeManifest({ metadataRoot: root1 }))),
    bytesToHex0x(manifestDigest(makeManifest({ metadataRoot: root2 }))),
  );
});

test("manifest digest: key order doesn't affect digest", () => {
  const a: ManifestV1Body = {
    format: "woco.manifest.v1",
    eventId: ZERO_EVENT_ID,
    totalSupply: 5,
    issuerPubkey: ZERO_PUBKEY,
    metadataRoot: ZERO_ROOT,
    encoding: "cbor-v1",
    treeScheme: "oz-simple-v1",
  };
  const b: ManifestV1Body = {
    treeScheme: "oz-simple-v1",
    encoding: "cbor-v1",
    metadataRoot: ZERO_ROOT,
    issuerPubkey: ZERO_PUBKEY,
    totalSupply: 5,
    eventId: ZERO_EVENT_ID,
    format: "woco.manifest.v1",
  };
  assert.equal(bytesToHex0x(manifestDigest(a)), bytesToHex0x(manifestDigest(b)));
});

// ---------------------------------------------------------------------------
// Hex round-trip
// ---------------------------------------------------------------------------

test("hex: round-trip random 32 bytes", () => {
  const bytes = ed25519.utils.randomPrivateKey();
  const hex = bytesToHex0x(bytes);
  assert.equal(hex.length, 2 + 64);
  const back = hex0xToBytes(hex);
  assert.deepEqual(back, bytes);
});

test("hex: rejects odd-length input", () => {
  assert.throws(() => hex0xToBytes("0x123"));
});

test("hex: accepts upper-case 0X prefix", () => {
  assert.deepEqual(hex0xToBytes("0XAA"), new Uint8Array([0xaa]));
});

// ---------------------------------------------------------------------------
// Pinned byte-level fixtures — these are the reference vectors. If any of
// these change without a format version bump, every previously-issued POD
// becomes unverifiable.
// ---------------------------------------------------------------------------

test("FIXTURE: leaf hash for canonical reference POD (edition 1)", () => {
  const pod = makePod(1);
  const leaf = bytesToHex0x(podLeafHash(pod));
  // This value pins together: dag-cbor encoding, leaf domain byte, u32be
  // edition, and keccak256. ANY change that perturbs the bytes will fail.
  assert.equal(leaf.length, 66);
  // The reference fixture itself (regenerate carefully — this is the spec):
  assert.equal(
    leaf,
    "0x85365923a81bb5f92093cab762d0ae61a09fbac14d2e871fbf8a8fbd7dd1df04",
  );
});

test("FIXTURE: leaf hash for canonical reference POD (edition 2)", () => {
  const pod = makePod(2);
  const leaf = bytesToHex0x(podLeafHash(pod));
  assert.equal(leaf.length, 66);
  assert.equal(
    leaf,
    "0x3edb5dfc0daa3b4dbb95f2840107e9502d99077c42784740c28fff525a81bdd0",
  );
});

test("FIXTURE: manifest digest for canonical reference manifest", () => {
  const manifest = makeManifest({ totalSupply: 1 });
  const digest = bytesToHex0x(manifestDigest(manifest));
  assert.equal(digest.length, 66);
  assert.equal(
    digest,
    "0xe63cebcbfb3c4705b57b9a2d5a0032981a7ba9413fe01e6c0f27d16421700b99",
  );
});
