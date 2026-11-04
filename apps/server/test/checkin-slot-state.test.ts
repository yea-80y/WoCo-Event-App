/**
 * Ledger2 slots for the door pack (slot-state.ts): owner and seat per slot from one
 * Multicall3 batch at one block, `isSeated` remembered once read, and the cache's
 * rules - highest block wins, a failed read never reads as "no ticket".
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { NO_SEAT_INDEX } from "@woco/shared";
import { LEDGER2_NO_SEAT } from "@woco/shared/ticket/ledger2-terms";
import type { CallResult, ViewCall } from "@woco/shared/chain/multicall";
import { clearSlotOwnerCache, OWNER_CACHE_MS, STALE_MAX_MS } from "../src/lib/checkin/slot-owners.js";
import { clearSeatedMemo, readSlotStates, SLOTS_PER_BATCH, type MulticallFn } from "../src/lib/checkin/slot-state.js";

beforeEach(() => {
  clearSlotOwnerCache();
  clearSeatedMemo();
});

const LEDGER = { chainId: 42161, address: "0x" + "5c".repeat(20) };
const EVENT = "0x" + "7e".repeat(32);
const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);

const word = (v: bigint) => {
  const out = new Uint8Array(32);
  for (let i = 31, x = v; i >= 0; i--, x >>= 8n) out[i] = Number(x & 0xffn);
  return out;
};
const addressWord = (a: string) => word(BigInt(a));

interface Model {
  block: bigint;
  owners: Record<number, string>;
  seats: Record<number, bigint>;
  seated: boolean | "revert";
  /** Slots whose calls fail inside an otherwise good batch. */
  failSlots?: Set<number>;
  /** Slots whose seat call alone fails. */
  failSeatSlots?: Set<number>;
  down?: boolean;
  noBlock?: boolean;
  /** The event's `nextSlot` as this replica sees it (default: every slot minted); "revert" fails the call. */
  minted?: number | "revert";
}

const getEventAnswer = (nextSlot: number) => {
  const out = new Uint8Array(128);
  out.set(word(BigInt(nextSlot)), 32);
  return out;
};

function chain(m: Model) {
  const batches: ViewCall[][] = [];
  const call: MulticallFn = async (_chainId, calls) => {
    batches.push([...calls]);
    if (m.down) throw new Error("rpc down");
    return calls.map((c): CallResult => {
      const sel = c.data.slice(2, 10);
      const slot = c.data.length > 74 ? Number(BigInt(`0x${c.data.slice(74, 138)}`)) : -1;
      if (c.target === "0x0000000000000000000000000000000000000064") return m.noBlock ? null : word(m.block);
      if (sel === "b2db691d") return m.seated === "revert" ? null : word(m.seated ? 1n : 0n);
      if (sel === "8c172fa2") return m.minted === "revert" ? null : getEventAnswer(m.minted ?? 1_000_000);
      if (m.failSlots?.has(slot)) return null;
      if (sel === "4eb29918" && m.failSeatSlots?.has(slot)) return null;
      if (sel === "17e7f2ff") return addressWord(m.owners[slot] ?? "0x0");
      if (sel === "4eb29918") return word(m.seats[slot] ?? LEDGER2_NO_SEAT);
      return null;
    });
  };
  return { call, batches };
}

test("owner and seat per slot, NO_SEAT as -1, an unclaimed slot as no owner", async () => {
  const c = chain({ block: 10n, owners: { 0: A, 1: B }, seats: { 0: 4n, 1: LEDGER2_NO_SEAT }, seated: true });
  const r = await readSlotStates(LEDGER, EVENT, 3, { seats: true, supply: 10 }, c.call, () => 1_000);
  assert.deepEqual(r.owners, [A, B, ""]);
  assert.deepEqual(r.seats, [4, NO_SEAT_INDEX, NO_SEAT_INDEX]);
  assert.equal(r.seated, true);
  assert.equal(c.batches.length, 1, "one batch: block, isSeated, the event's count, owner + seat per slot");
  assert.equal(c.batches[0].length, 1 + 1 + 1 + 3 * 2);
});

test("F3: a replica behind a fresh mint leaves that slot unread, never cached as 'no ticket'", async () => {
  let t = 1_000;
  // The caller's count (3) came from a replica that has the third ticket; this one does not yet.
  const m: Model = { block: 10n, owners: { 0: A, 1: B }, seats: { 0: 1n, 1: 2n }, seated: true, minted: 2 };
  const c = chain(m);
  const r = await readSlotStates(LEDGER, EVENT, 3, { seats: true, supply: 5 }, c.call, () => t);
  assert.deepEqual(r.owners, [A, B, null]);
  assert.deepEqual(r.seats, [1, 2, null]);
  // Next pack, inside the cache window: the slot is read again and now found.
  Object.assign(m, { block: 11n, minted: 3, owners: { 0: A, 1: B, 2: A }, seats: { 0: 1n, 1: 2n, 2: 7n } });
  t += 1_000;
  const again = await readSlotStates(LEDGER, EVENT, 3, { seats: true, supply: 5 }, c.call, () => t);
  assert.deepEqual(again.owners, [A, B, A]);
  assert.deepEqual(again.seats, [1, 2, 7]);
});

test("F3: a batch whose count could not be read is dropped whole", async () => {
  const c = chain({ block: 10n, owners: { 0: A }, seats: { 0: 1n }, seated: true, minted: "revert" });
  const r = await readSlotStates(LEDGER, EVENT, 1, { seats: true, supply: 1 }, c.call, () => 1_000);
  assert.deepEqual(r.owners, [null]);
  assert.deepEqual(r.seats, [null]);
  assert.equal(r.seated, true, "isSeated still read: it does not depend on the count");
});

test("a general-admission read asks no seats", async () => {
  const c = chain({ block: 10n, owners: { 0: A }, seats: {}, seated: false });
  const r = await readSlotStates(LEDGER, EVENT, 1, { seats: false, supply: 5 }, c.call, () => 1_000);
  assert.deepEqual(r.owners, [A]);
  assert.deepEqual(r.seats, []);
  assert.equal(r.seated, false);
  assert.equal(c.batches[0].length, 4);
});

test("slots are read in batches of SLOTS_PER_BATCH", async () => {
  const n = SLOTS_PER_BATCH + 3;
  const owners: Record<number, string> = {};
  for (let i = 0; i < n; i++) owners[i] = A;
  const c = chain({ block: 10n, owners, seats: {}, seated: true });
  const r = await readSlotStates(LEDGER, EVENT, n, { seats: true, supply: n }, c.call, () => 1_000);
  assert.equal(r.owners.filter((o) => o === A).length, n);
  assert.equal(c.batches.length, 2);
});

test("isSeated is read once, then remembered (fixed at registration)", async () => {
  let t = 1_000;
  const c = chain({ block: 10n, owners: { 0: A }, seats: { 0: 1n }, seated: true });
  await readSlotStates(LEDGER, EVENT, 1, { seats: true, supply: 1 }, c.call, () => t);
  t += OWNER_CACHE_MS;
  await readSlotStates(LEDGER, EVENT, 1, { seats: true, supply: 1 }, c.call, () => t);
  const asks = c.batches.flat().filter((x) => x.data.startsWith("0xb2db691d")).length;
  assert.equal(asks, 1);
});

test("an event a replica does not know yet reads seated unknown, never 'not seated', and is asked again", async () => {
  const m: Model = { block: 10n, owners: {}, seats: {}, seated: "revert" };
  const c = chain(m);
  const r = await readSlotStates(LEDGER, EVENT, 0, { seats: false, supply: 0 }, c.call, () => 1_000);
  assert.equal(r.seated, null);
  m.seated = true;
  const again = await readSlotStates(LEDGER, EVENT, 0, { seats: false, supply: 0 }, c.call, () => 2_000);
  assert.equal(again.seated, true);
});

test("an isSeated answer that is not 0 or 1 is no answer, never remembered as 'not seated'", async () => {
  const m: Model = { block: 10n, owners: {}, seats: {}, seated: true };
  let odd = true;
  const c = chain(m);
  const call: MulticallFn = async (chainId, calls, expect) => {
    const out = await c.call(chainId, calls, expect);
    return out.map((r, i) => (odd && calls[i].data.startsWith("0xb2db691d") ? word(2n) : r));
  };
  assert.equal((await readSlotStates(LEDGER, EVENT, 0, { seats: false, supply: 0 }, call, () => 1_000)).seated, null);
  odd = false;
  assert.equal((await readSlotStates(LEDGER, EVENT, 0, { seats: false, supply: 0 }, call, () => 2_000)).seated, true, "asked again");
});

test("a batch with no block is dropped whole: unread, never 'no ticket'", async () => {
  const c = chain({ block: 10n, owners: { 0: A }, seats: { 0: 1n }, seated: true, noBlock: true });
  const r = await readSlotStates(LEDGER, EVENT, 1, { seats: true, supply: 1 }, c.call, () => 1_000);
  assert.deepEqual(r.owners, [null]);
  assert.deepEqual(r.seats, [null]);
  assert.equal(r.seated, null);
});

test("a slot whose calls failed is unread, not seatless", async () => {
  const c = chain({ block: 10n, owners: { 0: A, 1: B }, seats: { 0: 1n, 1: 2n }, seated: true, failSlots: new Set([1]) });
  const r = await readSlotStates(LEDGER, EVENT, 2, { seats: true, supply: 2 }, c.call, () => 1_000);
  assert.deepEqual(r.owners, [A, null]);
  assert.deepEqual(r.seats, [1, null]);
});

test("a slot whose SEAT call alone failed is unread as a whole: an owner with no seat is never a pair", async () => {
  const c = chain({ block: 10n, owners: { 0: A, 1: B }, seats: { 0: 1n, 1: 2n }, seated: true, failSeatSlots: new Set([1]) });
  const r = await readSlotStates(LEDGER, EVENT, 2, { seats: true, supply: 2 }, c.call, () => 1_000);
  assert.deepEqual(r.owners, [A, null]);
  assert.deepEqual(r.seats, [1, null]);
});

test("a lagging answer inside the cache window is asked again on the next pack, not left for the window", async () => {
  let t = 1_000;
  const m: Model = { block: 20n, owners: { 0: B }, seats: { 0: 4n }, seated: true };
  const c = chain(m);
  await readSlotStates(LEDGER, EVENT, 1, { seats: true, supply: 1 }, c.call, () => t);
  t += OWNER_CACHE_MS;
  Object.assign(m, { block: 19n, owners: { 0: A } }); // the full re-read hits a replica behind us
  assert.deepEqual((await readSlotStates(LEDGER, EVENT, 1, { seats: true, supply: 1 }, c.call, () => t)).owners, [B]);
  Object.assign(m, { block: 21n, owners: { 0: A } }); // the ticket really moved, at block 21
  t += 1_000; // inside the new window
  assert.deepEqual((await readSlotStates(LEDGER, EVENT, 1, { seats: true, supply: 1 }, c.call, () => t)).owners, [A]);
});

test("a lagging replica cannot roll a moved seat or a transferred owner back", async () => {
  let t = 1_000;
  const m: Model = { block: 20n, owners: { 0: B }, seats: { 0: LEDGER2_NO_SEAT }, seated: true };
  const c = chain(m);
  await readSlotStates(LEDGER, EVENT, 1, { seats: true, supply: 1 }, c.call, () => t);
  // An older replica still has the slot's earlier owner and seat.
  Object.assign(m, { block: 19n, owners: { 0: A }, seats: { 0: 3n } });
  t += OWNER_CACHE_MS;
  const r = await readSlotStates(LEDGER, EVENT, 1, { seats: true, supply: 1 }, c.call, () => t);
  assert.deepEqual(r.owners, [B]);
  assert.deepEqual(r.seats, [NO_SEAT_INDEX], "a ticket moved out of its seat stays seatless");
});

test("a replica that keeps lagging cannot keep the held state alive past the staleness bound", async () => {
  let t = 1_000;
  const m: Model = { block: 20n, owners: { 0: B }, seats: { 0: 4n }, seated: true };
  const c = chain(m);
  await readSlotStates(LEDGER, EVENT, 1, { seats: true, supply: 1 }, c.call, () => t);
  m.block = 19n; // every answer from here on is from behind what we hold
  t += STALE_MAX_MS - 1;
  assert.deepEqual((await readSlotStates(LEDGER, EVENT, 1, { seats: true, supply: 1 }, c.call, () => t)).seats, [4]);
  t += 2;
  const late = await readSlotStates(LEDGER, EVENT, 1, { seats: true, supply: 1 }, c.call, () => t);
  assert.deepEqual(late.owners, [null], "the lagging answers vouched for nothing: couldn't confirm");
  assert.deepEqual(late.seats, [null]);
});

test("RPC down after a good read: the last state stands; never read: unread up to supply", async () => {
  let t = 1_000;
  const m: Model = { block: 10n, owners: { 0: A }, seats: { 0: 5n }, seated: true };
  const c = chain(m);
  await readSlotStates(LEDGER, EVENT, 1, { seats: true, supply: 3 }, c.call, () => t);
  m.down = true;
  t += OWNER_CACHE_MS;
  const r = await readSlotStates(LEDGER, EVENT, 2, { seats: true, supply: 3 }, c.call, () => t);
  assert.deepEqual(r.owners, [A, null]);
  assert.deepEqual(r.seats, [5, null]);
  const noEvent = await readSlotStates(LEDGER, EVENT, null, { seats: true, supply: 3 }, c.call, () => t);
  assert.deepEqual(noEvent.owners, [A, null, null]);
});
