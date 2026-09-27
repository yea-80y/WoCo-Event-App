/**
 * Registering an attendee batch (#546). A batch the stamper does not own would
 * accept every allocation and then have each upload rejected by the network,
 * after the card was charged; a depth typed wrong would hand out slots the
 * batch does not have. So registration reads the batch from chain.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKey } from "@ethersphere/bee-js";

const dir = mkdtempSync(join(tmpdir(), "woco-attendee-admin-"));
process.chdir(dir);
process.env.FEED_PRIVATE_KEY = "33".repeat(32);
process.env.ATTENDEE_STAMPER_PRIVATE_KEY = "44".repeat(32);

const admin = await import("../src/lib/attendee-batch/admin.js");
const ledger = await import("../src/lib/attendee-batch/ledger.js");

const STAMPER = `0x${new PrivateKey("44".repeat(32)).publicKey().address().toHex()}`.toLowerCase();
const good = { owner: STAMPER, depth: 20, bucketDepth: 16, immutable: true, batchTTL: 86_400 * 60 };
const lookup = (chain: admin.ChainBatch | null): admin.BatchLookup => async () => chain;

test("the depth comes from chain, not from the operator", async () => {
  const { batch } = await admin.registerAttendeeBatch("0x" + "01".repeat(32), true, lookup({ ...good, depth: 21 }));
  assert.equal(batch.depth, 21);
  assert.equal(ledger.getBatchRecord("01".repeat(32))?.owner, STAMPER);
});

test("a batch the stamper does not own is refused", async () => {
  await assert.rejects(
    admin.registerAttendeeBatch("02".repeat(32), true, lookup({ ...good, owner: "0x" + "99".repeat(20) })),
    /not the stamper/,
  );
  assert.equal(ledger.getBatchRecord("02".repeat(32)), null);
});

test("a batch that is dead, not yet visible, or not bucket depth 16 is refused", async () => {
  await assert.rejects(admin.registerAttendeeBatch("03".repeat(32), true, lookup({ ...good, batchTTL: 0 })), /TTL/);
  await assert.rejects(admin.registerAttendeeBatch("03".repeat(32), true, lookup({ ...good, batchTTL: -1 })), /TTL/);
  await assert.rejects(admin.registerAttendeeBatch("03".repeat(32), true, lookup(null)), /not found/);
  await assert.rejects(admin.registerAttendeeBatch("03".repeat(32), true, lookup({ ...good, bucketDepth: 17 })), /bucket depth/);
  await assert.rejects(admin.registerAttendeeBatch("not-hex", true, lookup(good)), /32 bytes/);
  assert.equal(ledger.getBatchRecord("03".repeat(32)), null);
});

test("the fresh assertion is still required", async () => {
  await assert.rejects(admin.registerAttendeeBatch("04".repeat(32), false, lookup(good)), /fresh/);
});
