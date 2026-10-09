/**
 * A feed manifest is read exactly as bee reads it (#186): the feed a name follows is
 * decided by the one "/" fork bee resolves through, never by feed-looking JSON found
 * elsewhere in the bytes. Checked against a real root chunk and against manifests
 * bee-js builds (bee-js's marshal is the format bee reads).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MantarayNode, NULL_ADDRESS } from "@ethersphere/bee-js";
import { feedOfManifestChunk } from "../src/lib/swarm/feed-manifest.ts";

// hackathon.woco.eth's feed manifest root chunk (2026-10-06), as in event-name-link.test.ts.
const REAL = Uint8Array.from(Buffer.from(
  "800100000000000000000000000000000000000000000000000000000000000000000000000000005768b3b6a7db56d21d1abff40d41cebfc83448fed8d7e9b06ec0d3b073f28f200000000000000000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000012012f00000000000000000000000000000000000000000000000000000000008504f2a107ca940beafc4ce2f6c9a9f0968c62a5b5893ff0e4e1e2983048d27600be7b22737761726d2d666565642d6f776e6572223a2264616332666637373163333836376436343633633237646461383238356137333831316538383334222c22737761726d2d666565642d746f706963223a2233386664633365323361393135376237646363303531363635303833396231373336363832383831383130363236383535643130623464653232393964323037222c22737761726d2d666565642d74797065223a2253657175656e6365227d0a0a0a0a0a0a0a0a0a0a0a0a",
  "hex",
));
const OWNER = "dac2ff771c3867d6463c27dda8285a73811e8834";
const TOPIC = "38fdc3e23a9157b7dcc0516650839b1736682881810626855d10b4de2299d207";

function chunkOf(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  let n = payload.length;
  for (let i = 0; i < 8; i++) {
    out[i] = n & 0xff;
    n = Math.floor(n / 256);
  }
  out.set(payload, 8);
  return out;
}

async function built(forks: Array<[string, Record<string, string>]>): Promise<Uint8Array> {
  const node = new MantarayNode();
  for (const [path, meta] of forks) node.addFork(path, NULL_ADDRESS, meta);
  return chunkOf(await node.marshal());
}

const feedMeta = (owner = OWNER, topic = TOPIC) => ({ "swarm-feed-owner": owner, "swarm-feed-topic": topic, "swarm-feed-type": "Sequence" });

test("the real manifest, and one bee-js builds, read as their feed", async () => {
  assert.deepEqual(feedOfManifestChunk(REAL), { owner: OWNER, topic: TOPIC });
  assert.deepEqual(feedOfManifestChunk(await built([["/", feedMeta()]])), { owner: OWNER, topic: TOPIC });
});

test("another fork beside '/', or a fork that is not exactly '/', is not a feed manifest", async () => {
  const other = "11".repeat(20);
  assert.equal(feedOfManifestChunk(await built([["/", feedMeta()], ["x", feedMeta(other)]])), null);
  assert.equal(feedOfManifestChunk(await built([["/a", feedMeta()]])), null);
});

test("metadata must be bee's exact text: no extra or reordered key, the Sequence type", async () => {
  assert.equal(feedOfManifestChunk(await built([["/", { ...feedMeta(), "website-index-document": "x" }]])), null);
  assert.equal(feedOfManifestChunk(await built([["/", { "swarm-feed-topic": TOPIC, "swarm-feed-owner": OWNER, "swarm-feed-type": "Sequence" }]])), null);
  assert.equal(feedOfManifestChunk(await built([["/", { ...feedMeta(), "swarm-feed-type": "Epoch" }]])), null);
});

test("trailing bytes, a wrong span, a wrong version or truncation are refused", () => {
  const trailing = chunkOf(Uint8Array.from([...REAL.subarray(8), 0x0a]));
  assert.equal(feedOfManifestChunk(trailing), null);
  const badSpan = REAL.slice();
  badSpan[0] ^= 1;
  assert.equal(feedOfManifestChunk(badSpan), null);
  const badVersion = REAL.slice();
  badVersion[40] ^= 1;
  assert.equal(feedOfManifestChunk(badVersion), null);
  assert.equal(feedOfManifestChunk(chunkOf(REAL.subarray(8, 200))), null);
});

test("a properly obfuscated manifest is read through its key, as bee does", () => {
  const key = new Uint8Array(32).map((_, i) => (i * 37 + 11) & 0xff);
  const body = REAL.subarray(8 + 32).map((b, i) => b ^ key[i % 32]!);
  assert.deepEqual(feedOfManifestChunk(chunkOf(Uint8Array.from([...key, ...body]))), { owner: OWNER, topic: TOPIC });
});

test("the bytes bee skips or reads differently are refused too: another bitmap bit, a padded prefix, a longer prefix", () => {
  // Offsets in the chunk: span 8, key 32, version 31, target length 1, target 32 -> bitmap at 104; fork at 136.
  const extraBit = REAL.slice();
  extraBit[104] |= 1;
  assert.equal(feedOfManifestChunk(extraBit), null);
  const paddedPrefix = REAL.slice();
  paddedPrefix[136 + 2 + 5] = 0x41;
  assert.equal(feedOfManifestChunk(paddedPrefix), null);
  const longerPrefix = REAL.slice();
  longerPrefix[136 + 1] = 2; // "/" then a zero byte: another path to bee
  assert.equal(feedOfManifestChunk(longerPrefix), null);
});
