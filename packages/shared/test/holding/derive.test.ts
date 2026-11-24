/**
 * The order secret's derivations (`src/holding/derive.ts`): pinned outputs, each
 * reproduced by a second implementation, label separation, and the bounds.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { hkdfSync } from "node:crypto";
import { AbiCoder, computeAddress, keccak256, toUtf8Bytes } from "ethers";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  HOLDING_MAX_TICKETS,
  holdingAnswerKey,
  holdingHolderKey,
  holdingNk,
  holdingNkCommit,
  holdingPickupId,
  holdingPickupKem,
  holdingPickupSigner,
  holdingPublicValues,
  newHoldingSecret,
} from "../../src/holding/derive.js";
import { holdingBoxSealContext, openBox, sealBox } from "../../src/crypto/sealed-box.js";
import { G, R } from "./vectors.js";

function nodeHkdf(info: string): string {
  return Buffer.from(hkdfSync("sha256", R, new Uint8Array(0), info, 32)).toString("hex");
}

test("pinned per-ticket and per-order values", () => {
  const pv = holdingPublicValues(R, 3);
  assert.deepEqual(pv.holders, G.holders);
  assert.deepEqual(pv.answerKeys, G.answerKeys);
  assert.equal(holdingHolderKey(R, 9).address, G.holder9);
  assert.equal(holdingAnswerKey(R, 9).address, G.answer9);
  assert.equal(bytesToHex(holdingNk(R)), G.nk);
  assert.equal(pv.nkCommit, G.nkCommit);
  assert.equal(pv.pickupId, G.pickupId);
  assert.equal(pv.pickupSigner, G.pickupSigner);
  assert.equal(pv.pickupPub.length, 1216);
  assert.equal(bytesToHex(sha256(pv.pickupPub)), G.pickupPubSha256);
});

test("a second implementation agrees: node:crypto HKDF, ethers ABI and addresses", () => {
  assert.equal(nodeHkdf("woco/holding/v1/pickup-id"), G.pickupId);
  const nk = Buffer.from(hkdfSync("sha256", R, new Uint8Array(0), "woco/holding/v1/nk", 32));
  nk[0] = 0;
  assert.equal(nk.toString("hex"), G.nk);
  const commit = keccak256(AbiCoder.defaultAbiCoder().encode(["bytes32", "bytes32"], [keccak256(toUtf8Bytes("woco/holding/v1/nk-commit")), `0x${G.nk}`]));
  assert.equal(commit, G.nkCommit);
  for (let i = 0; i < 3; i++) {
    assert.equal(computeAddress(`0x${bytesToHex(holdingHolderKey(R, i).privateKey)}`).toLowerCase(), G.holders[i]);
    assert.equal(computeAddress(`0x${bytesToHex(holdingAnswerKey(R, i).privateKey)}`).toLowerCase(), G.answerKeys[i]);
  }
  assert.equal(computeAddress(`0x${bytesToHex(holdingPickupSigner(R).privateKey)}`).toLowerCase(), G.pickupSigner);
});

test("labels are separated: every derived value differs from every other", () => {
  const values = [
    ...[0, 1, 2, 9].flatMap((i) => [bytesToHex(holdingHolderKey(R, i).privateKey), bytesToHex(holdingAnswerKey(R, i).privateKey)]),
    bytesToHex(holdingNk(R)),
    holdingPickupId(R),
    bytesToHex(holdingPickupSigner(R).privateKey),
    bytesToHex(holdingPickupKem(R).secretKey.slice(0, 32)),
  ];
  assert.equal(new Set(values).size, values.length);
});

test("one changed byte of the secret changes every value", () => {
  const r2 = R.slice();
  r2[31] ^= 1;
  const a = holdingPublicValues(R, 2);
  const b = holdingPublicValues(r2, 2);
  assert.notEqual(a.holders[0], b.holders[0]);
  assert.notEqual(a.answerKeys[1], b.answerKeys[1]);
  assert.notEqual(a.nkCommit, b.nkCommit);
  assert.notEqual(a.pickupId, b.pickupId);
  assert.notEqual(a.pickupSigner, b.pickupSigner);
  assert.notEqual(bytesToHex(a.pickupPub), bytesToHex(b.pickupPub));
});

test("nk has a zero top byte, and its commitment refuses anything else", () => {
  for (let k = 0; k < 20; k++) assert.equal(holdingNk(newHoldingSecret())[0], 0);
  const bad = holdingNk(R).slice();
  bad[0] = 1;
  assert.throws(() => holdingNkCommit(bad));
  assert.throws(() => holdingNkCommit(new Uint8Array(31)));
});

test("bounds: the secret's length, the ticket index and the order size", () => {
  assert.throws(() => holdingNk(new Uint8Array(31)));
  assert.throws(() => holdingHolderKey(R, -1));
  assert.throws(() => holdingHolderKey(R, HOLDING_MAX_TICKETS));
  assert.throws(() => holdingAnswerKey(R, 1.5));
  assert.doesNotThrow(() => holdingHolderKey(R, HOLDING_MAX_TICKETS - 1));
  assert.throws(() => holdingPublicValues(R, 0));
  assert.throws(() => holdingPublicValues(R, HOLDING_MAX_TICKETS + 1));
  assert.equal(newHoldingSecret().length, 32);
});

test("the pickup key opens a box sealed to it, only under its own order's context", async () => {
  const kem = holdingPickupKem(R);
  const msg = new TextEncoder().encode("receipts");
  const box = await sealBox(kem.publicKey, msg, holdingBoxSealContext(G.pickupId));
  assert.deepEqual(await openBox(kem.secretKey, box, holdingBoxSealContext(G.pickupId)), msg);
  await assert.rejects(openBox(kem.secretKey, box, holdingBoxSealContext("00".repeat(32))));
});
