/**
 * Sealed-box canary (PR 1 of the issuer-curve migration).
 *
 * A STATIC ciphertext, sealed once under a fixed recipient key and pasted
 * here, that `openJsonAuto` must open forever. The sibling test file
 * (sealed-compression.test.ts) only round-trips: it runs the SAME code on
 * both sides, so a drift in HKDF info bytes, the ECIES construction, the
 * AES-GCM parameters or the gzip sniff would re-seal and re-open consistently
 * and still pass. This fixture was produced by the code as it stood — opening
 * it exercises today's construction against tomorrow's code.
 *
 * If this test fails, every sealed order, audience list and escrow bundle in
 * existence just became undecryptable to the current build. Do NOT regenerate
 * the fixture to make it pass — that is the outage, not a stale test.
 *
 * The recipient key is `deriveEncryptionKeypairFromPodSeed` of a pinned seed,
 * so the HKDF("woco/encryption/v1") sibling derivation is inside the blast
 * radius too, not just the ECIES open path.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { deriveEncryptionKeypairFromPodSeed } from "../../src/crypto/keys.js";
import { openJsonAuto } from "../../src/crypto/ecies.js";
import type { SealedBox } from "../../src/crypto/types.js";

// Same pinned seed as apps/web/test/identity-vectors.test.ts (derived there
// from the fixed test wallet 0xabab…; restated here because shared tests must
// not depend on the web workspace).
const SEED = "0x72e9100a95f0a342992d0729b88e2afcca0151c3bb2029d0c3867e66435a4651";
const X25519_PUB = "9db15133070753b2302ae50ec75d00e312e1859aa3a1550d38829ecf2955d14d";

// Sealed by sealJsonCompressed at fixture time (gzip path — Node has
// CompressionStream), so the gzip sniff in openJsonAuto is pinned as well.
const FIXTURE: SealedBox = {
  ephemeralPublicKey: "326b4bb95fb8f04c930ed931dbb7c61a3e83e5bbf8d61a753aee92114373a675",
  iv: "8057300e400409361ba879ec",
  ciphertext:
    "b27c12bde1860d4ab6f28b66ccf8e5f56cc28e2a4aa219b9bbd133938d7987333108f3ee9fa378691af46540ea6d97650ef7d60b6902b40fb93feadf13aa30416c4626b672be790936",
};
const PAYLOAD = { canary: "woco-sealed-canary-v1", n: 42 };

test("the pinned recipient key still derives from the pinned seed", () => {
  const enc = deriveEncryptionKeypairFromPodSeed(SEED);
  assert.equal(enc.publicKeyHex, X25519_PUB, "HKDF encryption-sibling derivation moved");
});

test("a sealed box from fixture time still opens (HKDF/ECIES/AES-GCM/gzip frozen)", async () => {
  const enc = deriveEncryptionKeypairFromPodSeed(SEED);
  const back = await openJsonAuto<typeof PAYLOAD>(enc.privateKey, FIXTURE);
  assert.deepEqual(back, PAYLOAD, "the sealed-data construction drifted — existing blobs are orphaned");
});

test("a tampered fixture is refused, not decrypted to garbage", async () => {
  const enc = deriveEncryptionKeypairFromPodSeed(SEED);
  const tampered: SealedBox = {
    ...FIXTURE,
    // flip one nibble mid-ciphertext — AES-GCM's tag must catch it
    ciphertext:
      FIXTURE.ciphertext.slice(0, 40) +
      (FIXTURE.ciphertext[40] === "0" ? "1" : "0") +
      FIXTURE.ciphertext.slice(41),
  };
  await assert.rejects(() => openJsonAuto(enc.privateKey, tampered));
});
