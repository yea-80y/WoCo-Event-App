/**
 * The buyer's own copy (`src/holding/copy.ts`) and its index seal (`src/crypto/sealed-box.ts`).
 * The layout is versioned, not frozen - but a silent change to a topic would hide every
 * copy already written from a reader that does not know the old one, so the derivations
 * are pinned here, against node:crypto as a second implementation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, hkdfSync } from "node:crypto";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  HOLDING_INDEX_MAX_ORDERS,
  holdingCopyOf,
  holdingCopyTopic,
  holdingIndexEntryOf,
  holdingIndexTopic,
  holdingTopicSalt,
  parseHoldingCopy,
  parseHoldingIndex,
  sameHoldingCopy,
  sameHoldingIndexEntry,
  withHoldingIndexEntry,
  type HoldingIndexEntry,
} from "../../src/holding/copy.js";
import {
  HOLDING_INDEX_SEAL_INFO,
  holdingCopySealContext,
  holdingIndexSealContext,
  openBoxJson,
  sealBoxJson,
} from "../../src/crypto/sealed-box.js";
import { deriveXWingKeypairFromSeed } from "../../src/crypto/xwing.js";
import { makeBox } from "./box-fixture.js";
import { G, R } from "./vectors.js";

const S = new Uint8Array(32).map((_, i) => 0x40 + i);
const GOLDEN = {
  salt: "d206cea45b4cc86b971d4eb87c6f1433a71364b549ef1549c0fa8f16d2706106",
  copy: "woco/holding/v1/69deb9a295801c7dcaf05206262a3be9567e0737c1207914a9e9900e13f74718",
  index: "woco/holding/v1/b1daab0aed424f582845c1ef858d92f786986e5acc46db6cd051a9ad34f1532a",
};

test("topic salt and topics: golden, and equal to node:crypto", () => {
  const salt = holdingTopicSalt(S);
  assert.equal(bytesToHex(salt), GOLDEN.salt);
  assert.equal(
    bytesToHex(salt),
    Buffer.from(hkdfSync("sha256", S, Buffer.alloc(0), Buffer.from("woco/holding/v1/topic-salt"), 32)).toString("hex"),
  );
  assert.equal(holdingCopyTopic(salt, G.pickupId), GOLDEN.copy);
  assert.equal(
    holdingCopyTopic(salt, G.pickupId),
    "woco/holding/v1/" + createHmac("sha256", salt).update(Buffer.from(G.pickupId, "hex")).digest("hex"),
  );
  assert.equal(holdingIndexTopic(salt), GOLDEN.index);
  assert.equal(holdingIndexTopic(salt), "woco/holding/v1/" + createHmac("sha256", salt).update("woco/holding/v1/index").digest("hex"));
});

test("topics differ by order, by generation, and the index from every order", () => {
  const salt = holdingTopicSalt(S);
  const nextGen = holdingTopicSalt(new Uint8Array(32).fill(1));
  const other = "ab".repeat(32);
  assert.notEqual(holdingCopyTopic(salt, G.pickupId), holdingCopyTopic(salt, other));
  assert.notEqual(holdingCopyTopic(salt, G.pickupId), holdingCopyTopic(nextGen, G.pickupId));
  assert.notEqual(holdingIndexTopic(salt), holdingIndexTopic(nextGen));
  assert.notEqual(holdingIndexTopic(salt), holdingCopyTopic(salt, G.pickupId));
  assert.throws(() => holdingTopicSalt(S.slice(1)));
  assert.throws(() => holdingCopyTopic(salt, G.pickupId.toUpperCase()));
  assert.throws(() => holdingCopyTopic(salt.slice(1), G.pickupId));
  assert.throws(() => holdingIndexTopic(new Uint8Array(31)));
});

test("index seal context: FROZEN label, bound to its topic", async () => {
  assert.equal(HOLDING_INDEX_SEAL_INFO, "woco/holding/v1/index");
  const topic = holdingIndexTopic(holdingTopicSalt(S));
  assert.deepEqual(holdingIndexSealContext(topic), { info: "woco/holding/v1/index", aad: `woco/holding/v1/index:${topic}` });
  for (const bad of ["", "woco/holding/v1/", `${topic}0`, topic.toUpperCase(), `x${topic}`]) {
    assert.throws(() => holdingIndexSealContext(bad), bad);
  }
  const key = deriveXWingKeypairFromSeed(bytesToHex(S));
  const sealed = await sealBoxJson(key.publicKey, { v: 1, orders: [] }, holdingIndexSealContext(topic));
  const otherTopic = holdingIndexTopic(holdingTopicSalt(new Uint8Array(32).fill(1)));
  await assert.rejects(openBoxJson(key.secretKey, sealed, holdingIndexSealContext(otherTopic)));
  // Never confusable with an order's copy.
  await assert.rejects(openBoxJson(key.secretKey, sealed, holdingCopySealContext(G.pickupId)));
  assert.deepEqual(await openBoxJson(key.secretKey, sealed, holdingIndexSealContext(topic)), { v: 1, orders: [] });
});

test("a copy round-trips; anything else parses to null", () => {
  const box = makeBox(R, 2);
  const copy = holdingCopyOf(R, box);
  assert.equal(copy.r, bytesToHex(R));
  assert.deepEqual(parseHoldingCopy(JSON.parse(JSON.stringify(copy))), copy);
  assert.throws(() => holdingCopyOf(R.slice(1), box));
  for (const bad of [
    null,
    "copy",
    { ...copy, v: 2 },
    { ...copy, r: copy.r.toUpperCase() },
    { ...copy, r: copy.r.slice(2) },
    { ...copy, r: undefined },
    { ...copy, box: { v: 1, receipts: [] } },
    { ...copy, box: undefined },
  ]) {
    assert.equal(parseHoldingCopy(bad), null, JSON.stringify(bad));
  }
});

const BASE_ENTRY = holdingIndexEntryOf(G.pickupId, makeBox(R, 2));

test("same copy: the secret and every receipt field count, key order does not", () => {
  const copy = holdingCopyOf(R, makeBox(R, 2));
  const reordered = JSON.parse(JSON.stringify(copy, Object.keys(copy.box.receipts[0]!).reverse().concat(["v", "r", "box", "receipts"])));
  assert.notEqual(JSON.stringify(reordered), JSON.stringify(copy));
  assert.equal(sameHoldingCopy(copy, reordered), true);
  assert.equal(sameHoldingCopy(copy, holdingCopyOf(new Uint8Array(32).fill(3), copy.box)), false);
  assert.equal(sameHoldingCopy(copy, { ...copy, box: { v: 1, receipts: copy.box.receipts.slice(1) } }), false);
  // Every field of a receipt, so a field added later cannot be left out of the comparison.
  for (const key of Object.keys(copy.box.receipts[0]!)) {
    const changed = JSON.parse(JSON.stringify(copy));
    const v = changed.box.receipts[1][key];
    changed.box.receipts[1][key] = typeof v === "number" ? v + 1 : `${v}0`;
    assert.equal(sameHoldingCopy(copy, changed), false, key);
  }
});

function entry(pickupId: string, editions = [7, 8]): HoldingIndexEntry {
  return { ...BASE_ENTRY, pickupId, editions };
}

test("index entry: from a box, with its tickets ascending", () => {
  const box = makeBox(R, 3);
  const e = holdingIndexEntryOf(G.pickupId, { v: 1, receipts: [box.receipts[2]!, box.receipts[0]!, box.receipts[1]!] });
  assert.deepEqual(e, {
    pickupId: G.pickupId,
    chainId: box.receipts[0]!.chainId,
    ledger: box.receipts[0]!.ledger,
    eventId: box.receipts[0]!.eventId,
    wocoEventId: "evt-1",
    seriesId: "series-1",
    editions: [7, 8, 9],
  });
  assert.throws(() => holdingIndexEntryOf(G.pickupId, { v: 1, receipts: [] }));
  assert.throws(() => holdingIndexEntryOf("zz", box));
});

test("an index parses only whole, one entry per order", () => {
  const a = entry("aa".repeat(32));
  const b = entry("bb".repeat(32), [3]);
  assert.deepEqual(parseHoldingIndex({ v: 1, orders: [a, b] }), { v: 1, orders: [a, b] });
  assert.deepEqual(parseHoldingIndex({ v: 1, orders: [] }), { v: 1, orders: [] });
  for (const bad of [
    null,
    { v: 2, orders: [] },
    { v: 1 },
    { v: 1, orders: [a, a] },
    { v: 1, orders: [{ ...a, pickupId: "AA".repeat(32) }] },
    { v: 1, orders: [{ ...a, chainId: 0 }] },
    { v: 1, orders: [{ ...a, ledger: a.ledger.toUpperCase() }] },
    { v: 1, orders: [{ ...a, eventId: "0x12" }] },
    { v: 1, orders: [{ ...a, wocoEventId: "Evt" }] },
    { v: 1, orders: [{ ...a, seriesId: "" }] },
    { v: 1, orders: [{ ...a, editions: [] }] },
    { v: 1, orders: [{ ...a, editions: [0] }] },
    { v: 1, orders: [{ ...a, editions: [1.5] }] },
    { v: 1, orders: [{ ...a, editions: Array.from({ length: 101 }, (_, i) => i + 1) }] },
    { v: 1, orders: Array.from({ length: HOLDING_INDEX_MAX_ORDERS + 1 }, (_, i) => entry(i.toString(16).padStart(64, "0"))) },
  ]) {
    assert.equal(parseHoldingIndex(bad), null, JSON.stringify(bad)?.slice(0, 120));
  }
});

test("adding an entry replaces the same order's, keeps the rest, and refuses a full list", () => {
  const a = entry("aa".repeat(32));
  const b = entry("bb".repeat(32));
  const a2 = entry("aa".repeat(32), [9]);
  assert.deepEqual(withHoldingIndexEntry(null, a), { v: 1, orders: [a] });
  assert.deepEqual(withHoldingIndexEntry({ v: 1, orders: [a, b] }, a2), { v: 1, orders: [b, a2] });
  const full = { v: 1 as const, orders: Array.from({ length: HOLDING_INDEX_MAX_ORDERS }, (_, i) => entry(i.toString(16).padStart(64, "0"))) };
  assert.throws(() => withHoldingIndexEntry(full, b));
  // The same order again is a replacement, not a new row, even when full.
  assert.equal(withHoldingIndexEntry(full, full.orders[0]!).orders.length, HOLDING_INDEX_MAX_ORDERS);
});

test("same entry: every field counts", () => {
  const a = entry("aa".repeat(32));
  assert.equal(sameHoldingIndexEntry(a, { ...a, editions: [...a.editions] }), true);
  for (const b of [
    { ...a, pickupId: "bb".repeat(32) },
    { ...a, chainId: 1 },
    { ...a, ledger: `0x${"cd".repeat(20)}` },
    { ...a, eventId: `0x${"cd".repeat(32)}` },
    { ...a, wocoEventId: "evt-2" },
    { ...a, seriesId: "series-2" },
    { ...a, editions: [7] },
    { ...a, editions: [7, 9] },
  ]) {
    assert.equal(sameHoldingIndexEntry(a, b), false, JSON.stringify(b));
  }
});
