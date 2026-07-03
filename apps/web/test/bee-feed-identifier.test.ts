/**
 * Byte-equivalence lock between `beeFeedUpdateIdentifier` (@woco/shared, keccak
 * only — no bee-js dep) and bee-js@11's own sequence-feed identifier derivation
 * (`makeFeedIdentifier(Topic.fromString(s), FeedIndex.fromBigInt(i))`).
 *
 * The client signs multisite pointer-feed updates with identifiers from OUR
 * helper, while gateways resolve the feed with BEE's derivation — if these ever
 * diverge, every client-signed site deploy silently stops resolving. This test
 * pins the equivalence against the installed bee-js so a dependency bump that
 * changes the scheme fails loudly here, not in production.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Topic, FeedIndex, type Identifier } from "@ethersphere/bee-js";
import { beeFeedUpdateIdentifier, multisiteFeedTopic } from "@woco/shared";

// bee-js doesn't export makeFeedIdentifier from its entry point; reach the
// internal module through its own package resolution (exports-map safe).
const beeRequire = createRequire(import.meta.resolve("@ethersphere/bee-js"));
const { makeFeedIdentifier } = beeRequire("./feed/identifier.js") as {
  makeFeedIdentifier: (topic: Topic, index: FeedIndex) => Identifier;
};

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

test("matches bee-js makeFeedIdentifier across topics and indices", () => {
  const topics = [
    multisiteFeedTopic("01JX3Y5W8KQ0TESTSITEID"),
    multisiteFeedTopic("a"),
    "woco-multisite-", // degenerate but must still agree
  ];
  const indices = [0, 1, 2, 127, 128, 65535, 2 ** 32, Number.MAX_SAFE_INTEGER];

  for (const t of topics) {
    for (const i of indices) {
      const ours = toHex(beeFeedUpdateIdentifier(t, i));
      const theirs = makeFeedIdentifier(Topic.fromString(t), FeedIndex.fromBigInt(BigInt(i))).toHex();
      assert.equal(ours, theirs, `identifier mismatch for topic="${t}" index=${i}`);
    }
  }
});

test("rejects negative and non-integer indices", () => {
  assert.throws(() => beeFeedUpdateIdentifier("woco-multisite-x", -1));
  assert.throws(() => beeFeedUpdateIdentifier("woco-multisite-x", 1.5));
});
