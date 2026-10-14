/**
 * Slot owners for the door scanner's pack, read from chain with a short memory.
 *
 * Every `/pack` used to read every slot owner (one RPC call per ticket sold).
 * Scanners now refresh their pack about once a minute, and again on a ticket
 * they do not know, so several door phones at a few-hundred-ticket event would
 * otherwise be a steady stream of reads for owners that have not changed.
 *
 * Owners are NOT write-once: the ledger's `transferSlot` / `transferSlotWithSignature`
 * move a claimed slot. So a cached owner is trusted for OWNER_CACHE_MS from the
 * full read that produced it, then every slot is read again. New slots are never
 * cached-away: the caller passes the chain's current `nextSlot`, read fresh on
 * every pack, and any slot the cache has not seen is read now - a ticket bought
 * a second ago must verify on the scanner's next refresh. A read that failed is
 * re-read on the next pack rather than remembered as "no ticket".
 */
import { mapWithConcurrency, SLOT_READ_CONCURRENCY } from "../util/concurrency.js";

export const OWNER_CACHE_MS = 30_000;

/** `owners[slot]` lowercase, or "" where the read failed. */
interface Entry {
  owners: string[];
  /** When every slot was last read: a transfer shows within OWNER_CACHE_MS of it. */
  fullReadAt: number;
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<string[]>>();

/**
 * `readSlot` returns the slot's owner, or null when the read failed. `key`
 * identifies one series on one contract.
 */
export async function slotOwners(
  key: string,
  nextSlot: number,
  readSlot: (slot: number) => Promise<string | null>,
  now: () => number = Date.now,
): Promise<string[]> {
  // Two scanners refreshing together share one read instead of doubling it.
  const running = inflight.get(key);
  if (running) await running.catch(() => undefined);

  const job = read(key, nextSlot, readSlot, now);
  inflight.set(key, job);
  try {
    return await job;
  } finally {
    if (inflight.get(key) === job) inflight.delete(key);
  }
}

async function read(
  key: string,
  nextSlot: number,
  readSlot: (slot: number) => Promise<string | null>,
  now: () => number,
): Promise<string[]> {
  const started = now();
  sweep(started);
  const entry = cache.get(key);
  const fresh = entry !== undefined && started - entry.fullReadAt < OWNER_CACHE_MS;

  const owners = Array.from({ length: nextSlot }, (_, slot) => (fresh ? entry.owners[slot] ?? "" : ""));
  const toRead = owners.flatMap((owner, slot) => (owner ? [] : [slot]));
  await mapWithConcurrency(toRead, SLOT_READ_CONCURRENCY, async (slot) => {
    owners[slot] = (await readSlot(slot).catch(() => null)) ?? "";
  });

  cache.set(key, { owners, fullReadAt: fresh ? entry.fullReadAt : started });
  return owners;
}

function sweep(at: number): void {
  for (const [key, entry] of cache) {
    if (at - entry.fullReadAt >= OWNER_CACHE_MS) cache.delete(key);
  }
}

/** Tests only. */
export function clearSlotOwnerCache(): void {
  cache.clear();
  inflight.clear();
}
