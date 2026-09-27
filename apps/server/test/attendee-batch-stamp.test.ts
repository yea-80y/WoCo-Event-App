/**
 * Stamps we sign for the attendee batch (#546). A stamp the network rejects
 * loses the order blob; a stamp in the wrong slot or with a stale timestamp
 * makes the blob impossible to erase later. Neither shows up until it matters,
 * so the bytes are pinned against an independent implementation.
 *
 * The golden vector was produced by Etherchunk's `src/stamper.ts` (Cafe137/etherchunk
 * @ 3bcb3d3) for the same inputs, and the signature is checked with ethers, a
 * separate secp256k1 implementation from the cafe-utility code bee-js signs with.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { BatchId, MerkleTree, PrivateKey, Utils } from "@ethersphere/bee-js";
import { Wallet, concat, getBytes, hexlify, keccak256, verifyMessage } from "ethers";
import {
  bucketOf,
  decodeTimestampNs,
  encodeTimestampNs,
  nextTimestampNs,
  signStamp,
  slotsPerBucket,
  splitPayload,
} from "../src/lib/attendee-batch/stamp.js";

const KEY = "11".repeat(32);
const BATCH = "22".repeat(32);
const ADDRESS = getBytes(keccak256(new TextEncoder().encode("woco attendee vector")));
const NOW_MS = 1_790_000_000_000;

/** Etherchunk stamp for (KEY, BATCH, ADDRESS, slot 3, NOW_MS): batchId || index || timestamp || signature. */
const ETHERCHUNK_STAMP =
  "2222222222222222222222222222222222222222222222222222222222222222" +
  "000050d900000003" +
  "18d75b8423f30000" +
  "6dacdc71feb0544e5f64a9e32f1fabc436529d77e0120b8fa797f5cb146fbd83" +
  "77ec8680bb023dc306030a34957556518642de4f16840a07d6dda034e6c91db9" +
  "1c";

test("a stamp is byte-identical to Etherchunk's for the same inputs", () => {
  const env = signStamp(new PrivateKey(KEY), new BatchId(BATCH), ADDRESS, 3, nextTimestampNs(0n, NOW_MS));
  assert.equal(Utils.convertEnvelopeToMarshaledStamp(env).toHex(), ETHERCHUNK_STAMP);
});

test("the signature recovers to the issuer over the digest the postage contract checks", () => {
  const env = signStamp(new PrivateKey(KEY), new BatchId(BATCH), ADDRESS, 3, nextTimestampNs(0n, NOW_MS));
  const digest = keccak256(concat([ADDRESS, getBytes(`0x${BATCH}`), env.index, env.timestamp]));
  const expected = new Wallet(`0x${KEY}`).address;
  assert.equal(verifyMessage(getBytes(digest), hexlify(env.signature)), expected);
  assert.equal(hexlify(env.issuer).toLowerCase(), expected.toLowerCase());
});

test("the index is the address's 16-bit bucket then the slot, both uint32 BE", () => {
  const env = signStamp(new PrivateKey(KEY), new BatchId(BATCH), ADDRESS, 7, 1n);
  assert.equal(bucketOf(ADDRESS), 0x50d9);
  assert.equal(hexlify(env.index), "0x000050d900000007");
});

test("timestamps are nanoseconds, never milliseconds", () => {
  const ts = nextTimestampNs(0n, NOW_MS);
  assert.equal(ts, 1_790_000_000_000_000_000n);
  assert.equal(decodeTimestampNs(encodeTimestampNs(ts)), ts);
  assert.equal(hexlify(encodeTimestampNs(ts)), "0x18d75b8423f30000");
});

test("a new stamp is strictly newer than the one it replaces, even if the clock went back", () => {
  const stored = nextTimestampNs(0n, NOW_MS);
  assert.ok(nextTimestampNs(stored, NOW_MS + 1) > stored);
  assert.equal(nextTimestampNs(stored, NOW_MS), stored + 1n);
  assert.equal(nextTimestampNs(stored, NOW_MS - 60_000), stored + 1n);
});

test("slots per bucket follow the depth, and nonsense depths are refused", () => {
  assert.equal(slotsPerBucket(17), 2);
  assert.equal(slotsPerBucket(20), 16);
  for (const bad of [16, 15, 20.5, Number.NaN, 41]) assert.throws(() => slotsPerBucket(bad));
});

test("an address that is not 32 bytes, or a slot out of range, is refused", () => {
  const key = new PrivateKey(KEY);
  const batch = new BatchId(BATCH);
  assert.throws(() => signStamp(key, batch, ADDRESS.slice(1), 0, 1n));
  assert.throws(() => signStamp(key, batch, ADDRESS, -1, 1n));
  assert.throws(() => signStamp(key, batch, ADDRESS, 2 ** 32, 1n));
});

test("splitting gives the same root as the chunker, root last, bodies trimmed to what was written", async () => {
  const cases: Array<[number, number[]]> = [
    [1, [9]],
    [100, [108]],
    [4096, [4104]],
    [4097, [4104, 9, 8 + 2 * 32]],
    [16384, [4104, 4104, 4104, 4104, 8 + 4 * 32]],
    [16385, [4104, 4104, 4104, 4104, 9, 8 + 5 * 32]],
  ];
  for (const [size, bodyLengths] of cases) {
    const data = new Uint8Array(size).map((_, i) => (i * 13 + 5) & 255);
    const { root, chunks } = await splitPayload(data);
    assert.equal(hexlify(root), hexlify((await MerkleTree.root(data)).hash()), `root, ${size} bytes`);
    assert.deepEqual(chunks.map((c) => c.body.length), bodyLengths, `body lengths, ${size} bytes`);
    assert.equal(hexlify(chunks[chunks.length - 1].address), hexlify(root), `root last, ${size} bytes`);
  }
});
