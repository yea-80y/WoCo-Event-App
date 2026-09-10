/**
 * The content-feed signer, now an HKDF sibling of the account seed rather than a
 * second sign-to-derive signature.
 *
 * What this has to establish, in order of how badly it fails:
 *
 *  1. DETERMINISM. The address it produces OWNS the user's content chunks. If it
 *     is not a pure function of the seed, a user's own feeds become unreadable
 *     on their next device and there is no recovery — the chunks are addressed
 *     by the owner, so a different key is a different feed, not a failed read.
 *  2. INDEPENDENCE from its two siblings. Only the HKDF `info` string separates
 *     the feed signer, the issuing key and the X25519 encryption key. If two
 *     collapsed onto one value, the key that signs on every publish would also
 *     be the key that signs an organiser's manifests, or the key that decrypts
 *     their buyers' order data — and nothing would look wrong.
 *  3. That the address is the ORDINARY Ethereum address of the private key.
 *     Checked against ethers' own `computeAddress`, not against our own
 *     keccak — a bespoke address computation here would produce a SOC owner no
 *     other tool agrees with.
 *
 * The golden vector is pinned BYTES, not a re-derivation: running the same
 * function on both sides of an assertion passes even when the derivation moves.
 *
 * PROVENANCE OF THE VECTOR: produced by this implementation on 2026-09-10 from
 * the seed `0x` + `ab` × 32 — the same fixed seed `issuing.test.ts` uses, so the
 * independence assertions below compare two vectors from one input. It is a
 * self-consistency ratchet: it pins that the derivation has not moved, and does
 * not claim to be a standard test vector (there is none for an HKDF info string
 * we invented). Do NOT "fix" a failure by pasting new values — a mismatch means
 * every user's SOC owner just changed, which is a re-publish of everything they
 * have ever written, not a test update.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAddress } from "ethers";
import { deriveFeedSignerKey, FEED_SIGNER_INFO } from "../../src/crypto/feed-signer.js";
import { scalarToPrivateKey } from "../../src/crypto/secp-hkdf.js";
import { deriveIssuingKey } from "../../src/crypto/issuing.js";
import { deriveEncryptionKeypairFromSeed } from "../../src/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const SEED = "0x" + "ab".repeat(32);
const OTHER_SEED = "0x" + "cd".repeat(32);

// --- golden -----------------------------------------------------------------

test("golden: fixed seed → pinned feed-signer key and address", () => {
  const { privKey, address } = deriveFeedSignerKey(SEED);
  assert.equal(
    privKey,
    "0x1113bc26a6e578f0a6087ff85e11ddaa233c8e2da6ceac6d7414bb0a5b62935f",
    "feed-signer PRIVATE KEY moved — HKDF info/salt/expansion or the scalar map changed",
  );
  assert.equal(
    address,
    "0x90a6d4a0d64f9f1f4e7bcecf1fd401a2c5885ae4",
    "feed-signer ADDRESS moved — every content SOC this account owns is orphaned",
  );
});

test("the HKDF info string is frozen", () => {
  assert.equal(FEED_SIGNER_INFO, "woco/feed-signer/v1");
});

// --- determinism ------------------------------------------------------------

test("derivation is deterministic and 0x-prefix-insensitive", () => {
  const a = deriveFeedSignerKey(SEED);
  const b = deriveFeedSignerKey(SEED.slice(2));
  assert.deepEqual(a, b);
  assert.deepEqual(deriveFeedSignerKey(SEED), a, "a repeat call must not drift");
});

test("different seeds give different signers", () => {
  assert.notEqual(deriveFeedSignerKey(OTHER_SEED).address, deriveFeedSignerKey(SEED).address);
  assert.notEqual(deriveFeedSignerKey(OTHER_SEED).privKey, deriveFeedSignerKey(SEED).privKey);
});

// --- independence from the siblings -----------------------------------------

test("the feed signer is NOT the gen-0 issuing key", () => {
  // Same seed, same curve, same construction — only the info string differs. A
  // collision here would mean the key that signs every publish is also the key
  // that signs an organiser's manifests and certificates.
  assert.notEqual(deriveFeedSignerKey(SEED).address, deriveIssuingKey(SEED, 0).address);
});

test("the feed signer is not any issuing GENERATION", () => {
  const feed = deriveFeedSignerKey(SEED).address;
  for (let gen = 0; gen < 8; gen++) {
    assert.notEqual(deriveIssuingKey(SEED, gen).address, feed, `collided with gen ${gen}`);
  }
});

test("the feed signer is NOT the X25519 encryption key", () => {
  // Different curves, so this compares the raw secret bytes: the hazard is one
  // 32-byte secret doing two jobs, not two objects being equal.
  const feed = deriveFeedSignerKey(SEED).privKey.slice(2);
  const enc = bytesToHex(deriveEncryptionKeypairFromSeed(SEED).privateKey);
  assert.notEqual(feed, enc);
});

test("the feed signer is not the seed itself", () => {
  // The ed25519 holder key IS the seed verbatim. This one must not be, or a
  // leaked feed signer would hand over every other key the account owns.
  assert.notEqual(deriveFeedSignerKey(SEED).privKey.toLowerCase(), SEED.toLowerCase());
});

// --- the address is an ordinary Ethereum address ----------------------------

test("the address is ethers' computeAddress of the private key, lowercased", () => {
  for (const seed of [SEED, OTHER_SEED, "0x" + "01".repeat(32), "0x" + "ff".repeat(32)]) {
    const { privKey, address } = deriveFeedSignerKey(seed);
    assert.equal(address, computeAddress(privKey).toLowerCase());
    assert.match(address, /^0x[0-9a-f]{40}$/, "lowercase — it keys feed topics and registry values");
  }
});

test("the private key is always 32 bytes, zero-padded", () => {
  for (let i = 0; i < 24; i++) {
    const { privKey } = deriveFeedSignerKey(i.toString(16).padStart(2, "0").repeat(32));
    assert.match(privKey, /^0x[0-9a-f]{64}$/);
  }
});

test("a SMALL scalar is still 32 bytes — the padding is the guard, not luck", () => {
  // The loop above never produces a leading zero byte (~2^-8 per byte), so it
  // does not actually exercise the padding: a `scalarToPrivateKey` that emitted
  // minimal-length hex passes it. This drives the mapping directly with scalars
  // that DO need padding. An unpadded key is not a wrong key — `new Wallet()`
  // and every SOC signer reject a short one outright, so the failure is a signer
  // that cannot be constructed at all, for one account in 256.
  for (const scalar of [1n, 255n, 256n, 0xffffn, 1n << 200n]) {
    const bytes = scalarToPrivateKey(scalar);
    assert.equal(bytes.length, 32, `scalar ${scalar} produced ${bytes.length} bytes`);
    assert.equal(BigInt("0x" + bytesToHex(bytes)), scalar, "padding must not change the value");
  }
});

// --- refusals ---------------------------------------------------------------

test("a malformed seed is refused loudly, never truncated or padded", () => {
  assert.throws(() => deriveFeedSignerKey("0x1234"), /expected 32 bytes/);
  assert.throws(() => deriveFeedSignerKey("ab".repeat(33)), /expected 32 bytes/);
  assert.throws(() => deriveFeedSignerKey("zz".repeat(32)), /hex/i);
  assert.throws(() => deriveFeedSignerKey(undefined as unknown as string), /hex string/);
});
