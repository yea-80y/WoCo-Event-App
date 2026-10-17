/**
 * The door scanner's pack reads slot owners from chain. Scanners refresh it about
 * once a minute and again on any ticket they do not know, so every pack reading
 * every owner would be one RPC call per ticket sold, per phone, per refresh.
 *
 * Owners can move (the ledger's transferSlot), so they are remembered only for
 * OWNER_CACHE_MS after a full read. A slot the cache has not seen - a ticket sold
 * since - is always read now: that is what lets a late buyer in at the door.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { clearSlotOwnerCache, OWNER_CACHE_MS, slotOwners } from "../src/lib/checkin/slot-owners.js";

beforeEach(() => clearSlotOwnerCache());

function chain(owners: Record<number, string | null>) {
  const reads: number[] = [];
  return {
    reads,
    readSlot: async (slot: number) => {
      reads.push(slot);
      const owner = owners[slot];
      if (owner === undefined) throw new Error(`no slot ${slot}`);
      return owner;
    },
  };
}

const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);
const C = "0x" + "cc".repeat(20);
const D = "0x" + "dd".repeat(20);

test("a second pack inside the window reads no owner it already has", async () => {
  let t = 1_000_000;
  const c = chain({ 0: A, 1: B });
  assert.deepEqual(await slotOwners("evt", 2, c.readSlot, () => t), [A, B]);
  t += 5_000;
  assert.deepEqual(await slotOwners("evt", 2, c.readSlot, () => t), [A, B]);
  assert.deepEqual(c.reads, [0, 1]);
});

test("a ticket sold since the last pack is read at once, never hidden by the cache", async () => {
  let t = 1_000_000;
  const owners: Record<number, string | null> = { 0: A, 1: B };
  const c = chain(owners);
  await slotOwners("evt", 2, c.readSlot, () => t);
  owners[2] = C;
  owners[3] = D;
  t += 1_000;
  assert.deepEqual(await slotOwners("evt", 4, c.readSlot, () => t), [A, B, C, D]);
  assert.deepEqual(c.reads, [0, 1, 2, 3], "only the two new slots are read");
});

test("a transferred slot shows its new owner once the window has passed", async () => {
  let t = 1_000_000;
  const owners: Record<number, string | null> = { 0: A, 1: B };
  const c = chain(owners);
  await slotOwners("evt", 2, c.readSlot, () => t);
  owners[1] = D; // transferSlot
  t += OWNER_CACHE_MS - 1;
  assert.equal((await slotOwners("evt", 2, c.readSlot, () => t))[1], B, "still inside the window");
  t += 1;
  assert.equal((await slotOwners("evt", 2, c.readSlot, () => t))[1], D);
});

test("reading only new slots does not extend the window for the old ones", async () => {
  let t = 1_000_000;
  const owners: Record<number, string | null> = { 0: A };
  const c = chain(owners);
  await slotOwners("evt", 1, c.readSlot, () => t);
  for (let slot = 1; slot <= 3; slot++) {
    owners[slot] = C;
    t += 9_000;
    await slotOwners("evt", slot + 1, c.readSlot, () => t);
  }
  owners[0] = D; // transferred while new sales kept the pack busy
  t += OWNER_CACHE_MS - 27_000;
  assert.equal((await slotOwners("evt", 4, c.readSlot, () => t))[0], D,
    "30 s after the FULL read every slot is read again, however often new slots arrived");
});

test("a read that failed is read again next time, never remembered as no ticket", async () => {
  let t = 1_000_000;
  const owners: Record<number, string | null> = { 0: A, 1: null };
  const c = chain(owners);
  assert.deepEqual(await slotOwners("evt", 3, c.readSlot, () => t), [A, "", ""]);
  owners[1] = B;
  owners[2] = C;
  t += 1_000;
  assert.deepEqual(await slotOwners("evt", 3, c.readSlot, () => t), [A, B, C]);
  assert.deepEqual(c.reads, [0, 1, 2, 1, 2]);
});

test("series and contracts are kept apart", async () => {
  const t = 1_000_000;
  const one = chain({ 0: A });
  const two = chain({ 0: B });
  assert.deepEqual(await slotOwners("contract-1|evt", 1, one.readSlot, () => t), [A]);
  assert.deepEqual(await slotOwners("contract-2|evt", 1, two.readSlot, () => t), [B]);
});

test("two packs at once share one read", async () => {
  const t = 1_000_000;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const reads: number[] = [];
  const readSlot = async (slot: number) => {
    reads.push(slot);
    await gate;
    return A;
  };
  const first = slotOwners("evt", 3, readSlot, () => t);
  const second = slotOwners("evt", 3, readSlot, () => t);
  release();
  assert.deepEqual(await first, [A, A, A]);
  assert.deepEqual(await second, [A, A, A]);
  assert.deepEqual(reads, [0, 1, 2]);
});
