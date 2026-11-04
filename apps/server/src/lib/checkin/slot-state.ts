/**
 * Ledger2 slots for the door scanner's pack (docs/SEATING.md "Door + tickets"): one
 * Multicall3 batch reads a run of slots - `slotOwner` and, for a seated series,
 * `seatOf` - plus ArbSys `arbBlockNumber`, so a slot's owner and seat come from one
 * block and the cache (`slot-owners.ts`) can keep the highest. A batch with no block is
 * dropped whole.
 *
 * `isSeated` is fixed at registration, so it is read until one read succeeds and then
 * remembered; a lagging replica that does not know the event yet fails the call
 * (EventNotFound), which reads as unknown, never as "not seated".
 */

import {
  ARBSYS_ADDRESS, ARB_BLOCK_NUMBER, multicall, staticCall, uintAt, type CallResult, type ViewCall,
} from "@woco/shared/chain/multicall";
import { NO_SEAT_INDEX } from "@woco/shared";
import { LEDGER2_NO_SEAT } from "@woco/shared/ticket/ledger2-terms";
import { getChainRpcUrl, type EventContractTarget } from "../chain/event-contract.js";
import { cachedSlots, type SlotRead } from "./slot-owners.js";

const SEL = { slotOwner: "17e7f2ff", seatOf: "4eb29918", isSeated: "b2db691d" } as const;

/** Slots per batch: 1,024 calls for a seated series, ~96 KB of answer. */
export const SLOTS_PER_BATCH = 512;
const BATCH_CONCURRENCY = 4;

export interface SlotStates {
  /** Per slot: lowercase owner, "" for none, null when never read. */
  owners: (string | null)[];
  /** Per slot (when seats were asked for): seat index, NO_SEAT_INDEX, or null when never read. */
  seats: (number | null)[];
  /** The ledger's `isSeated`; null when it could not be read. */
  seated: boolean | null;
}

export type MulticallFn = (chainId: number, calls: readonly ViewCall[], expect: readonly number[]) => Promise<CallResult[]>;

const liveCall: MulticallFn = (chainId, calls, expect) => multicall(getChainRpcUrl(chainId), calls, expect);

interface SlotValue {
  owner: string;
  seat: number | null;
}

/** `isSeated` by contract + event, once read. */
const seatedKnown = new Map<string, boolean>();

/**
 * `nextSlot` null: the event could not be read - the cache answers, null up to `supply`.
 */
export async function readSlotStates(
  contract: Pick<EventContractTarget, "chainId" | "address">,
  onChainEventId: string,
  nextSlot: number | null,
  opts: { seats: boolean; supply: number },
  call: MulticallFn = liveCall,
  now: () => number = Date.now,
): Promise<SlotStates> {
  const ledger = contract.address.toLowerCase();
  const eventKey = `${contract.chainId}:${ledger}|${onChainEventId.toLowerCase()}`;
  const slots = await cachedSlots<SlotValue>(`${eventKey}|${opts.seats ? "seats" : "owners"}`, nextSlot, opts.supply, async (toRead) => {
    const chunks: number[][] = [];
    for (let i = 0; i < toRead.length; i += SLOTS_PER_BATCH) chunks.push(toRead.slice(i, i + SLOTS_PER_BATCH));
    const out = new Map<number, SlotRead<SlotValue>>();
    let next = 0;
    const worker = async () => {
      while (next < chunks.length) {
        const i = next++;
        await readBatch(call, contract.chainId, ledger, onChainEventId, chunks[i], opts.seats, i === 0 ? eventKey : null, out);
      }
    };
    await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, chunks.length) }, worker));
    return out;
  }, now);
  // Nothing to read this time and `isSeated` still unknown: ask for it alone.
  if (!seatedKnown.has(eventKey)) await readBatch(call, contract.chainId, ledger, onChainEventId, [], false, eventKey, new Map());
  return {
    owners: slots.map((s) => (s ? s.owner : null)),
    seats: opts.seats ? slots.map((s) => (s ? s.seat : null)) : [],
    seated: seatedKnown.get(eventKey) ?? null,
  };
}

/** One batch into `out`; `seatedFor` set = also ask `isSeated` while it is unknown. */
async function readBatch(
  call: MulticallFn,
  chainId: number,
  ledger: string,
  eventId: string,
  slots: readonly number[],
  seats: boolean,
  seatedFor: string | null,
  out: Map<number, SlotRead<SlotValue>>,
): Promise<void> {
  const askSeated = seatedFor !== null && !seatedKnown.has(seatedFor);
  const calls: ViewCall[] = [{ target: ARBSYS_ADDRESS, data: ARB_BLOCK_NUMBER }];
  if (askSeated) calls.push({ target: ledger, data: staticCall(SEL.isSeated, eventId) });
  for (const slot of slots) {
    calls.push({ target: ledger, data: staticCall(SEL.slotOwner, eventId, slot) });
    if (seats) calls.push({ target: ledger, data: staticCall(SEL.seatOf, eventId, slot) });
  }
  let results: CallResult[];
  try {
    results = await call(chainId, calls, calls.map(() => 32));
  } catch {
    return;
  }
  let i = 0;
  const take = () => results[i++] ?? null;
  const b = take();
  if (!b) return; // no block, no ordering: the batch is dropped rather than risk a stale read
  const block = uintAt(b, 0);
  if (askSeated) {
    const r = take();
    if (r) seatedKnown.set(seatedFor!, uintAt(r, 0) === 1n);
  }
  for (const slot of slots) {
    const o = take();
    const s = seats ? take() : null;
    if (o && (!seats || s)) out.set(slot, { value: { owner: ownerOf(o), seat: s ? seatIndexOf(uintAt(s, 0)) : null }, block });
  }
}

/**
 * The seat of each of `slots` now (seat index or NO_SEAT_INDEX), one batch per
 * SLOTS_PER_BATCH. Throws unless every one was read: callers would otherwise show a
 * buyer a seat that is not theirs.
 */
export async function readSeatIndexes(
  contract: Pick<EventContractTarget, "chainId" | "address">,
  onChainEventId: string,
  slots: readonly number[],
  call: MulticallFn = liveCall,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (let i = 0; i < slots.length; i += SLOTS_PER_BATCH) {
    const chunk = slots.slice(i, i + SLOTS_PER_BATCH);
    const calls = chunk.map((slot) => ({ target: contract.address, data: staticCall(SEL.seatOf, onChainEventId, slot) }));
    const results = await call(contract.chainId, calls, calls.map(() => 32));
    chunk.forEach((slot, j) => {
      const r = results[j];
      if (!r) throw new Error(`seat of slot ${slot} could not be read`);
      out.set(slot, seatIndexOf(uintAt(r, 0)));
    });
  }
  return out;
}

function ownerOf(word: CallResult): string {
  const hex = Array.from(word!.slice(12, 32), (x) => x.toString(16).padStart(2, "0")).join("");
  return /^0+$/.test(hex) ? "" : `0x${hex}`;
}

/** NO_SEAT, and anything no plan could hold, reads as no seat: the door refuses it. */
function seatIndexOf(v: bigint): number {
  return v === LEDGER2_NO_SEAT || v > BigInt(Number.MAX_SAFE_INTEGER) ? NO_SEAT_INDEX : Number(v);
}

/** Tests only. */
export function clearSeatedMemo(): void {
  seatedKnown.clear();
}
