/**
 * What the organiser's Seats tab and order rows read (S6), all from the browser: the
 * seat map with the organiser's OWN seat state (their feed, read thoroughly), where
 * every ticket sits now (`seatOf`, one batch per 512 tickets), and the seats a change
 * emptied (`SlotReseated` logs from the ledger's deploy block, then those seats' bits
 * and nonces in one batch). Nothing here goes through our server but the live holds
 * list the map already reads.
 *
 * Pure pieces take their IO so they are tested without a network; `live*` wires them.
 */

import { LEDGER2_NO_SEAT } from "@woco/shared/ticket/ledger2-terms";
import type { CallResult, ViewCall } from "@woco/shared/chain/multicall";

export type MulticallFn = (calls: readonly ViewCall[], expect: readonly number[]) => Promise<CallResult[]>;

/** A ticket's seat: an index, or -1 for none. */
export const NO_SEAT = -1;

/**
 * Every minted ticket's seat now. `complete` false when a batch did not answer: the
 * missing tickets are absent from `seats`, never read as seatless.
 */
export async function readTicketSeats(
  call: MulticallFn,
  ledger: string,
  onChainEventId: string,
  nextSlot: number,
): Promise<{ seats: Map<number, number>; complete: boolean }> {
  const { slotSeatsBatch, SLOT_SEATS_PER_BATCH } = await import("@woco/shared/seating/chain");
  const seats = new Map<number, number>();
  let complete = true;
  const chunks: number[][] = [];
  for (let s = 0; s < nextSlot; s += SLOT_SEATS_PER_BATCH) {
    chunks.push(Array.from({ length: Math.min(SLOT_SEATS_PER_BATCH, nextSlot - s) }, (_, i) => s + i));
  }
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const slots = chunks[next++]!;
      const b = slotSeatsBatch(ledger, onChainEventId, slots);
      try {
        const r = b.decode(await call(b.calls, b.expect));
        if (r.block === null || r.seats.size < slots.length) complete = false;
        for (const [slot, v] of r.seats) seats.set(slot, v === LEDGER2_NO_SEAT || v > BigInt(Number.MAX_SAFE_INTEGER) ? NO_SEAT : Number(v));
      } catch {
        complete = false;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, chunks.length) }, worker));
  return { seats, complete };
}

/** One move the ledger logged: ticket `slot` from `from` to `to` (-1 = no seat). */
export interface SeatMove {
  slot: number;
  from: number;
  to: number;
  block: number;
}

export interface MoveLogIO {
  latestBlock(): Promise<number>;
  /** `SlotReseated` logs for the event in [from, to]. Throws when the page cannot be read. */
  moves(fromBlock: number, toBlock: number): Promise<SeatMove[]>;
}

/** Every move of the event's tickets, oldest first. `complete` false if a page failed. */
export async function scanSeatMoves(io: MoveLogIO, deployBlock: number): Promise<{ moves: SeatMove[]; complete: boolean }> {
  const { logScanWindows } = await import("@woco/shared/chain/log-windows");
  const latest = await io.latestBlock();
  const moves: SeatMove[] = [];
  let complete = true;
  for (const [from, to] of logScanWindows(deployBlock, latest)) {
    try {
      moves.push(...(await io.moves(from, to)));
    } catch {
      complete = false;
    }
  }
  moves.sort((a, b) => a.block - b.block);
  return { moves, complete };
}

/**
 * Seats a change emptied that are not back on sale: a seat some move left, whose bit is
 * clear now, whose nonce is above 0 and not the one the organiser confirmed. Read in
 * ONE batch (bits and nonces at one block): a seat filled again between two reads
 * would otherwise be offered back on sale.
 */
export async function readEmptiedSeats(
  call: MulticallFn,
  ledger: string,
  onChainEventId: string,
  moves: readonly SeatMove[],
  confirmed: ReadonlyMap<number, number>,
): Promise<Map<number, number> | null> {
  const left = [...new Set(moves.map((m) => m.from).filter((s) => s >= 0))].sort((a, b) => a - b);
  const out = new Map<number, number>();
  if (left.length === 0) return out;
  const { seatBatch } = await import("@woco/shared/seating/chain");
  const words = [...new Set(left.map((k) => k >> 8))];
  const b = seatBatch(ledger, onChainEventId, { event: false, words, nonceSeats: left });
  let r;
  try {
    r = b.decode(await call(b.calls, b.expect));
  } catch {
    return null;
  }
  if (r.block === null) return null;
  for (const k of left) {
    const w = r.words.get(k >> 8);
    const n = r.nonces.get(k);
    if (w === undefined || n === undefined) return null;
    const taken = ((w >> BigInt(k & 255)) & 1n) === 1n;
    if (!taken && n > 0n && confirmed.get(k) !== Number(n)) out.set(k, Number(n));
  }
  return out;
}

/** The ticket that sits in each seat now (seat -> slot). */
export function slotsBySeat(seats: ReadonlyMap<number, number>): Map<number, number> {
  const out = new Map<number, number>();
  for (const [slot, seat] of seats) if (seat >= 0) out.set(seat, slot);
  return out;
}

/** The seat a ticket was in before its latest move, for "moved from" (null: never moved). */
export function movedFrom(moves: readonly SeatMove[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const m of moves) if (m.from >= 0) out.set(m.slot, m.from);
  return out;
}

// ── Live wiring ──────────────────────────────────────────────────────────────

const SLOT_RESEATED = "event SlotReseated(bytes32 indexed eventId, uint256 indexed slot, uint256 fromSeat, uint256 toSeat)";

export async function liveMulticall(): Promise<MulticallFn | null> {
  const [{ seatMapRpcUrl }, { multicall }] = await Promise.all([
    import("../../seating/seat-map-source.js"),
    import("@woco/shared/chain/multicall"),
  ]);
  const rpc = seatMapRpcUrl();
  return rpc ? (calls, expect) => multicall(rpc, calls, expect) : null;
}

/** `SlotReseated` pages from the RPCs the app's other chain scans use, in turn. */
export async function liveMoveLogIO(ledger: string, onChainEventId: string): Promise<MoveLogIO> {
  const [{ createPublicClient, http, parseAbiItem }, { ownerScanRpcUrls }, { KERNEL_CHAIN }] = await Promise.all([
    import("viem"),
    import("../../auth/owned-accounts-scan.js"),
    import("../../auth/kernel-account.js"),
  ]);
  const clients = ownerScanRpcUrls().map((url) => createPublicClient({ chain: KERNEL_CHAIN, transport: http(url, { timeout: 20_000 }) }));
  const event = parseAbiItem(SLOT_RESEATED);
  const seat = (v: bigint) => (v === LEDGER2_NO_SEAT ? NO_SEAT : Number(v));
  return {
    latestBlock: async () => {
      for (const c of clients) {
        try {
          return Number(await c.getBlockNumber());
        } catch {
          // next endpoint
        }
      }
      throw new Error("no endpoint answered");
    },
    moves: async (fromBlock, toBlock) => {
      let last: unknown = null;
      for (const c of clients) {
        try {
          // An endpoint behind the page's end serves what it has with no error: refused.
          if ((await c.getBlockNumber()) < BigInt(toBlock)) throw new Error("endpoint behind");
          const logs = await c.getLogs({
            address: ledger as `0x${string}`, event, args: { eventId: onChainEventId as `0x${string}` },
            fromBlock: BigInt(fromBlock), toBlock: BigInt(toBlock),
          });
          return logs.map((l) => ({
            slot: Number(l.args.slot), from: seat(l.args.fromSeat as bigint), to: seat(l.args.toSeat as bigint), block: Number(l.blockNumber),
          }));
        } catch (e) {
          last = e;
        }
      }
      throw last instanceof Error ? last : new Error("page unreadable");
    },
  };
}
