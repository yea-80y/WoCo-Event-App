/**
 * What the door scanner's pack knows about each slot, read from chain with a short
 * memory. One cache for every contract: the caller supplies a batch read (one RPC call
 * per slot on older contracts, Multicall3 batches with owner + seat on ledger2,
 * `slot-state.ts`).
 *
 * Scanners refresh their pack about once a minute, and again on a ticket they do not
 * know, so several door phones at a few-hundred-ticket event would otherwise be a
 * steady stream of reads for slots that have not changed.
 *
 * Slots are NOT write-once (a transfer moves the owner, an organiser-signed move the
 * seat), so a cached slot is trusted for OWNER_CACHE_MS from the full read that
 * produced it, then every slot is read again. New slots are never cached-away: the
 * caller passes the chain's current `nextSlot`, read fresh on every pack, and any slot
 * the cache has not seen is read now - a ticket bought a second ago must verify on the
 * scanner's next refresh.
 *
 * Unread is not "none": a slot whose read failed keeps what it last read for up to
 * STALE_MAX_MS after that read (an RPC blip does not stop the door) and is read again on
 * every pack; past that, and for a slot never read, it comes back `null`, which the
 * scanner shows as "couldn't confirm", never as "no ticket". The bound is what keeps a
 * long outage from admitting on an owner or seat the ledger has since moved. And the
 * highest block wins: a read from a lower block than the one held is dropped, so a
 * lagging RPC replica cannot hand back a transferred ticket's old owner.
 */
import { mapWithConcurrency, SLOT_READ_CONCURRENCY } from "../util/concurrency.js";

export const OWNER_CACHE_MS = 30_000;
/** How long a slot's last good read stands in for reads that fail. */
export const STALE_MAX_MS = 10 * 60 * 1000;
/** A series nobody has packed for this long is forgotten. */
const IDLE_FORGET_MS = 6 * 60 * 60 * 1000;

/** One slot as a batch read it; `block` 0n when the read carries no block. */
export interface SlotRead<T> {
  value: T;
  block: bigint;
}

/** Slots it could read; a slot missing from the map failed. Must not throw for one slot. */
export type SlotBatchRead<T> = (slots: readonly number[]) => Promise<Map<number, SlotRead<T>>>;

interface Entry {
  /** `at`: when that slot was last read successfully. */
  slots: Array<(SlotRead<unknown> & { at: number }) | undefined>;
  /** When every slot was last read: a transfer shows within OWNER_CACHE_MS of it. */
  fullReadAt: number;
  usedAt: number;
  /** Slots whose last read failed: whatever they hold is read again on every pack. */
  retry: Set<number>;
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

/**
 * Per slot, the value read, or null where no read has succeeded. `key` identifies one
 * series on one contract (and what is read). `nextSlot` null: the event could not be
 * read, so nothing is read; the cache's slots come back, null elsewhere up to `supply`.
 */
export async function cachedSlots<T>(
  key: string,
  nextSlot: number | null,
  supply: number,
  readBatch: SlotBatchRead<T>,
  now: () => number = Date.now,
): Promise<(T | null)[]> {
  // Two scanners refreshing together share one read instead of doubling it.
  const running = inflight.get(key);
  if (running) await running.catch(() => undefined);
  const job = read(key, nextSlot, supply, readBatch, now);
  inflight.set(key, job);
  try {
    return await job;
  } finally {
    if (inflight.get(key) === job) inflight.delete(key);
  }
}

async function read<T>(
  key: string,
  nextSlot: number | null,
  supply: number,
  readBatch: SlotBatchRead<T>,
  now: () => number,
): Promise<(T | null)[]> {
  const started = now();
  sweep(started);
  const entry: Entry = cache.get(key) ?? { slots: [], fullReadAt: 0, usedAt: started, retry: new Set() };
  entry.usedAt = started;
  cache.set(key, entry);
  // Never shorter than the slots already held: `nextSlot` comes from its own read, maybe a
  // replica behind the one that read the newest ticket, and on chain it never goes down.
  const length = Math.max(nextSlot ?? supply, entry.slots.length);

  if (nextSlot !== null) {
    const fresh = started - entry.fullReadAt < OWNER_CACHE_MS;
    const toRead: number[] = [];
    for (let slot = 0; slot < nextSlot; slot++) {
      if (!fresh || !entry.slots[slot] || entry.retry.has(slot)) toRead.push(slot);
    }
    const got = toRead.length ? await readBatch(toRead).catch(() => new Map<number, SlotRead<T>>()) : new Map();
    for (const slot of toRead) {
      const r = got.get(slot);
      if (!r) {
        entry.retry.add(slot);
        continue;
      }
      const held = entry.slots[slot];
      if (held && held.block > r.block) {
        // A lagging replica: dropped, and it vouches for nothing newer - the held state
        // keeps its own clock (STALE_MAX_MS) and the slot is read again.
        entry.retry.add(slot);
        continue;
      }
      entry.retry.delete(slot);
      entry.slots[slot] = { ...r, at: started };
    }
    if (!fresh) entry.fullReadAt = started;
  }
  return Array.from({ length }, (_, slot) => {
    const s = entry.slots[slot];
    return s && started - s.at <= STALE_MAX_MS ? (s.value as T) : null;
  });
}

function sweep(at: number): void {
  for (const [key, entry] of cache) if (at - entry.usedAt >= IDLE_FORGET_MS) cache.delete(key);
}

/**
 * Owners on contracts without seats: `readSlot` returns the slot's owner ("" or the
 * zero address when nobody holds it) and throws when the read failed. Ledger2 series
 * use `slot-state.ts`.
 */
export function slotOwners(
  key: string,
  nextSlot: number | null,
  readSlot: (slot: number) => Promise<string>,
  now: () => number = Date.now,
  supply = 0,
): Promise<(string | null)[]> {
  return cachedSlots(key, nextSlot, supply, async (slots) => {
    const out = new Map<number, SlotRead<string>>();
    await mapWithConcurrency([...slots], SLOT_READ_CONCURRENCY, async (slot) => {
      try {
        out.set(slot, { value: (await readSlot(slot)).toLowerCase(), block: 0n });
      } catch {
        // missing from the map = failed; read again on the next pack
      }
    });
    return out;
  }, now);
}

/** Tests only. */
export function clearSlotOwnerCache(): void {
  cache.clear();
  inflight.clear();
}
