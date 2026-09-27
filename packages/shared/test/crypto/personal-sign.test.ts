/**
 * personalSignKeccak signs Swarm postage stamps and single-owner chunks. Bee
 * recovers the signer from these bytes; a wrong prefix, a byte-order slip in
 * the v/r/s reordering or a high-s value would each make every stamp invalid
 * or malleable. Cross-checked against ethers, a separate code path over an
 * older noble release.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { SigningKey, Wallet, getBytes, hashMessage, hexlify, keccak256, verifyMessage } from "ethers";
import { personalSignKeccak, personalSignKeccakDigest } from "../../src/crypto/personal-sign.js";

const KEY = new Uint8Array(32).fill(0x44);
const ADDRESS = new Wallet(`0x${"44".repeat(32)}`).address;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const inputs = [new Uint8Array(0), new Uint8Array(80).fill(7), new TextEncoder().encode("woco stamp")];

test("the digest is EIP-191 over the 32-byte keccak of the data", () => {
  for (const data of inputs) {
    assert.equal(`0x${Buffer.from(personalSignKeccakDigest(data)).toString("hex")}`, hashMessage(getBytes(keccak256(data))));
  }
});

test("signatures recover to the key under ethers' verifyMessage", () => {
  for (const data of inputs) {
    const sig = personalSignKeccak(data, KEY);
    assert.equal(sig.length, 65);
    assert.ok(sig[64] === 27 || sig[64] === 28);
    assert.equal(verifyMessage(getBytes(keccak256(data)), hexlify(sig)), ADDRESS);
  }
});

test("byte-identical to ethers' RFC 6979 signature: same r, s, v", () => {
  const signer = new SigningKey(KEY);
  for (const data of inputs) {
    const theirs = signer.sign(personalSignKeccakDigest(data));
    const ours = personalSignKeccak(data, KEY);
    assert.equal(`0x${Buffer.from(ours).toString("hex")}`, theirs.serialized);
  }
});

test("s is always in the low half (no malleable twin)", () => {
  for (let i = 0; i < 64; i++) {
    const sig = personalSignKeccak(new Uint8Array([i, i >> 1, 0x5a]), KEY);
    const s = BigInt(`0x${Buffer.from(sig.subarray(32, 64)).toString("hex")}`);
    assert.ok(s > 0n && s <= N / 2n, `signature ${i}`);
  }
});
