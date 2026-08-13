/**
 * The orphan tombstone (#283).
 *
 * Properties pinned: the record survives a round-trip lowercased; a corrupt or
 * malformed note reads as ABSENT (a refusal must rest on a well-formed proof,
 * and a broken one downgrades to pre-#283 behavior instead of refusing on
 * evidence nobody can inspect); and a missing or broken storage can neither
 * throw nor fabricate a tombstone.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readOrphanTombstone,
  writeOrphanTombstone,
  type TombstoneStorage,
} from "../src/lib/auth/orphan-tombstone.js";

const EOA = "0xAaAaAAAAaaaAAaAAaaaaAAaaaaAaaaAaAaaAaAaA";
const KERNEL = "0xCcCCcCCCcccCCcCCccccCCccccCcccCcCccCcCcC";
const OWNER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const KEY = `woco:korphan:passkey:${EOA.toLowerCase()}`;

function memStore(seed: Record<string, string> = {}): TombstoneStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
}

test("a written tombstone reads back, lowercased, keyed per credential", () => {
  const store = memStore();
  writeOrphanTombstone("passkey", EOA, { kernel: KERNEL, owner: OWNER }, store);
  const t = readOrphanTombstone("passkey", EOA, store);
  assert.ok(t);
  assert.equal(t.kernel, KERNEL.toLowerCase());
  assert.equal(t.owner, OWNER);
  assert.ok(t.at > 0, "the proof is timestamped");
  assert.ok(store.map.has(KEY), "keyed under the lowercased EOA");
  assert.equal(readOrphanTombstone("web3auth", EOA, store), null, "kinds do not share graves");
});

test("a corrupt or malformed note reads as absent, never as proof", () => {
  for (const raw of [
    "not json",
    "{}",
    JSON.stringify({ kernel: "nope", owner: OWNER, at: 1 }),
    JSON.stringify({ kernel: KERNEL.toLowerCase(), owner: "0x123", at: 1 }),
    JSON.stringify({ owner: OWNER, at: 1 }),
  ]) {
    const store = memStore({ [KEY]: raw });
    assert.equal(readOrphanTombstone("passkey", EOA, store), null, `accepted: ${raw}`);
  }
});

test("no storage, or a throwing one, neither throws nor fabricates", () => {
  assert.equal(readOrphanTombstone("passkey", EOA, undefined), null);
  writeOrphanTombstone("passkey", EOA, { kernel: KERNEL, owner: OWNER }, undefined);
  const broken: TombstoneStorage = {
    getItem: () => { throw new Error("quota"); },
    setItem: () => { throw new Error("quota"); },
  };
  assert.equal(readOrphanTombstone("passkey", EOA, broken), null);
  writeOrphanTombstone("passkey", EOA, { kernel: KERNEL, owner: OWNER }, broken);
});

test("a missing timestamp is tolerated — `at` is forensics, never logic", () => {
  const store = memStore({
    [KEY]: JSON.stringify({ kernel: KERNEL.toLowerCase(), owner: OWNER }),
  });
  const t = readOrphanTombstone("passkey", EOA, store);
  assert.ok(t);
  assert.equal(t.at, 0);
});
