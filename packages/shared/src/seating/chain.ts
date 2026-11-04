/**
 * The ledger2 reads behind a seat map, as Multicall3 batches (chain/multicall.ts):
 * the event (`getEvent` for its `manifestRef`, `isSeated`, `getEventStatus`,
 * `remaining`), seat words (`seatWord`, 256 seats each), seat nonces for chosen
 * seats, and the L2 block and timestamp every batch ran at.
 *
 * Public RPCs balance across replicas, so two reads can come from different heights.
 * Every batch carries ArbSys `arbBlockNumber()`; a reader keeps, per value, the
 * highest block it has seen and drops anything older, so a sold seat never flickers
 * back to free. A seat's word and its nonce are read in ONE batch (state.ts: split,
 * a seat freed between the two reads would sell unconfirmed).
 */

import {
  ARBSYS_ADDRESS, ARB_BLOCK_NUMBER, MULTICALL3_ADDRESS, boolAt, bytes32At, staticCall, uintAt,
  type CallResult, type ViewCall,
} from "../chain/multicall.js";

const SEL = {
  getEvent: "8c172fa2",
  getEventStatus: "4b0ecb30",
  remaining: "bc1ed74c",
  isSeated: "b2db691d",
  seatWord: "10173035",
  seatNonces: "287af508",
  /** Multicall3 `getCurrentBlockTimestamp()`. */
  blockTimestamp: "0f28c97d",
} as const;

/** Seat words per batch: 256 words = 65,536 seats, ~70 KB of calldata. */
export const SEAT_WORDS_PER_BATCH = 256;

export interface SeatEventRead {
  totalSupply: bigint;
  nextSlot: bigint;
  manifestRef: string;
  seated: boolean;
  remaining: bigint;
  cancelled: boolean;
  eventEndTs: bigint;
  blockTs: bigint;
}

export interface SeatBatchRead {
  /** The L2 block the batch ran at; null = unknown, and the batch must be dropped. */
  block: bigint | null;
  /** Present when asked for; null when any of its calls failed. */
  event?: SeatEventRead | null;
  /** Words answered, by word index (failed ones absent). */
  words: Map<number, bigint>;
  /** Nonces answered, by seat. */
  nonces: Map<number, bigint>;
}

export interface SeatBatch {
  calls: ViewCall[];
  expect: number[];
  decode(results: readonly CallResult[]): SeatBatchRead;
}

/**
 * One batch: the block, then (if `event`) the event views, then `words`, then for each
 * of `nonceSeats` its nonce. Pair a nonce seat's word with it in the same batch.
 */
export function seatBatch(ledger: string, eventId: string, req: { event: boolean; words: readonly number[]; nonceSeats: readonly number[] }): SeatBatch {
  const calls: ViewCall[] = [{ target: ARBSYS_ADDRESS, data: ARB_BLOCK_NUMBER }];
  const expect: number[] = [32];
  const at = (target: string, sel: string, len: number, ...args: (string | number)[]) => {
    calls.push({ target, data: staticCall(sel, ...args) });
    expect.push(len);
  };
  if (req.event) {
    at(ledger, SEL.getEvent, 128, eventId);
    at(ledger, SEL.isSeated, 32, eventId);
    at(ledger, SEL.getEventStatus, 64, eventId);
    at(ledger, SEL.remaining, 32, eventId);
    at(MULTICALL3_ADDRESS, SEL.blockTimestamp, 32);
  }
  for (const w of req.words) at(ledger, SEL.seatWord, 32, eventId, w);
  for (const k of req.nonceSeats) at(ledger, SEL.seatNonces, 32, eventId, k);

  return {
    calls,
    expect,
    decode(results) {
      let i = 0;
      const next = () => results[i++] ?? null;
      const b = next();
      const out: SeatBatchRead = { block: b ? uintAt(b, 0) : null, words: new Map(), nonces: new Map() };
      if (req.event) {
        const [ev, seated, status, remaining, ts] = [next(), next(), next(), next(), next()];
        const seatedBool = seated ? boolAt(seated, 0) : null;
        const cancelled = status ? boolAt(status, 1) : null;
        out.event = ev && seatedBool !== null && status && cancelled !== null && remaining && ts
          ? {
            totalSupply: uintAt(ev, 0), nextSlot: uintAt(ev, 1), manifestRef: bytes32At(ev, 3),
            seated: seatedBool, eventEndTs: uintAt(status, 0), cancelled, remaining: uintAt(remaining, 0), blockTs: uintAt(ts, 0),
          }
          : null;
      }
      for (const w of req.words) { const r = next(); if (r) out.words.set(w, uintAt(r, 0)); }
      for (const k of req.nonceSeats) { const r = next(); if (r) out.nonces.set(k, uintAt(r, 0)); }
      return out;
    },
  };
}

export const seatWordCount = (seats: number): number => Math.ceil(seats / 256);
