/**
 * The signer of a feed update must be signing the content it was told about
 * (#614): a feed resolves to the address of the chunk its update wraps.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertFeedUpdateMatches,
  calculateCacAddress,
  encodeSpan,
  eventPageFeedTopic,
  multisiteFeedTopic,
} from "../../src/index.js";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const payload = new Uint8Array(300).map((_, i) => (i * 7 + 3) & 0xff);
const address = hex(calculateCacAddress(encodeSpan(payload.length), payload));

test("the root chunk of the reported content is accepted, with or without 0x, any case", () => {
  assert.doesNotThrow(() => assertFeedUpdateMatches(payload, address));
  assert.doesNotThrow(() => assertFeedUpdateMatches(payload, "0x" + address.toUpperCase()));
});

test("one changed byte is refused", () => {
  const tampered = payload.slice();
  tampered[17] ^= 0x01;
  assert.throws(() => assertFeedUpdateMatches(tampered, address), /does not match/);
});

test("a root chunk whose real span exceeds its data is refused, not signed into a dead feed", () => {
  // An intermediate chunk commits to the SUBTREE size, not its own byte count.
  const spanned = hex(calculateCacAddress(encodeSpan(payload.length + 4096), payload));
  assert.throws(() => assertFeedUpdateMatches(payload, spanned), /does not match/);
});

test("a malformed content hash is refused before hashing", () => {
  assert.throws(() => assertFeedUpdateMatches(payload, "not-a-hash"), /64-hex/);
});

test("the event-page feed keeps the topic its manifests were built on", () => {
  // Changing this string would move every event page to a new feed.
  assert.equal(eventPageFeedTopic("evt-1"), "woco-site-evt-1");
  assert.notEqual(eventPageFeedTopic("x"), multisiteFeedTopic("x"));
});
