/**
 * The attendee slot ledger and writer (#546). Each test asserts a property whose
 * failure is silent and permanent: a reissued slot evicts a live order (a burn
 * of our own data), a slot not persisted before signing is unerasable after a
 * crash, a blob stored anywhere else can never be erased on its own.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EnvelopeWithBatchId } from "@ethersphere/bee-js";
import { Wallet, concat, getBytes, hexlify, keccak256, verifyMessage } from "ethers";

// The ledger resolves `.data` from cwd at import time, so redirect before import.
const dir = mkdtempSync(join(tmpdir(), "woco-attendee-slots-"));
process.chdir(dir);
const FEED_KEY = "33".repeat(32);
process.env.FEED_PRIVATE_KEY = FEED_KEY;

const ledger = await import("../src/lib/attendee-batch/ledger.js");
const writer = await import("../src/lib/attendee-batch/writer.js");
const { splitPayload, stamperKeyFromHex } = await import("../src/lib/attendee-batch/stamp.js");

const FILE = join(dir, ".data", "attendee-slots.json");
const STAMPER = stamperKeyFromHex("44".repeat(32));
const STAMPER_ADDRESS = new Wallet(`0x${"44".repeat(32)}`).address.toLowerCase();

function onDisk(): any {
  return JSON.parse(readFileSync(FILE, "utf-8"));
}

/** A fake 32-byte address in a chosen bucket, distinct per `n`. */
function addr(bucket: number, n: number): Uint8Array {
  const a = new Uint8Array(32);
  a[0] = bucket >> 8;
  a[1] = bucket & 0xff;
  a[31] = n;
  a[30] = n >> 8;
  return a;
}

let batchCounter = 0;
/** Register and activate a fresh batch; tests never share one. */
function freshBatch(depth = 17): string {
  const id = (++batchCounter).toString(16).padStart(64, "0");
  ledger.registerBatch(id, depth, STAMPER_ADDRESS, true);
  ledger.setActiveBatch(id);
  return id;
}

test("with no active batch, nothing is allocated and checkout is refused", () => {
  assert.notEqual(ledger.attendeeStoreRefusal(STAMPER_ADDRESS), null);
  assert.throws(() => ledger.allocateOrder(addr(1, 1), [addr(1, 1)], { kind: "checkout" }), ledger.AttendeeStoreUnavailableError);
});

test("a batch is only registered with the fresh assertion, once, at a sane depth", () => {
  const id = "ab".repeat(32);
  assert.throws(() => ledger.registerBatch(id, 20, STAMPER_ADDRESS, false));
  assert.throws(() => ledger.registerBatch(id, 16, STAMPER_ADDRESS, true));
  ledger.registerBatch(id, 20, STAMPER_ADDRESS, true);
  assert.throws(() => ledger.registerBatch(id, 20, STAMPER_ADDRESS, true));
});

test("a batch owned by a different key than the stamper refuses checkout", () => {
  const id = "cd".repeat(32);
  ledger.registerBatch(id, 20, "0x0000000000000000000000000000000000000001", true);
  ledger.setActiveBatch(id);
  assert.match(ledger.attendeeStoreRefusal(STAMPER_ADDRESS) ?? "", /different key/);
  freshBatch();
  assert.equal(ledger.attendeeStoreRefusal(STAMPER_ADDRESS), null);
});

test("an allocation is on disk before allocateOrder returns", () => {
  const batch = freshBatch();
  const { root } = ledger.allocateOrder(addr(7, 2), [addr(7, 1), addr(7, 2)], { kind: "checkout", eventId: "e1" });
  const file = onDisk();
  assert.equal(file.orders[root].state, "allocated");
  assert.deepEqual(file.orders[root].chunks.map((c: any) => c.slot), [0, 1]);
  assert.equal(file.batches[batch].next["7"], 2);
});

test("two orders in the same bucket never get the same slot", () => {
  freshBatch(18);
  const a = ledger.allocateOrder(addr(9, 1), [addr(9, 1)], { kind: "checkout" });
  const b = ledger.allocateOrder(addr(9, 2), [addr(9, 2)], { kind: "checkout" });
  assert.equal(a.record.chunks[0].slot, 0);
  assert.equal(b.record.chunks[0].slot, 1);
});

test("an order that does not fit is refused whole: no record, no counter moved", () => {
  const batch = freshBatch(17); // 2 slots per bucket
  ledger.allocateOrder(addr(5, 1), [addr(5, 1)], { kind: "checkout" });
  ledger.allocateOrder(addr(5, 2), [addr(5, 2)], { kind: "checkout" });
  const root = addr(5, 3);
  assert.throws(
    () => ledger.allocateOrder(root, [addr(6, 1), root], { kind: "checkout" }),
    ledger.AttendeeBucketFullError,
  );
  const file = onDisk();
  assert.equal(file.orders[hexlify(root).slice(2)], undefined);
  assert.equal(file.batches[batch].next["6"], undefined);
  assert.equal(file.batches[batch].next["5"], 2);
});

test("an order whose own chunks overfill a bucket is refused too", () => {
  freshBatch(17);
  const root = addr(4, 3);
  assert.throws(
    () => ledger.allocateOrder(root, [addr(4, 1), addr(4, 2), root], { kind: "checkout" }),
    ledger.AttendeeBucketFullError,
  );
});

test("after a restart the counters continue: no slot is ever handed out twice", () => {
  freshBatch(18);
  const first = ledger.allocateOrder(addr(11, 1), [addr(11, 1)], { kind: "checkout" });
  ledger._resetAttendeeLedgerForTests();
  const second = ledger.allocateOrder(addr(11, 2), [addr(11, 2)], { kind: "checkout" });
  assert.equal(first.record.chunks[0].slot, 0);
  assert.equal(second.record.chunks[0].slot, 1);
});

test("the same order twice gets the slots it already holds", () => {
  const batch = freshBatch(18);
  const a = ledger.allocateOrder(addr(12, 1), [addr(12, 1)], { kind: "checkout" });
  const b = ledger.allocateOrder(addr(12, 1), [addr(12, 1)], { kind: "checkout" });
  assert.deepEqual(b.record.chunks, a.record.chunks);
  assert.equal(onDisk().batches[batch].next["12"], 1);
});

test("records handed out are copies: editing one cannot change the ledger", () => {
  const batch = freshBatch(18);
  const { root, record } = ledger.allocateOrder(addr(16, 1), [addr(16, 1)], { kind: "checkout" });
  record.chunks[0].slot = 99;
  record.state = "burned";
  const read = ledger.getOrderRecord(root)!;
  read.chunks[0].ts = "00".repeat(8);
  ledger.getBatchRecord(batch)!.next["16"] = 0;
  const fresh = ledger.getOrderRecord(root)!;
  assert.equal(fresh.chunks[0].slot, 0);
  assert.equal(fresh.state, "allocated");
  assert.notEqual(fresh.chunks[0].ts, "00".repeat(8));
  assert.equal(ledger.getBatchRecord(batch)!.next["16"], 1);
});

test("an order reads as erased from the moment a burn is planned, before any upload", () => {
  freshBatch();
  const { root, record } = ledger.allocateOrder(addr(17, 1), [addr(17, 1)], { kind: "checkout" });
  assert.equal(ledger.isOrderErased(root), false);
  const planned = ledger.planChunkBurn(root, record.chunks[0].address);
  assert.equal(ledger.isOrderErased(root), true);
  assert.equal(ledger.planChunkBurn(root, record.chunks[0].address), planned, "a second plan returns the first");
  assert.ok(BigInt(`0x${planned}`) > BigInt(`0x${record.chunks[0].ts}`));
});

test("the root must be the last chunk", () => {
  freshBatch();
  assert.throws(() => ledger.allocateOrder(addr(13, 9), [addr(13, 9), addr(13, 1)], { kind: "checkout" }));
});

test("a burn must be newer than the stamp it replaces; the order is erased once every chunk is", () => {
  freshBatch();
  const { root, record } = ledger.allocateOrder(addr(14, 2), [addr(14, 1), addr(14, 2)], { kind: "checkout" });
  const [c1, c2] = record.chunks;
  assert.throws(() => ledger.markChunkBurned(root, c1.address, c1.ts));
  const newer = (BigInt(`0x${c1.ts}`) + 1n).toString(16).padStart(16, "0");
  assert.equal(ledger.isOrderErased(root), false);
  ledger.markChunkBurned(root, c1.address, newer);
  // Erased to every reader from the first burned chunk; the state follows the last.
  assert.equal(ledger.isOrderErased(root), true);
  assert.equal(ledger.getOrderRecord(root)?.state, "allocated");
  ledger.markChunkBurned(root, c2.address, newer);
  assert.equal(ledger.getOrderRecord(root)?.state, "burned");
  assert.throws(() => ledger.allocateOrder(addr(14, 2), [addr(14, 1), addr(14, 2)], { kind: "checkout" }));
});

// ── writer ────────────────────────────────────────────────────────────────

interface Upload {
  envelope: EnvelopeWithBatchId;
  body: Uint8Array;
  allocatedOnDisk: boolean;
}

function recordingUploader(uploads: Upload[], lie = false): writer.ChunkUploader {
  return async (envelope, body) => {
    const address = addressOfBody(body);
    const allocatedOnDisk = Object.values(onDisk().orders).some((o: any) =>
      o.chunks.some((c: any) => c.address === address),
    );
    uploads.push({ envelope, body, allocatedOnDisk });
    return lie ? "ff".repeat(32) : address;
  };
}

/**
 * The content address of span+payload, from the Swarm BMT definition and nothing
 * else: zero-pad to 4096, hash 32-byte segments pairwise up to one root, then
 * keccak256(span || root). Independent of the cafe-utility code the writer uses.
 */
function addressOfBody(body: Uint8Array): string {
  const data = new Uint8Array(4096);
  data.set(body.slice(8));
  let level: Uint8Array[] = [];
  for (let i = 0; i < 4096; i += 32) level.push(data.slice(i, i + 32));
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(getBytes(keccak256(concat([level[i], level[i + 1]]))));
    level = next;
  }
  return keccak256(concat([body.slice(0, 8), level[0]])).slice(2);
}

/** Non-repeating bytes, like a sealed box: every 4 KiB chunk differs. */
function noise(n: number): Uint8Array {
  const out = new Uint8Array(n);
  let block = getBytes(keccak256(new TextEncoder().encode("noise")));
  for (let i = 0; i < n; i += 32) {
    out.set(block.slice(0, Math.min(32, n - i)), i);
    block = getBytes(keccak256(block));
  }
  return out;
}

const deps = (uploads: Upload[], lie = false): writer.StoreAttendeeDeps => ({
  stamper: () => STAMPER,
  upload: recordingUploader(uploads, lie),
});

test("the writer stores an order under our stamps, allocated on disk before any upload, root last", async () => {
  const batch = freshBatch(20);
  const payload = noise(9000);
  const uploads: Upload[] = [];
  const ref = await writer.storeAttendeePayload(payload, { kind: "checkout", eventId: "e2" }, deps(uploads));

  const { root, chunks } = await splitPayload(payload);
  assert.equal(ref, Buffer.from(root).toString("hex"));
  assert.equal(uploads.length, chunks.length);
  assert.ok(uploads.every((u) => u.allocatedOnDisk), "every upload happened after its slot was persisted");
  assert.equal(addressOfBody(uploads[uploads.length - 1].body), ref, "root uploaded last");

  for (const u of uploads) {
    const address = getBytes(`0x${addressOfBody(u.body)}`);
    const digest = keccak256(concat([address, getBytes(`0x${batch}`), u.envelope.index, u.envelope.timestamp]));
    assert.equal(verifyMessage(getBytes(digest), hexlify(u.envelope.signature)).toLowerCase(), STAMPER_ADDRESS);
  }
  assert.equal(ledger.getOrderRecord(ref)?.state, "stored");
});

test("identical chunks inside one order are stamped once", async () => {
  freshBatch(20);
  const payload = new Uint8Array(9000).map((_, i) => (i * 31) & 255); // repeats every 256 bytes
  const uploads: Upload[] = [];
  const ref = await writer.storeAttendeePayload(payload, { kind: "checkout" }, deps(uploads));
  const { chunks } = await splitPayload(payload);
  const distinct = new Set(chunks.map((c) => Buffer.from(c.address).toString("hex")));
  assert.equal(chunks.length, 4);
  assert.equal(distinct.size, 3);
  assert.equal(uploads.length, 3);
  assert.equal(ledger.getOrderRecord(ref)?.chunks.length, 3);
});

test("if bee computes a different address the order is not marked stored", async () => {
  freshBatch(20);
  const payload = new TextEncoder().encode("different address test");
  await assert.rejects(writer.storeAttendeePayload(payload, { kind: "checkout" }, deps([], true)));
  const { root } = await splitPayload(payload);
  assert.equal(ledger.getOrderRecord(Buffer.from(root).toString("hex"))?.state, "allocated");
});

test("a retry after a failed upload re-sends identical stamps in the same slots", async () => {
  freshBatch(20);
  const payload = new Uint8Array(5000).map((_, i) => (i * 7) & 255);
  let calls = 0;
  const failing: writer.StoreAttendeeDeps = {
    stamper: () => STAMPER,
    upload: async () => {
      calls++;
      throw Object.assign(new Error("bad request"), { status: 400 });
    },
  };
  await assert.rejects(writer.storeAttendeePayload(payload, { kind: "checkout" }, failing));
  assert.equal(calls, 1);
  const first = ledger.getOrderRecord(Buffer.from((await splitPayload(payload)).root).toString("hex"));
  const uploads: Upload[] = [];
  await writer.storeAttendeePayload(payload, { kind: "checkout" }, deps(uploads));
  const second = ledger.getOrderRecord(Buffer.from((await splitPayload(payload)).root).toString("hex"));
  assert.deepEqual(second?.chunks.map((c) => [c.slot, c.ts]), first?.chunks.map((c) => [c.slot, c.ts]));
  assert.equal(second?.state, "stored");
});

test("the writer refuses empty and oversize blobs, and has no stamper-less path", async () => {
  freshBatch(20);
  await assert.rejects(writer.storeAttendeePayload(new Uint8Array(0), { kind: "checkout" }, deps([])));
  await assert.rejects(writer.storeAttendeePayload(new Uint8Array(16 * 1024 + 1), { kind: "checkout" }, deps([])));
  await assert.rejects(
    writer.storeAttendeePayload("x", { kind: "checkout" }, { stamper: () => null, upload: recordingUploader([]) }),
    ledger.AttendeeStoreUnavailableError,
  );
});

test("the stamper key must not be the feed key", () => {
  process.env.ATTENDEE_STAMPER_PRIVATE_KEY = FEED_KEY;
  writer._resetAttendeeStamperForTests();
  assert.throws(() => writer.getAttendeeStamper(), /must not be the same key/);
  // Checkout gets a refusal, not an exception.
  assert.match(writer.attendeeCheckoutRefusal() ?? "", /misconfigured.*must not be the same key/);
  process.env.ATTENDEE_STAMPER_PRIVATE_KEY = "not a key";
  writer._resetAttendeeStamperForTests();
  assert.match(writer.attendeeCheckoutRefusal() ?? "", /misconfigured/);
  process.env.ATTENDEE_STAMPER_PRIVATE_KEY = "44".repeat(32);
  writer._resetAttendeeStamperForTests();
  assert.equal(writer.attendeeStamperAddress(), STAMPER_ADDRESS.toLowerCase());
  delete process.env.ATTENDEE_STAMPER_PRIVATE_KEY;
  writer._resetAttendeeStamperForTests();
});

test("the writer refuses a batch owned by a different key, before signing anything", async () => {
  const id = "9a".repeat(32);
  ledger.registerBatch(id, 20, "0x0000000000000000000000000000000000000002", true);
  ledger.setActiveBatch(id);
  const uploads: Upload[] = [];
  await assert.rejects(
    writer.storeAttendeePayload(noise(100), { kind: "checkout" }, deps(uploads)),
    ledger.AttendeeStoreUnavailableError,
  );
  assert.equal(uploads.length, 0);
  freshBatch(20);
});

test("a ledger write that fails throws and leaves no allocation behind", () => {
  const batch = freshBatch(18);
  chmodSync(join(dir, ".data"), 0o500);
  try {
    assert.throws(() => ledger.allocateOrder(addr(21, 1), [addr(21, 1)], { kind: "checkout" }), ledger.AttendeeStoreUnavailableError);
  } finally {
    chmodSync(join(dir, ".data"), 0o700);
  }
  assert.equal(ledger.getOrderRecord(hexlify(addr(21, 1)).slice(2)), null);
  const next = ledger.allocateOrder(addr(21, 2), [addr(21, 2)], { kind: "checkout" });
  assert.equal(next.record.chunks[0].slot, 0);
  assert.equal(onDisk().batches[batch].next["21"], 1);
});

// Last: it leaves the ledger file unreadable.
test("a present but unreadable ledger refuses everything and is not overwritten", () => {
  writeFileSync(FILE, "{ not json");
  ledger._resetAttendeeLedgerForTests();
  assert.match(ledger.attendeeStoreRefusal(STAMPER_ADDRESS) ?? "", /unreadable/);
  assert.throws(() => ledger.allocateOrder(addr(15, 1), [addr(15, 1)], { kind: "checkout" }), ledger.AttendeeStoreUnavailableError);
  assert.throws(() => ledger.registerBatch("ef".repeat(32), 20, STAMPER_ADDRESS, true));
  assert.equal(readFileSync(FILE, "utf-8"), "{ not json");
});
