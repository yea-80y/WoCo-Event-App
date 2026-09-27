/**
 * X-Wing primitive, HPKE adapter and sealed box v2 (#642).
 *
 * PROVENANCE — a vector with none is a number someone can "fix":
 *  - `xwing-draft10-vectors.json` is Appendix C of draft-connolly-cfrg-xwing-kem-10,
 *    parsed from the IETF text on 2026-09-27. The draft's authors produced it, not us.
 *  - HPKE_VECTOR was produced by `XWingKem` inside `@hpke/core`'s CipherSuite with a
 *    fixed encapsulation seed, and cross-checked the same day against an independent
 *    implementation (`@hpke/hybridkem-x-wing@0.7.0`, ML-KEM from the `mlkem` package)
 *    in a throwaway: byte-identical `enc` and `ct`, and identical `deriveKeyPair`
 *    output. That library is not a dependency.
 *  - ACCOUNT_KEY's secret half was cross-checked against a by-hand RFC 5869 HKDF
 *    (Python hmac/hashlib).
 *
 * A mismatch here is never a test to update: it means a key or a box format moved.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Aes256Gcm, CipherSuite, HkdfSha256 } from "@hpke/core";
import { XCryptoKey } from "@hpke/common";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  xwing,
  deriveXWingKeypairFromSeed,
  assertXWingPublicKey,
  XWING_ENCRYPTION_INFO,
} from "../../src/crypto/xwing.js";
import { XWingKem } from "../../src/crypto/xwing-hpke.js";
import {
  sealBox,
  openBox,
  sealBoxJson,
  sealBoxJsonCompressed,
  openBoxJson,
  isSealedBoxV2,
  orderSealContext,
  listSealContext,
  UnsupportedSealedBoxError,
  MalformedSealedBoxError,
  ORDER_SEAL_INFO,
  LIST_SEAL_INFO,
} from "../../src/crypto/sealed-box.js";

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const DRAFT = JSON.parse(readFileSync(here("./xwing-draft10-vectors.json"), "utf8")) as {
  vectors: Array<Record<"seed" | "sk" | "pk" | "eseed" | "ct" | "ss", string>>;
};
const h = hexToBytes;
const sha = (b: Uint8Array | ArrayBuffer) => createHash("sha256").update(new Uint8Array(b)).digest("hex");

const EVENT = "00000000-0000-4000-8000-000000000000";
const SERIES = "11111111-1111-4111-8111-111111111111";
const OWNER = "0x" + "ab".repeat(20);

// ---------------------------------------------------------------------------
// The primitive against the draft's own vectors
// ---------------------------------------------------------------------------

test("draft-10 vectors: keygen, derandomized encapsulate and decapsulate all match", () => {
  assert.equal(DRAFT.vectors.length, 3);
  for (const v of DRAFT.vectors) {
    const { secretKey, publicKey } = xwing.keygen(h(v.seed));
    assert.equal(bytesToHex(secretKey), v.sk);
    assert.equal(bytesToHex(publicKey), v.pk);
    const { cipherText, sharedSecret } = xwing.encapsulate(publicKey, h(v.eseed));
    assert.equal(bytesToHex(cipherText), v.ct);
    assert.equal(bytesToHex(sharedSecret), v.ss);
    assert.equal(bytesToHex(xwing.decapsulate(cipherText, secretKey)), v.ss);
  }
});

// ---------------------------------------------------------------------------
// The account key
// ---------------------------------------------------------------------------

/** From the identity-vectors wallet seed, so the chain wallet → seed → X-Wing key is pinned end to end. */
const ACCOUNT_KEY = {
  seed: "0xd5c14311ef004fa8015eb99bb6383e3b394ef7599b320fba05486a08cd04a48e",
  secretKey: "dee16ce5b807b61e0a9a0710c0b812b8756c8bba33503dec22e460a52e5293bd",
  publicKeySha256: "f0b402ca9fa2cc6803ef43d31aaf56ff6cff4c3690ab5a6e4ca0959b22f83b53",
} as const;

test("FROZEN: the X-Wing account-key label and the box contexts, byte for byte", () => {
  assert.equal(XWING_ENCRYPTION_INFO, "woco/encryption/xwing/v1");
  assert.equal(ORDER_SEAL_INFO, "woco/order/v2");
  assert.equal(LIST_SEAL_INFO, "woco/marketing-list/v2");
  assert.deepEqual(orderSealContext(EVENT, SERIES), {
    info: "woco/order/v2",
    aad: `woco/order/v2:${EVENT}:${SERIES}`,
  });
  assert.deepEqual(listSealContext(OWNER.toUpperCase().replace("0X", "0x")), {
    info: "woco/marketing-list/v2",
    aad: `woco/marketing-list/v2:${OWNER}`,
  });
});

test("seed → X-Wing account key pin", () => {
  const kp = deriveXWingKeypairFromSeed(ACCOUNT_KEY.seed);
  assert.equal(bytesToHex(kp.secretKey), ACCOUNT_KEY.secretKey);
  assert.equal(sha(kp.publicKey), ACCOUNT_KEY.publicKeySha256);
  assert.equal(kp.publicKey.length, 1216);
});

test("the account key does NOT come from the adapter's SHAKE-based deriveKeyPair", async () => {
  // Two routes to "the account key" differing by one hash would be a silent key
  // change; there is exactly one, and this pins that the other one differs.
  const kem = new XWingKem();
  const viaAdapter = await kem.deriveKeyPair(h(ACCOUNT_KEY.seed.slice(2)));
  const pk = new Uint8Array(await kem.serializePublicKey(viaAdapter.publicKey));
  assert.notEqual(sha(pk), ACCOUNT_KEY.publicKeySha256);
});

// ---------------------------------------------------------------------------
// The HPKE adapter
// ---------------------------------------------------------------------------

const HPKE_VECTOR = {
  info: "woco/order/v2",
  aad: `woco/order/v2:${EVENT}:${SERIES}`,
  plaintext: '{"test":"xwing-hpke"}',
  ct: "5203bb031020c838f2b9cce777d059c2af41247ab821223d8c57dbea2b0c1cec7e84437e89",
  /** deriveKeyPair(0x09 × 32) public key, SHA-256 — matched the independent library. */
  deriveKeyPairPkSha256: "db6a9f2451bf1019f5a95609b2701dcbdd99b282de368b28c149c843e9231587",
} as const;

const suite = new CipherSuite({ kem: new XWingKem(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
const te = new TextEncoder();

test("HPKE vector: fixed recipient + fixed eseed → pinned enc (the draft's ct) and ct", async () => {
  const v = DRAFT.vectors[0];
  const pk = await suite.kem.deserializePublicKey(h(v.pk));
  const sk = await suite.kem.deserializePrivateKey(h(v.sk));
  const info = te.encode(HPKE_VECTOR.info);
  const aad = te.encode(HPKE_VECTOR.aad);
  const { enc, ct } = await suite.seal(
    { recipientPublicKey: pk, info, ekm: h(v.eseed) },
    te.encode(HPKE_VECTOR.plaintext),
    aad,
  );
  assert.equal(bytesToHex(new Uint8Array(enc)), v.ct, "HPKE enc is the X-Wing ciphertext");
  assert.equal(bytesToHex(new Uint8Array(ct)), HPKE_VECTOR.ct);
  const pt = await suite.open({ recipientKey: sk, enc, info }, ct, aad);
  assert.equal(new TextDecoder().decode(pt), HPKE_VECTOR.plaintext);
});

test("adapter deriveKeyPair is the draft's SHAKE256(ikm) route", async () => {
  const kem = new XWingKem();
  const kp = await kem.deriveKeyPair(new Uint8Array(32).fill(9));
  assert.equal(sha(await kem.serializePublicKey(kp.publicKey)), HPKE_VECTOR.deriveKeyPairPkSha256);
  assert.equal((await kem.serializePrivateKey(kp.privateKey)).byteLength, 32);
});

test("adapter sizes and id are the draft's", () => {
  const kem = new XWingKem();
  assert.equal(kem.id, 0x647a);
  assert.deepEqual(
    [kem.secretSize, kem.encSize, kem.publicKeySize, kem.privateKeySize],
    [32, 1120, 1216, 32],
  );
});

test("adapter refuses what X-Wing does not do", async () => {
  const kem = new XWingKem();
  const kp = await kem.generateKeyPair();
  await assert.rejects(
    kem.encap({ recipientPublicKey: kp.publicKey, senderKey: kp.privateKey }),
    /authenticated mode/,
  );
  await assert.rejects(kem.encap({ recipientPublicKey: kp.publicKey, ekm: new Uint8Array(32) }), /64 bytes/);
  await assert.rejects(kem.importKey("jwk", {} as JsonWebKey), /raw bytes only/);
  await assert.rejects(kem.decap({ recipientKey: kp.privateKey, enc: new Uint8Array(1119) }), /1120 bytes/);
  // A key from another algorithm is refused, never reinterpreted.
  const foreign = new XCryptoKey("X25519", new Uint8Array(1216), "public");
  await assert.rejects(kem.encap({ recipientPublicKey: foreign }));
});

// ---------------------------------------------------------------------------
// Sealed box v2
// ---------------------------------------------------------------------------

const ACCOUNT = deriveXWingKeypairFromSeed(ACCOUNT_KEY.seed);
const ORDER_CTX = orderSealContext(EVENT, SERIES);

test("box round-trips, as bytes and as JSON (plain and gzipped)", async () => {
  const box = await sealBox(ACCOUNT.publicKey, te.encode("hello"), ORDER_CTX);
  assert.ok(isSealedBoxV2(box));
  assert.deepEqual(Object.keys(box).sort(), ["ct", "enc", "v"], "no algorithm fields in the box");
  assert.equal(new TextDecoder().decode(await openBox(ACCOUNT.secretKey, box, ORDER_CTX)), "hello");

  const data = { name: "Ada", email: "ada@example.com", n: [1, 2, 3] };
  assert.deepEqual(await openBoxJson(ACCOUNT.secretKey, await sealBoxJson(ACCOUNT.publicKey, data, ORDER_CTX), ORDER_CTX), data);
  const list = listSealContext(OWNER);
  const big = { contacts: Array.from({ length: 200 }, (_, i) => `person${i}@example.com`) };
  const gz = await sealBoxJsonCompressed(bytesToHex(ACCOUNT.publicKey), big, list);
  assert.deepEqual(await openBoxJson(bytesToHex(ACCOUNT.secretKey), gz, list), big);
});

test("every seal is fresh: the same input never yields the same box", async () => {
  const a = await sealBox(ACCOUNT.publicKey, te.encode("x"), ORDER_CTX);
  const b = await sealBox(ACCOUNT.publicKey, te.encode("x"), ORDER_CTX);
  assert.notEqual(a.enc, b.enc);
});

test("a box lifted into any other context fails: event, series, owner, or use", async () => {
  const box = await sealBoxJson(ACCOUNT.publicKey, { a: 1 }, ORDER_CTX);
  for (const other of [
    orderSealContext("22222222-2222-4222-8222-222222222222", SERIES),
    orderSealContext(EVENT, "33333333-3333-4333-8333-333333333333"),
    { info: LIST_SEAL_INFO, aad: ORDER_CTX.aad },
    listSealContext(OWNER),
  ]) {
    await assert.rejects(openBoxJson(ACCOUNT.secretKey, box, other));
  }
});

test("the wrong key fails, and a tampered box fails", async () => {
  const box = await sealBox(ACCOUNT.publicKey, te.encode("secret"), ORDER_CTX);
  const other = deriveXWingKeypairFromSeed("0x" + "11".repeat(32));
  await assert.rejects(openBox(other.secretKey, box, ORDER_CTX));
  const flip = (s: string) => (s[0] === "0" ? "1" : "0") + s.slice(1);
  await assert.rejects(openBox(ACCOUNT.secretKey, { ...box, ct: flip(box.ct) }, ORDER_CTX));
  await assert.rejects(openBox(ACCOUNT.secretKey, { ...box, enc: flip(box.enc) }, ORDER_CTX));
});

test("open refuses every box that is not v2 — including the retired X25519 shape", async () => {
  const box = await sealBox(ACCOUNT.publicKey, te.encode("x"), ORDER_CTX);
  const retired = { ephemeralPublicKey: "ab".repeat(32), iv: "00".repeat(12), ciphertext: "00".repeat(32) };
  for (const bad of [retired, { ...box, v: 1 }, { ...box, v: 3 }, null, "box"]) {
    await assert.rejects(openBox(ACCOUNT.secretKey, bad, ORDER_CTX), UnsupportedSealedBoxError);
  }
});

test("a v2 box with broken fields is MALFORMED, never mistaken for an old format", async () => {
  const box = await sealBox(ACCOUNT.publicKey, te.encode("x"), ORDER_CTX);
  for (const bad of [
    { ...box, enc: box.enc.slice(2) },
    { ...box, ct: box.ct.toUpperCase() },
    { ...box, ct: "" },
  ]) {
    await assert.rejects(openBox(ACCOUNT.secretKey, bad, ORDER_CTX), MalformedSealedBoxError);
  }
});

test("the shape check takes EXACTLY {v, enc, ct} — nothing may ride beside a box", async () => {
  const box = await sealBox(ACCOUNT.publicKey, te.encode("x"), ORDER_CTX);
  assert.ok(isSealedBoxV2(box));
  assert.equal(isSealedBoxV2({ ...box, email: "ada@example.com" }), false);
  assert.equal(isSealedBoxV2([box.v, box.enc, box.ct]), false);
  await assert.rejects(openBox(ACCOUNT.secretKey, { ...box, note: "x" }, ORDER_CTX), MalformedSealedBoxError);
});

test("seal refuses a public key that is not X-Wing: wrong length, or failing the ML-KEM modulus check", async () => {
  await assert.rejects(sealBox(new Uint8Array(32), te.encode("x"), ORDER_CTX), /1216 bytes/);
  assert.throws(() => assertXWingPublicKey(new Uint8Array(1215)), /1216 bytes/);
  const bad = ACCOUNT.publicKey.slice();
  bad[0] = 0xff;
  bad[1] = 0xff; // first 12-bit coefficient = 0xfff ≥ q
  await assert.rejects(sealBox(bad, te.encode("x"), ORDER_CTX));
});

test("contexts refuse ids and owners that could make a binding ambiguous", () => {
  assert.throws(() => orderSealContext("a:b", SERIES));
  assert.throws(() => orderSealContext("ABCDEF00-0000-4000-8000-000000000000", SERIES));
  assert.throws(() => orderSealContext("", SERIES));
  assert.throws(() => listSealContext("0x1234"));
});

// ---------------------------------------------------------------------------
// Modularity: the lattice code never rides the shared barrel
// ---------------------------------------------------------------------------

test("the shape module is dependency-free, and its enc length is X-Wing's", async () => {
  const shape = readFileSync(here("../../src/crypto/sealed-box-shape.ts"), "utf8");
  assert.doesNotMatch(shape, /^\s*import\s/m, "the server's sniffers must not load crypto to check a shape");
  const { SEALED_BOX_ENC_BYTES } = await import("../../src/crypto/sealed-box-shape.js");
  const { XWING_CIPHERTEXT_BYTES } = await import("../../src/crypto/xwing.js");
  assert.equal(SEALED_BOX_ENC_BYTES, XWING_CIPHERTEXT_BYTES);
});

test("the X-Wing modules are subpath-only — the @woco/shared barrel never pulls them in", () => {
  const barrel = readFileSync(here("../../src/crypto/index.ts"), "utf8");
  assert.doesNotMatch(barrel, /xwing|sealed-box/);  // incl. sealed-box-shape: subpath only
  const root = readFileSync(here("../../src/index.ts"), "utf8");
  assert.doesNotMatch(root, /xwing|sealed-box/);
});
