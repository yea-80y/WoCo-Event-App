/**
 * The QUARANTINED X25519 sealing the credits rail still uses (#642).
 *
 * A static ciphertext that the quarantined `openJson` must open forever, so a
 * drift in the HKDF info bytes, the ECIES construction or the AES-GCM parameters
 * fails here instead of silently orphaning every private credit statement.
 *
 * PROVENANCE: sealed once on 2026-09-27 by `lib/credits/legacy-seal.ts` (moved
 * byte-for-byte from the shared `ecies.ts`) to the X25519 key of the pinned seed
 * below — the same seed and key the retired shared canary pinned. Do NOT
 * regenerate it to make a failure go away: that failure is the outage.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { deriveEncryptionKeypairFromSeed } from "@woco/shared";
import { openJson, sealJson, type LegacySealedBox } from "../src/lib/credits/legacy-seal.js";

const SEED = "0x72e9100a95f0a342992d0729b88e2afcca0151c3bb2029d0c3867e66435a4651";
const X25519_PUB = "9db15133070753b2302ae50ec75d00e312e1859aa3a1550d38829ecf2955d14d";
const FIXTURE: LegacySealedBox = {
  ephemeralPublicKey: "4b83a029fe26646c2b9e95e38f3d71b7493a910d371d539b784da7cc32f00b4d",
  iv: "5e91ffdd628dd7ddb0146d20",
  ciphertext:
    "b003b0bd3875176ee784e79ca6cdcc0cd13e90aae09d51d5e753661186834f5d7d93bf3fead247fcf7248d3a44318254c4eccfeea93f6ac35ff88172ee6f4d",
};
const PAYLOAD = { canary: "woco-credits-legacy-seal-v1", n: 42 };

test("the pinned recipient key still derives from the pinned seed", () => {
  assert.equal(deriveEncryptionKeypairFromSeed(SEED).publicKeyHex, X25519_PUB);
});

test("a box sealed at quarantine time still opens", async () => {
  const enc = deriveEncryptionKeypairFromSeed(SEED);
  assert.deepEqual(await openJson(enc.privateKey, FIXTURE), PAYLOAD);
});

test("a tampered box is refused, and a fresh seal round-trips", async () => {
  const enc = deriveEncryptionKeypairFromSeed(SEED);
  const i = 40;
  const tampered = { ...FIXTURE, ciphertext: FIXTURE.ciphertext.slice(0, i) + (FIXTURE.ciphertext[i] === "0" ? "1" : "0") + FIXTURE.ciphertext.slice(i + 1) };
  await assert.rejects(openJson(enc.privateKey, tampered));
  assert.deepEqual(await openJson(enc.privateKey, await sealJson(enc.publicKeyHex, PAYLOAD)), PAYLOAD);
});
