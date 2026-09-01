/**
 * Issuing-key derivation + personal-sign wrapper (issuer-curve migration PR 3).
 *
 * The GOLDEN VECTORS here are pinned bytes, not derive-and-compare — a runtime
 * re-derivation executes the same function on both sides and passes even when
 * the derivation moves. Do NOT "fix" a golden failure by pasting new values:
 * a mismatch means every organiser's issuing identity just changed (pre-launch
 * that is a purge + re-publish, and it must never happen by accident).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  ISSUING_INFO_PREFIX,
  deriveIssuingKey,
  issuingAddress,
  issuingScalarFromOkm,
  personalSignDigest,
  recoverPersonalSigner,
  signPersonalMessage,
} from "../../src/crypto/issuing.js";
import { deriveEncryptionKeypairFromPodSeed } from "../../src/crypto/keys.js";

const SEED = "0x" + "ab".repeat(32);
const N = secp256k1.Point.Fn.ORDER;

// --- golden vectors ---------------------------------------------------------

test("golden: fixed seed → pinned gen-0 private key and address", () => {
  const { privateKey, address } = deriveIssuingKey(SEED, 0);
  assert.equal(
    bytesToHex(privateKey),
    "3173caaf0c2cbd47ffbd78987a6740e74e02fabf817b71cbf063ff7f2b5e3947",
    "gen-0 issuing PRIVATE KEY moved — HKDF info/salt/expansion or the scalar map changed",
  );
  assert.equal(
    address,
    "0xa084727cc047f96ffb64e495321f2a829d1e276f",
    "gen-0 issuing ADDRESS moved",
  );
});

test("golden: gen 1 derives a different, pinned address", () => {
  const { address } = deriveIssuingKey(SEED, 1);
  assert.equal(address, "0x20fc82df311d3f65dab6c623095f006c69accef5");
  assert.notEqual(address, deriveIssuingKey(SEED, 0).address);
});

test("the HKDF info prefix literal is frozen", () => {
  assert.equal(ISSUING_INFO_PREFIX, "woco/issuing/v1/");
});

// --- derivation properties --------------------------------------------------

test("derivation is deterministic and 0x-prefix-insensitive", () => {
  const a = deriveIssuingKey(SEED, 0);
  const b = deriveIssuingKey(SEED.slice(2), 0);
  assert.equal(bytesToHex(a.privateKey), bytesToHex(b.privateKey));
  assert.equal(a.address, b.address);
});

test("issuing key is independent of the X25519 encryption sibling", () => {
  const issuing = deriveIssuingKey(SEED, 0);
  const enc = deriveEncryptionKeypairFromPodSeed(SEED);
  assert.notEqual(bytesToHex(issuing.privateKey), bytesToHex(enc.privateKey));
});

test("malformed seed and generation are refused loudly", () => {
  assert.throws(() => deriveIssuingKey("0x1234", 0), /expected 32 bytes/);
  assert.throws(() => deriveIssuingKey("zz".repeat(32), 0), /hex/i);
  assert.throws(() => deriveIssuingKey(SEED, -1), /generation/);
  assert.throws(() => deriveIssuingKey(SEED, 1.5), /generation/);
});

test("scalar map: 48-byte OKM → [1, n-1], deterministically, never zero", () => {
  assert.equal(issuingScalarFromOkm(new Uint8Array(48)), 1n, "all-zero OKM must map to 1");
  const max = issuingScalarFromOkm(new Uint8Array(48).fill(0xff));
  assert.ok(max >= 1n && max < N, "max OKM must stay inside [1, n-1]");
  assert.throws(() => issuingScalarFromOkm(new Uint8Array(32)), /48 bytes/);
});

// --- personal-sign wrapper ---------------------------------------------------

test("sign → recover round-trips to the issuing address", () => {
  const { privateKey, address } = deriveIssuingKey(SEED, 0);
  const sig = signPersonalMessage("woco-manifest-v2\n0x" + "00".repeat(32), privateKey);
  assert.match(sig, /^0x[0-9a-f]{130}$/);
  assert.equal(recoverPersonalSigner("woco-manifest-v2\n0x" + "00".repeat(32), sig), address);
});

test("recovery binds to the exact message", () => {
  const { privateKey, address } = deriveIssuingKey(SEED, 0);
  const sig = signPersonalMessage("message-a", privateKey);
  assert.notEqual(recoverPersonalSigner("message-b", sig), address);
});

test("malformed signatures are refused, never thrown on", () => {
  assert.equal(recoverPersonalSigner("m", null), null);
  assert.equal(recoverPersonalSigner("m", "0x1234"), null);
  assert.equal(recoverPersonalSigner("m", "ab".repeat(65)), null, "unprefixed hex refused");
  const { privateKey } = deriveIssuingKey(SEED, 0);
  const sig = signPersonalMessage("m", privateKey);
  // v byte outside {27, 28}
  assert.equal(recoverPersonalSigner("m", sig.slice(0, -2) + "1d"), null);
});

test("a malleated high-s signature is refused (nothing may key off sig bytes)", () => {
  const { privateKey, address } = deriveIssuingKey(SEED, 0);
  const sig = signPersonalMessage("m", privateKey);
  const raw = hexToBytes(sig.slice(2));
  const s = BigInt("0x" + bytesToHex(raw.subarray(32, 64)));
  const sHigh = (N - s).toString(16).padStart(64, "0");
  const vFlipped = raw[64] === 27 ? "1c" : "1b";
  const malleated = "0x" + bytesToHex(raw.subarray(0, 32)) + sHigh + vFlipped;
  assert.notEqual(malleated, sig);
  assert.equal(
    recoverPersonalSigner("m", malleated),
    null,
    "the high-s twin recovered — the malleability guard is gone",
  );
  // and the original still verifies, so the guard refuses only the twin
  assert.equal(recoverPersonalSigner("m", sig), address);
});

test("personalSignDigest declares the UTF-8 byte length, not the char length", async () => {
  // "é" is 1 char, 2 UTF-8 bytes — a char-length envelope would deviate from
  // EIP-191 and verify against no standard tooling.
  const { keccak_256 } = await import("@noble/hashes/sha3.js");
  const { utf8ToBytes, concatBytes } = await import("@noble/hashes/utils.js");
  const expected = keccak_256(
    concatBytes(utf8ToBytes("\x19Ethereum Signed Message:\n2"), utf8ToBytes("é")),
  );
  assert.equal(bytesToHex(personalSignDigest("é")), bytesToHex(expected));
});
