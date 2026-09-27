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

/**
 * Bee's own `/bytes` reference vectors (`pkg/file/testing/vector.go`, v2.8.1): data is
 * `i % 255`, and the root must equal what bee computes, or every existing orderRef
 * reader breaks. 19 and 20 (64 MiB) are left out; orders are capped at 16 KiB.
 */
const BEE_BYTES_VECTORS: Array<[number, string]> = [
  [31, "ece86edb20669cc60d142789d464d57bdf5e33cb789d443f608cbd81cfa5697d"],
  [32, "0be77f0bb7abc9cd0abed640ee29849a3072ccfd1020019fe03658c38f087e02"],
  [33, "3463b46d4f9d5bfcbf9a23224d635e51896c1daef7d225b86679db17c5fd868e"],
  [63, "95510c2ff18276ed94be2160aed4e69c9116573b6f69faaeed1b426fea6a3db8"],
  [64, "490072cc55b8ad381335ff882ac51303cc069cbcb8d8d3f7aa152d9c617829fe"],
  [65, "541552bae05e9a63a6cb561f69edf36ffe073e441667dbf7a0e9a3864bb744ea"],
  [4096, "c10090961e7682a10890c334d759a28426647141213abda93b096b892824d2ef"],
  [4096 + 31, "91699c83ed93a1f87e326a29ccd8cc775323f9e7260035a5f014c975c5f3cd28"],
  [4096 + 32, "73759673a52c1f1707cbb61337645f4fcbd209cdc53d7e2cedaaa9f44df61285"],
  [4096 + 63, "db1313a727ffc184ae52a70012fbbf7235f551b9f2d2da04bf476abe42a3cb42"],
  [4096 + 64, "ade7af36ac0c7297dc1c11fd7b46981b629c6077bce75300f85b02a6153f161b"],
  [4096 * 2, "29a5fb121ce96194ba8b7b823a1f9c6af87e1791f824940a53b5a7efe3f790d9"],
  [4096 * 2 + 32, "61416726988f77b874435bdd89a419edc3861111884fd60e8adf54e2f299efd6"],
  [4096 * 128, "3047d841077898c26bbe6be652a2ec590a5d9bd7cd45d290ea42511b48753c09"],
  [4096 * 128 + 31, "e5c76afa931e33ac94bce2e754b1bb6407d07f738f67856783d93934ca8fc576"],
  [4096 * 128 + 32, "485a526fc74c8a344c43a4545a5987d17af9ab401c0ef1ef63aefcc5c2c086df"],
  [4096 * 128 + 64, "624b2abb7aefc0978f891b2a56b665513480e5dc195b4a66cd8def074a6d2e94"],
  [4096 * 129, "b8e1804e37a064d28d161ab5f256cc482b1423d5cd0a6b30fde7b0f51ece9199"],
  [4096 * 130, "59de730bf6c67a941f3b2ffa2f920acfaa1713695ad5deea12b4a121e5f23fa1"],
];

test("split roots equal bee's own /bytes reference vectors", async () => {
  for (const [size, expected] of BEE_BYTES_VECTORS) {
    const data = new Uint8Array(size).map((_, i) => i % 255);
    const { root } = await splitPayload(data);
    assert.equal(hexlify(root).slice(2), expected, `bee vector, ${size} bytes`);
  }
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
