/**
 * The content-feed version hint must be findable by the side that did not
 * write it (#302).
 *
 * `hintKey` lowercased the owner but did not normalise the `0x` prefix, and the
 * two callers pass different forms: `writeContentFeed` derives its owner from
 * `new Wallet(key).address` (0x-prefixed), while `readContentFeedResult` strips
 * the prefix before probing. So each side only ever saw its own hint, and
 * `readVersionHint` returns 0 on a miss — every operation restarted the forward
 * version scan from zero.
 *
 * COST, NOT CORRECTNESS, which is why it survived: the scan is sound either
 * way. But a probe PAST the latest version is a bee network search for a chunk
 * that does not exist — the most expensive read on Swarm, and the reason
 * `VERSION_PROBE_WINDOW` was cut to 2 after a window of 8 melted the node in
 * July 2026. The hint is the thing that keeps the scan short, and it had been
 * silently inert on every client-owned feed: profiles, events, sites, social
 * statements and coaster credits.
 *
 * A behavioural test would need the whole Swarm stack, and the failure produces
 * no wrong answer to assert on. So the key derivation is asserted directly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { hintKey } from "../src/lib/swarm/content-feed.js";

const TOPIC = "woco/credit/v1/statement/abc";
// The exact two forms the real call sites produce.
const WRITE_SIDE = "0xAbC1230000000000000000000000000000000456"; // ethers address
const READ_SIDE = "abc1230000000000000000000000000000000456";    // prefix stripped, lowercased

test("the write side's hint is findable by the read side", () => {
  assert.equal(hintKey(WRITE_SIDE, TOPIC), hintKey(READ_SIDE, TOPIC));
});

test("case is normalised too, so a checksummed address matches a lowercased one", () => {
  assert.equal(hintKey("0xABC123", TOPIC), hintKey("0xabc123", TOPIC));
  assert.equal(hintKey("ABC123", TOPIC), hintKey("abc123", TOPIC));
});

test("the topic still separates feeds owned by the same rider", () => {
  // The whole point of the key: one rider has many feeds. Normalising the owner
  // must not collapse their statement feed into their subject index.
  assert.notEqual(hintKey(WRITE_SIDE, TOPIC), hintKey(WRITE_SIDE, `${TOPIC}/other`));
});

test("different owners never share a hint", () => {
  assert.notEqual(hintKey(WRITE_SIDE, TOPIC), hintKey("0xdef4560000000000000000000000000000000789", TOPIC));
});
