/**
 * The forward feed walk (feed-walk.ts) - the replacement for Bee's sequence lookup on
 * every path that must never step back to an older update.
 *
 * Vectors 239-241 are the WoCo app feed's real updates, read from our Bee on
 * 2026-10-14. They pin the signature scheme to what Bee actually stores, so the
 * synthetic feeds below (signed by `signUpdate`) are known to be the same shape.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import {
  calculateCacAddress,
  encodeSpan,
  feedUpdateAddress,
  feedUpdateIdentifier,
  httpChunkSource,
  verifyFeedUpdate,
  walkFeedForward,
  type ChunkRead,
  type ChunkSource,
} from "../../src/index.js";

const APP_OWNER = "f8af4904c6e4f08ce5f7deab7f01221280b23a80";
const APP_TOPIC = "aef7b3bb8b50eff1516536370de7ab15de8e24592a35d2abd9977d00ebb650b2";

const LIVE: Record<number, { ref: string; hex: string }> = {
  239: {
    ref: "bed6f78ac4dd2c5fabdce139d6c1ab7aa9c12a1219ed9ad16c1030fdda71ef61",
    hex: "40166a06d3cb170cec35cddafff4b0d964ed2d8b775a154452edffee87c2db7b3c7606f4cffbf1b616f029e6fac8e558b211aeb600b205b1fa03e9626b9f56074b312e5f35fc9a3482d3b351cc9b6c38336c940120600ecce25f6b70348f3f621b2800000000000000000000006ace5b10bed6f78ac4dd2c5fabdce139d6c1ab7aa9c12a1219ed9ad16c1030fdda71ef61",
  },
  240: {
    ref: "653d3eff3a7e02f98cc334456bb148f5a70f61effdd2e4cf4c03c4a69f213b66",
    hex: "f0cd33c36b11de351e33f51d35cc3bc745f27de2b9cb10bbc555e58bb039fde392a913503ea2fed02279f5fe005ca7ec0c1ddc8ca81134dde81c6e44f9c867552ba19369eeed45baa80a25214929048c3723b95c784204ba7342298fb22475de1c2800000000000000000000006acede96653d3eff3a7e02f98cc334456bb148f5a70f61effdd2e4cf4c03c4a69f213b66",
  },
  241: {
    ref: "4ca914bc102d8ce3a03b3271a89fcb2b33154adbae2668b6b682c37c10d70089",
    hex: "1c45e7e9a36887e8d0dbf663ccee80598d95a04ee27a742c74e50b5f4a119f043a188e21b14a3a4f5cc93cad80902a78496cbf52c4533375d5287b69069b79e35b0fcd73e6d9ea29033b86c3820f790316a3723b388d7c123f597e4104af5cf81c2800000000000000000000006acf01f34ca914bc102d8ce3a03b3271a89fcb2b33154adbae2668b6b682c37c10d70089",
  },
};

const app = (index: number) => ({ owner: APP_OWNER, topic: APP_TOPIC, index });

test("live vectors: verified as signed by the app feed owner, with the deployed refs", () => {
  for (const i of [239, 240, 241]) {
    const point = verifyFeedUpdate(hexToBytes(LIVE[i]!.hex), app(i));
    assert.ok(point, `update ${i} should verify`);
    assert.equal(point.index, i);
    assert.equal(point.ref, LIVE[i]!.ref);
  }
});

test("live vectors: the identifier in each stored chunk is the one we compute", () => {
  for (const i of [239, 240, 241]) {
    assert.equal(LIVE[i]!.hex.slice(0, 64), bytesToHex(feedUpdateIdentifier(APP_TOPIC, i)));
  }
});

test("a flipped byte anywhere that matters fails verification", () => {
  const good = hexToBytes(LIVE[241]!.hex);
  for (const at of [0, 40, 32 + 10, 32 + 64, 32 + 65 + 8 + 2, good.length - 1]) {
    const bad = good.slice();
    bad[at] ^= 0x01;
    assert.equal(verifyFeedUpdate(bad, app(241)), null, `flip at byte ${at}`);
  }
});

test("an older genuine update served for a newer index is refused", () => {
  assert.equal(verifyFeedUpdate(hexToBytes(LIVE[240]!.hex), app(241)), null);
});

test("another owner's expectation refuses the app feed's chunk", () => {
  assert.equal(verifyFeedUpdate(hexToBytes(LIVE[241]!.hex), { ...app(241), owner: "11".repeat(20) }), null);
});

// ---- synthetic feeds ----

const KEY = hexToBytes("0101010101010101010101010101010101010101010101010101010101010101");
const OWNER = bytesToHex(keccak_256(secp256k1.getPublicKey(KEY, false).subarray(1)).subarray(12));
const TOPIC = bytesToHex(keccak_256(utf8ToBytes("feed-walk-test")));
const OTHER_KEY = hexToBytes("0202020202020202020202020202020202020202020202020202020202020202");

function refFor(index: number): string {
  return bytesToHex(keccak_256(utf8ToBytes(`build-${index}`)));
}

/** A v1 update exactly as Bee stores it, signed personal-sign style like bee-js. */
function signUpdate(index: number, key = KEY): Uint8Array {
  const identifier = feedUpdateIdentifier(TOPIC, index);
  const ts = new Uint8Array(8);
  new DataView(ts.buffer).setBigUint64(0, BigInt(1_700_000_000 + index));
  const payload = concatBytes(ts, hexToBytes(refFor(index)));
  const span = encodeSpan(payload.length);
  const inner = keccak_256(concatBytes(identifier, calculateCacAddress(span, payload)));
  const digest = keccak_256(concatBytes(utf8ToBytes("\x19Ethereum Signed Message:\n32"), inner));
  const rec = secp256k1.sign(digest, key, { prehash: false, format: "recovered" });
  const sig = new Uint8Array(65);
  sig.set(rec.subarray(1), 0);
  sig[64] = rec[0]! + 27;
  return concatBytes(identifier, sig, span, payload);
}

/** A source holding the given indices; `delayMs` per answer. */
function feedSource(indices: number[], opts: { delayMs?: number; key?: Uint8Array } = {}): ChunkSource {
  const byAddress = new Map(indices.map((i) => [feedUpdateAddress(OWNER, TOPIC, i), signUpdate(i, opts.key)]));
  return (address, signal) =>
    new Promise<ChunkRead>((resolve) => {
      const answer = (): ChunkRead => {
        const bytes = byAddress.get(address);
        return bytes ? { kind: "found", bytes } : { kind: "absent" };
      };
      if (!opts.delayMs) return resolve(answer());
      const t = setTimeout(() => resolve(answer()), opts.delayMs);
      signal.addEventListener("abort", () => {
        clearTimeout(t);
        resolve({ kind: "unknown", reason: "timeout" });
      });
    });
}

const walk = (fromIndex: number, sources: ChunkSource[], probeTimeoutMs = 200) =>
  walkFeedForward({ owner: OWNER, topic: TOPIC, fromIndex, sources, probeTimeoutMs });

test("synthetic updates verify (same scheme as the live vectors)", () => {
  assert.equal(verifyFeedUpdate(signUpdate(7), { owner: OWNER, topic: TOPIC, index: 7 })?.ref, refFor(7));
});

test("walks forward to the newest update", async () => {
  const best = await walk(5, [feedSource([3, 4, 5, 6, 7, 8, 9])]);
  assert.equal(best?.index, 9);
  assert.equal(best?.ref, refFor(9));
});

test("nothing newer: null, never an older update", async () => {
  assert.equal(await walk(9, [feedSource([1, 2, 3, 9])]), null);
});

test("a gap below the head does not stop the walk", async () => {
  const best = await walk(5, [feedSource([5, 7, 8])]);
  assert.equal(best?.index, 8);
});

test("long runs: crosses 128-index rounds", async () => {
  const all = Array.from({ length: 400 }, (_, i) => i);
  assert.equal((await walk(10, [feedSource(all)]))?.index, 399);
});

test("a source that claims absent everywhere cannot hide what an honest source shows", async () => {
  const liar: ChunkSource = async () => ({ kind: "absent" });
  assert.equal((await walk(5, [liar, feedSource([6, 7])]))?.index, 7);
});

test("updates signed by someone else are ignored", async () => {
  assert.equal(await walk(5, [feedSource([6, 7], { key: OTHER_KEY })]), null);
});

test("a timeout is not a hit and does not hang the walk", async () => {
  const started = Date.now();
  const best = await walk(5, [feedSource([6, 7], { delayMs: 5_000 })], 50);
  assert.equal(best, null);
  assert.ok(Date.now() - started < 1_000, "bounded by the probe timeout");
});

test("a slow source and a fast one: the fast hit wins and the slow one is cancelled", async () => {
  let aborted = 0;
  const slow: ChunkSource = (_a, signal) =>
    new Promise((resolve) => {
      signal.addEventListener("abort", () => {
        aborted++;
        resolve({ kind: "unknown", reason: "timeout" });
      });
    });
  const best = await walk(5, [slow, feedSource([6])], 2_000);
  assert.equal(best?.index, 6);
  assert.ok(aborted > 0, "the losing source's requests are aborted");
});

test("onAdvance reports each step forward, in order", async () => {
  const seen: number[] = [];
  await walkFeedForward({
    owner: OWNER,
    topic: TOPIC,
    fromIndex: 0,
    sources: [feedSource(Array.from({ length: 300 }, (_, i) => i))],
    probeTimeoutMs: 200,
    onAdvance: (p) => seen.push(p.index),
  });
  assert.ok(seen.length >= 2);
  assert.deepEqual([...seen].sort((a, b) => a - b), seen);
  assert.equal(seen.at(-1), 299);
});

// ---- the HTTP source ----

function fakeFetch(status: number, body = new Uint8Array([1, 2, 3])): typeof fetch {
  return (async () => new Response(status === 200 ? body : "x", { status })) as typeof fetch;
}

test("httpChunkSource: 200 found, 404 absent, gate 403 and 5xx unknown, network error unknown", async () => {
  const sig = new AbortController().signal;
  assert.equal((await httpChunkSource("https://g", fakeFetch(200))("ab", sig)).kind, "found");
  assert.equal((await httpChunkSource("https://g", fakeFetch(404))("ab", sig)).kind, "absent");
  assert.equal((await httpChunkSource("https://g", fakeFetch(403))("ab", sig)).kind, "unknown");
  assert.equal((await httpChunkSource("https://g", fakeFetch(503))("ab", sig)).kind, "unknown");
  const throwing = (async () => {
    throw new TypeError("offline");
  }) as typeof fetch;
  assert.equal((await httpChunkSource("https://g", throwing)("ab", sig)).kind, "unknown");
});

test("httpChunkSource reads {base}/chunks/{address}", async () => {
  let url = "";
  const spy = (async (u: string) => {
    url = u;
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  await httpChunkSource("https://gateway.example/", spy)("abc123", new AbortController().signal);
  assert.equal(url, "https://gateway.example/chunks/abc123");
});
