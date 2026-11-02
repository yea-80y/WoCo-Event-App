/**
 * A fetched sealed order is trusted only if its exact bytes hash to the root it
 * was asked for (#965, order-box.ts; Fable consult 2026-11-02). Without it, a box
 * served under another root of the same series opens fine and shows one buyer's
 * details on another buyer's ticket.
 *
 * MUTATION: drop the root comparison, compare the decoded text instead of the
 * bytes, call a mismatch "unreadable" (final) instead of "unavailable" (retried),
 * or let fetchOrderBox parse the response without boxFromBytes, and a case below
 * goes red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bytesTreeRoot } from "@woco/shared/swarm/bytes-tree";
import { MAX_BOX_BYTES, boxFromBytes } from "../src/lib/creator/dashboard/order-box.js";

const enc = new TextEncoder();
const boxJson = (tag: string, pad = 0) => JSON.stringify({ v: 2, enc: `enc-${tag}`, ct: `ct-${tag}${"0".repeat(pad)}` });
const asStored = (json: string) => {
  const bytes = enc.encode(json);
  return { bytes, root: bytesTreeRoot(bytes) };
};

test("the box whose bytes hash to the root is accepted", () => {
  const { bytes, root } = asStored(boxJson("a"));
  assert.deepEqual(boxFromBytes(root, bytes), { kind: "ok", box: { v: 2, enc: "enc-a", ct: "ct-a" } });
  assert.equal(boxFromBytes(root.toUpperCase(), bytes).kind, "ok", "a root in capitals is the same root");
});

test("another order's box served under this root is refused - and retried, never final", () => {
  const a = asStored(boxJson("a"));
  const b = asStored(boxJson("b"));
  assert.deepEqual(boxFromBytes(b.root, a.bytes), { kind: "unavailable" });
});

test("a 16 KB order (four leaves under one intermediate chunk) round-trips", () => {
  const big = asStored(boxJson("big", 16 * 1024 - 60));
  assert.ok(big.bytes.length > 4096 * 3, "really a multi-chunk order");
  const out = boxFromBytes(big.root, big.bytes);
  assert.equal(out.kind, "ok");
  assert.deepEqual(boxFromBytes(asStored(boxJson("other", 16 * 1024 - 60)).root, big.bytes), { kind: "unavailable" });
});

test("bytes that hash right but are not a sealed order are final", () => {
  for (const raw of [enc.encode("not json"), enc.encode(JSON.stringify({ v: 2, enc: 1, ct: "x" })), new Uint8Array([0xff, 0xfe, 0x7b, 0x7d])]) {
    assert.deepEqual(boxFromBytes(bytesTreeRoot(raw), raw), { kind: "unreadable" });
  }
});

test("nothing, or far too much, is final", () => {
  assert.deepEqual(boxFromBytes("00".repeat(32), new Uint8Array(0)), { kind: "unreadable" });
  assert.deepEqual(boxFromBytes("00".repeat(32), new Uint8Array(MAX_BOX_BYTES + 1)), { kind: "unreadable" });
});

test("the live gateway read hashes the exact response bytes, not decoded text", () => {
  const LIVE = readFileSync(new URL("../src/lib/creator/dashboard/browser-orders-live.ts", import.meta.url), "utf-8");
  const fetchBox = LIVE.slice(LIVE.indexOf("export async function fetchOrderBox"), LIVE.indexOf("export function liveBrowserOrdersDeps"));
  assert.match(fetchBox, /bytes = new Uint8Array\(await resp\.arrayBuffer\(\)\);/);
  assert.match(fetchBox, /return \{ \.\.\.boxFromBytes\(root, bytes\), budget \};/);
  assert.doesNotMatch(fetchBox, /JSON\.parse|resp\.text\(\)/);
});
