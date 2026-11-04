/**
 * The Seats tab's chain reads (creator/seating/organiser-seat-data.ts): every ticket's
 * seat, the moves the ledger logged, and which emptied seats are still off sale. A read
 * that did not answer is never taken as "no seat" or "nothing emptied".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CallResult, ViewCall } from "@woco/shared/chain/multicall";
import {
  movedFrom, readEmptiedSeats, readTicketSeats, scanSeatMoves, slotsBySeat, NO_SEAT, type MulticallFn,
} from "../src/lib/creator/seating/organiser-seat-data.js";

const LEDGER = `0x${"5c".repeat(20)}`;
const EVENT = `0x${"7e".repeat(32)}`;
const NO = (1n << 64n) - 1n;
const word = (v: bigint) => {
  const out = new Uint8Array(32);
  for (let i = 31, x = v; i >= 0; i--, x >>= 8n) out[i] = Number(x & 0xffn);
  return out;
};
const argOf = (c: ViewCall, i: number) => BigInt(`0x${c.data.slice(10 + 64 * i, 74 + 64 * i)}`);

/** A ledger: seat per slot, taken bits, nonces; `fail` makes the call throw. */
function chain(o: { seatOf?: Record<number, bigint>; minted?: number; taken?: Set<number>; nonces?: Record<number, bigint>; fail?: boolean }): MulticallFn {
  return async (calls) => {
    if (o.fail) throw new Error("rpc down");
    return calls.map((c): CallResult => {
      const sel = c.data.slice(2, 10);
      if (c.target.endsWith("064")) return word(10n);
      if (sel === "8c172fa2") { const a = new Uint8Array(128); a.set(word(BigInt(o.minted ?? 1_000_000)), 32); return a; }
      if (sel === "4eb29918") return word(o.seatOf?.[Number(argOf(c, 1))] ?? NO);
      if (sel === "10173035") {
        const w = Number(argOf(c, 1));
        let v = 0n;
        for (const k of o.taken ?? []) if (k >> 8 === w) v |= 1n << BigInt(k & 255);
        return word(v);
      }
      if (sel === "287af508") return word(o.nonces?.[Number(argOf(c, 1))] ?? 0n);
      return null;
    });
  };
}

test("every ticket's seat, NO_SEAT as -1, in batches", async () => {
  const r = await readTicketSeats(chain({ seatOf: { 0: 4n, 2: 9n } }), LEDGER, EVENT, 3);
  assert.deepEqual([...r.seats], [[0, 4], [1, NO_SEAT], [2, 9]]);
  assert.equal(r.complete, true);
  assert.deepEqual([...slotsBySeat(r.seats)], [[4, 0], [9, 2]]);
  const big = await readTicketSeats(chain({}), LEDGER, EVENT, 1_030);
  assert.equal(big.seats.size, 1_030);
});

test("a batch that fails or comes from a replica behind the mint leaves tickets out and says so", async () => {
  const down = await readTicketSeats(chain({ fail: true }), LEDGER, EVENT, 2);
  assert.equal(down.seats.size, 0);
  assert.equal(down.complete, false);
  const behind = await readTicketSeats(chain({ minted: 1 }), LEDGER, EVENT, 2);
  assert.deepEqual([...behind.seats.keys()], [0]);
  assert.equal(behind.complete, false);
});

test("moves: every page, oldest first; a failed page marks the scan incomplete", async () => {
  const pages: Array<[number, number]> = [];
  const r = await scanSeatMoves({
    latestBlock: async () => 25_000_000,
    moves: async (from, to) => {
      pages.push([from, to]);
      if (from === 10_000_000) throw new Error("page");
      return from === 0 ? [{ slot: 1, from: 3, to: 5, block: 900 }, { slot: 2, from: NO_SEAT, to: 7, block: 100 }] : [];
    },
  }, 0);
  assert.equal(pages.length, 3);
  assert.equal(r.complete, false);
  assert.deepEqual(r.moves.map((m) => m.block), [100, 900]);
  assert.deepEqual([...movedFrom(r.moves)], [[1, 3]], "moved in from no seat has no 'from'");
});

test("emptied and still off sale: bit clear, nonce above 0, not confirmed at that nonce", async () => {
  const moves = [
    { slot: 0, from: 3, to: 4, block: 1 }, // 3 emptied, nonce 1, unconfirmed -> off sale
    { slot: 1, from: 5, to: 6, block: 2 }, // 5 emptied, confirmed at 1 -> on sale
    { slot: 2, from: 7, to: 8, block: 3 }, // 7 filled again since -> taken
    { slot: 3, from: 300, to: NO_SEAT, block: 4 }, // another word; confirmed at an OLDER nonce -> off sale
  ];
  const c = chain({ taken: new Set([4, 6, 7, 8]), nonces: { 3: 1n, 5: 1n, 7: 1n, 300: 2n } });
  const r = await readEmptiedSeats(c, LEDGER, EVENT, moves, new Map([[5, 1], [300, 1]]));
  assert.deepEqual([...r!], [[3, 1], [300, 2]]);
  assert.equal(await readEmptiedSeats(chain({ fail: true }), LEDGER, EVENT, moves, new Map()), null, "unread is not 'nothing emptied'");
  const oneMissing: MulticallFn = async (calls, expect) => {
    const r = await c(calls, expect);
    return r.map((x, i) => (calls[i]!.data.startsWith("0x287af508") && argOf(calls[i]!, 1) === 3n ? null : x));
  };
  assert.equal(await readEmptiedSeats(oneMissing, LEDGER, EVENT, moves, new Map()), null, "one seat unread: the whole answer is unread");
  assert.deepEqual([...(await readEmptiedSeats(c, LEDGER, EVENT, [], new Map()))!], []);
});
