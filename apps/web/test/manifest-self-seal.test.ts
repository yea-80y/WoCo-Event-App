/**
 * Encrypt-to-self guarantees for the user manifest (Recovery Increment 3a).
 *
 * The manifest is the user's OWN private data, sealed under a key derived from
 * their feed-signer secret and bound (AAD) to their account address. These tests
 * lock in the properties the comfort layer depends on:
 *   1. Round-trip: seal → open with the SAME key + account returns the exact body.
 *   2. Confidentiality: the SAME plaintext under DIFFERENT feed-signer keys yields
 *      independent keystreams (ciphertext differs), and a WRONG key cannot open.
 *   3. Anti-transplant: an envelope sealed for account A does not open under
 *      account B (the address is AEAD additional-data, not just a label).
 *   4. Tamper-evidence: flipping a ciphertext byte makes `open` throw (Poly1305).
 *
 * Runs against the REAL self-seal code (WebCrypto/noble are available in Node).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { sealToSelf, openFromSelf } from "../src/lib/manifest/self-seal.js";
import type { UserManifest } from "@woco/shared";

const keyA = new Wallet(`0x${"11".repeat(32)}`).privateKey;
const keyB = new Wallet(`0x${"22".repeat(32)}`).privateKey;
const acctA = "0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa";
const acctB = "0xBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbb";

const sample: UserManifest = {
  v: 1,
  updatedAt: 1_700_000_000_000,
  backups: [
    { method: "email", providerLabel: "google", guardianAddress: "0x1234", addedAt: 1 },
    { method: "passkey", guardianAddress: "0x5678", addedAt: 2 },
  ],
};

test("round-trips the manifest body with the same key + account", () => {
  const env = sealToSelf({ feedSignerPrivKey: keyA, parentAddress: acctA, data: sample });
  const out = openFromSelf<UserManifest>({ feedSignerPrivKey: keyA, parentAddress: acctA, envelope: env });
  assert.deepEqual(out, sample);
});

test("account-address casing does not break the AAD bind", () => {
  const env = sealToSelf({ feedSignerPrivKey: keyA, parentAddress: acctA.toLowerCase(), data: sample });
  const out = openFromSelf<UserManifest>({
    feedSignerPrivKey: keyA,
    parentAddress: acctA.toUpperCase(),
    envelope: env,
  });
  assert.deepEqual(out, sample);
});

test("a wrong feed-signer key cannot open the envelope", () => {
  const env = sealToSelf({ feedSignerPrivKey: keyA, parentAddress: acctA, data: sample });
  assert.throws(() =>
    openFromSelf<UserManifest>({ feedSignerPrivKey: keyB, parentAddress: acctA, envelope: env }),
  );
});

test("an envelope sealed for account A does not open under account B (anti-transplant)", () => {
  const env = sealToSelf({ feedSignerPrivKey: keyA, parentAddress: acctA, data: sample });
  assert.throws(() =>
    openFromSelf<UserManifest>({ feedSignerPrivKey: keyA, parentAddress: acctB, envelope: env }),
  );
});

test("tampering with the ciphertext is detected", () => {
  const env = sealToSelf({ feedSignerPrivKey: keyA, parentAddress: acctA, data: sample });
  // Flip the last ciphertext byte (hex nibble) — Poly1305 must reject it.
  const flipped = { ...env, ct: env.ct.slice(0, -1) + (env.ct.at(-1) === "0" ? "1" : "0") };
  assert.throws(() =>
    openFromSelf<UserManifest>({ feedSignerPrivKey: keyA, parentAddress: acctA, envelope: flipped }),
  );
});

test("fresh nonce per seal — same input yields different ciphertext", () => {
  const a = sealToSelf({ feedSignerPrivKey: keyA, parentAddress: acctA, data: sample });
  const b = sealToSelf({ feedSignerPrivKey: keyA, parentAddress: acctA, data: sample });
  assert.notEqual(a.nonce, b.nonce);
  assert.notEqual(a.ct, b.ct);
});
