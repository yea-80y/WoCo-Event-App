/**
 * Burning an attendee order (#546). A burn that lands in the wrong slot evicts
 * someone else's order and leaves this one; a burn with an older timestamp is
 * refused by every storer and erases nothing; a burn that skips a chunk leaves
 * it fetchable by address. None of these would show up as an error.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EnvelopeWithBatchId } from "@ethersphere/bee-js";
import { Wallet, concat, getBytes, hashMessage, hexlify, keccak256, recoverAddress, verifyMessage } from "ethers";

const dir = mkdtempSync(join(tmpdir(), "woco-attendee-burn-"));
process.chdir(dir);
process.env.FEED_PRIVATE_KEY = "33".repeat(32);

const ledger = await import("../src/lib/attendee-batch/ledger.js");
const writer = await import("../src/lib/attendee-batch/writer.js");
const burn = await import("../src/lib/attendee-batch/burn.js");
const { bucketOf, decodeTimestampNs, stamperKeyFromHex } = await import("../src/lib/attendee-batch/stamp.js");

const STAMPER = stamperKeyFromHex("44".repeat(32));
const STAMPER_ADDRESS = new Wallet(`0x${"44".repeat(32)}`).address.toLowerCase();

let batchCounter = 0;
function freshBatch(owner = STAMPER_ADDRESS): string {
  const id = (++batchCounter).toString(16).padStart(64, "a");
  ledger.registerBatch(id, 20, owner, true, new Date(Date.now() + 30 * 86400_000).toISOString());
  ledger.setActiveBatch(id);
  return id;
}

function noise(n: number, seed: string): Uint8Array {
  const out = new Uint8Array(n);
  let block = getBytes(keccak256(new TextEncoder().encode(seed)));
  for (let i = 0; i < n; i += 32) {
    out.set(block.slice(0, Math.min(32, n - i)), i);
    block = getBytes(keccak256(block));
  }
  return out;
}

/** Store an order through the real writer with an honest fake bee. */
async function storeOrder(size: number, seed: string): Promise<string> {
  return writer.storeAttendeePayload(noise(size, seed), { kind: "checkout" }, {
    stamper: () => STAMPER,
    upload: async (_env, body) => chunkAddress(body),
  });
}

function chunkAddress(body: Uint8Array): string {
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

interface Sent {
  burner: import("../src/lib/attendee-batch/burn.js").Burner;
  envelope: EnvelopeWithBatchId;
}

function honestBurnerBee(sent: Sent[]): import("../src/lib/attendee-batch/burn.js").BurnerUploader {
  return async (burner, envelope) => {
    sent.push({ burner, envelope });
    return keccak256(concat([burner.identifier, burner.owner])).slice(2);
  };
}

test("the burner for a bucket lands in that bucket, is owned by the stamper, and is deterministic", () => {
  for (const bucket of [0, 1, 0x50d9, 0xffff]) {
    const b = burn.burnerFor(STAMPER, bucket);
    assert.equal(bucketOf(b.address), bucket);
    assert.equal(hexlify(b.address), keccak256(concat([b.identifier, b.owner])), "SOC address = keccak(id || owner)");
    assert.equal(hexlify(b.owner), STAMPER_ADDRESS);
    // SOC signature: personal-sign over keccak(identifier || CAC address of span||payload).
    const cac = chunkAddress(b.body);
    const digest = keccak256(concat([b.identifier, `0x${cac}`]));
    assert.equal(verifyMessage(getBytes(digest), hexlify(b.signature)).toLowerCase(), STAMPER_ADDRESS);
    burn._clearBurnerCacheForTests();
    assert.equal(hexlify(burn.burnerFor(STAMPER, bucket).identifier), hexlify(b.identifier));
  }
});

test("burning stamps a burner into every chunk's exact slot with a newer timestamp, root included", async () => {
  const batch = freshBatch();
  const root = await storeOrder(9000, "order-1");
  const before = ledger.getOrderRecord(root)!;
  assert.equal(before.chunks.length, 4);

  const sent: Sent[] = [];
  const after = await burn.burnOrder(root, { stamper: () => STAMPER, upload: honestBurnerBee(sent) });

  assert.equal(sent.length, before.chunks.length);
  for (const [i, chunk] of before.chunks.entries()) {
    const { burner, envelope } = sent[i];
    assert.equal(hexlify(envelope.index), `0x${chunk.bucket.toString(16).padStart(8, "0")}${chunk.slot.toString(16).padStart(8, "0")}`);
    assert.equal(bucketOf(burner.address), chunk.bucket);
    assert.ok(decodeTimestampNs(envelope.timestamp) > decodeTimestampNs(Buffer.from(chunk.ts, "hex")), "burn is newer");
    const digest = keccak256(concat([burner.address, getBytes(`0x${batch}`), envelope.index, envelope.timestamp]));
    assert.equal(recoverAddress(hashMessage(getBytes(digest)), hexlify(envelope.signature)).toLowerCase(), STAMPER_ADDRESS);
  }
  assert.equal(after.state, "burned");
  assert.equal(ledger.isOrderErased(root), true);
});

test("an interrupted burn resumes with the identical stamp for the chunk in flight", async () => {
  freshBatch();
  const root = await storeOrder(5000, "order-2");
  const sent: Sent[] = [];
  let failNext = 2;
  const flaky: import("../src/lib/attendee-batch/burn.js").BurnerUploader = async (burner, envelope) => {
    if (--failNext === 0) throw new Error("connection reset");
    sent.push({ burner, envelope });
    return keccak256(concat([burner.identifier, burner.owner])).slice(2);
  };
  await assert.rejects(burn.burnOrder(root, { stamper: () => STAMPER, upload: flaky }));
  const mid = ledger.getOrderRecord(root)!;
  assert.equal(mid.state, "stored");
  const planned = mid.chunks.find((c) => !c.burnedAt && c.burnTs)!;
  assert.ok(planned, "the chunk in flight has a persisted burn timestamp");

  const resumed: Sent[] = [];
  await burn.burnOrder(root, { stamper: () => STAMPER, upload: honestBurnerBee(resumed) });
  assert.equal(hexlify(resumed[0].envelope.timestamp).slice(2), planned.burnTs, "same timestamp on retry");
  assert.equal(resumed.length, mid.chunks.filter((c) => !c.burnedAt).length, "burned chunks are not re-sent");
  assert.equal(ledger.isOrderErased(root), true);
});

test("a stamper that does not own the batch burns nothing", async () => {
  freshBatch();
  const root = await storeOrder(100, "order-3");
  const other = stamperKeyFromHex("55".repeat(32));
  const sent: Sent[] = [];
  await assert.rejects(burn.burnOrder(root, { stamper: () => other, upload: honestBurnerBee(sent) }), /does not own/);
  assert.equal(sent.length, 0);
});

test("if bee reports a different address for the burner, the chunk is not marked burned", async () => {
  freshBatch();
  const root = await storeOrder(100, "order-4");
  await assert.rejects(burn.burnOrder(root, { stamper: () => STAMPER, upload: async () => "ff".repeat(32) }));
  const record = ledger.getOrderRecord(root)!;
  assert.equal(record.chunks[0].burnedAt, undefined);
  assert.equal(record.state, "stored");
  // The burn was planned, so readers already treat the order as erased; an
  // operator re-runs the burn to finish it.
  assert.equal(ledger.isOrderErased(root), true);
});
