import { test } from "node:test";
import assert from "node:assert/strict";
import { slotSeatsBatch } from "../../src/seating/chain.js";

const LEDGER = `0x${"5c".repeat(20)}`;
const EVENT = `0x${"7e".repeat(32)}`;
const word = (v: bigint) => {
  const out = new Uint8Array(32);
  for (let i = 31, x = v; i >= 0; i--, x >>= 8n) out[i] = Number(x & 0xffn);
  return out;
};
const getEvent = (nextSlot: bigint) => {
  const out = new Uint8Array(128);
  out.set(word(nextSlot), 32);
  return out;
};

test("block, the event's count, then seatOf per slot; a slot past this block's count is left out", () => {
  const b = slotSeatsBatch(LEDGER, EVENT, [0, 1, 2]);
  assert.equal(b.calls.length, 5);
  assert.deepEqual(b.expect, [32, 128, 32, 32, 32]);
  assert.ok(b.calls[2].data.startsWith("0x4eb29918"), "seatOf");
  const r = b.decode([word(99n), getEvent(2n), word(7n), word((1n << 64n) - 1n), word(0n)]);
  assert.equal(r.block, 99n);
  assert.deepEqual([...r.seats], [[0, 7n], [1, (1n << 64n) - 1n]], "slot 2 is not minted on this replica");
});

test("no block or no count: nothing is trusted", () => {
  const b = slotSeatsBatch(LEDGER, EVENT, [0]);
  assert.equal(b.decode([null, getEvent(5n), word(1n)]).seats.size, 0);
  assert.equal(b.decode([word(1n), null, word(1n)]).seats.size, 0);
  assert.deepEqual([...b.decode([word(1n), getEvent(5n), null]).seats], [], "a failed slot is left out");
});
