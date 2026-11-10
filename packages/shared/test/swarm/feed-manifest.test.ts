/**
 * The feed manifest bee makes, built here byte for byte (#614, #912 slice 2b). The server
 * stores manifests itself from this, so every vector is a manifest production already
 * points at: a different byte would move a name's or a domain's target.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  expectedFeedManifestHash,
  feedManifestChildChunk,
  feedManifestFor,
  feedManifestRootChunk,
} from "../../src/swarm/feed-manifest.ts";
import { calculateCacAddress } from "../../src/swarm/soc.ts";
import { eventPageFeedTopic, multisiteFeedTopic } from "../../src/site/topics.ts";

// hackathon.woco.eth's feed manifest root chunk (2026-10-06), read from our bee.
const REAL = Uint8Array.from(Buffer.from(
  "800100000000000000000000000000000000000000000000000000000000000000000000000000005768b3b6a7db56d21d1abff40d41cebfc83448fed8d7e9b06ec0d3b073f28f200000000000000000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000012012f00000000000000000000000000000000000000000000000000000000008504f2a107ca940beafc4ce2f6c9a9f0968c62a5b5893ff0e4e1e2983048d27600be7b22737761726d2d666565642d6f776e6572223a2264616332666637373163333836376436343633633237646461383238356137333831316538383334222c22737761726d2d666565642d746f706963223a2233386664633365323361393135376237646363303531363635303833396231373336363832383831383130363236383535643130623464653232393964323037222c22737761726d2d666565642d74797065223a2253657175656e6365227d0a0a0a0a0a0a0a0a0a0a0a0a",
  "hex",
));
const OWNER = "dac2ff771c3867d6463c27dda8285a73811e8834";
const TOPIC = "38fdc3e23a9157b7dcc0516650839b1736682881810626855d10b4de2299d207";

const addressOf = (chunk: Uint8Array) => bytesToHex(calculateCacAddress(chunk.subarray(0, 8), chunk.subarray(8)));

test("the root chunk is the one bee made, byte for byte", () => {
  assert.deepEqual(feedManifestRootChunk(OWNER, TOPIC), REAL);
  assert.equal(expectedFeedManifestHash(OWNER, TOPIC), addressOf(REAL));
});

test("the '/' child is one empty node for every feed, and the root names it", () => {
  const child = feedManifestChildChunk();
  assert.equal(child.length, 8 + 128);
  assert.equal(addressOf(child), "8504f2a107ca940beafc4ce2f6c9a9f0968c62a5b5893ff0e4e1e2983048d276");
  // The child's address sits in the root's one fork (chunk offset 168).
  assert.equal(bytesToHex(REAL.subarray(168, 200)), addressOf(child));
});

test("production name targets: an event page and a website, from their signer and id alone", () => {
  // hackathon.woco.eth -> event 43becb36's page feed.
  assert.equal(bytesToHex(keccak_256(new TextEncoder().encode(eventPageFeedTopic("43becb36-2b71-4d55-bf23-6c18b6bed32f")))), TOPIC);
  assert.equal(feedManifestFor(`0x${OWNER}`, eventPageFeedTopic("43becb36-2b71-4d55-bf23-6c18b6bed32f")), "d24237682b360376b613321850e4e5e035823d68b2659392afea95162e7ca0b7");
  // Recorded in name-targets.json, each made by Etherna's POST /feeds (measured 2026-11-10).
  assert.equal(
    feedManifestFor("0x00d68007cf8bd91d84b40539b9e78232fa33dc88", eventPageFeedTopic("c91434e7-5d28-4f88-a7eb-9bbbd7d0151f")),
    "011ba08723e00caf1eec07f885eda49a80f74f0f80a03b7830af3dc5f2fedbe9",
  );
  assert.equal(
    feedManifestFor("0x3324650E2D49B36A4D8A883EACC45394AE7BAD00", multisiteFeedTopic("mvk4388p-rm7dnip")),
    "5ab0a3467f9dc825c8074bd1df31840253625b595e338db2be0eb4217ce5e6bf",
  );
});

test("only a bare lowercase owner and topic are accepted, so a typo can never name some other feed", () => {
  for (const [owner, topic] of [
    [`0x${OWNER}`, TOPIC],
    [OWNER.toUpperCase(), TOPIC],
    [OWNER.slice(2), TOPIC],
    [OWNER, TOPIC.slice(2)],
    [OWNER, `0x${TOPIC}`],
  ]) {
    assert.throws(() => expectedFeedManifestHash(owner!, topic!));
  }
});
