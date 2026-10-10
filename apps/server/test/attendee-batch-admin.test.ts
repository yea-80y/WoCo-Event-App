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
import { Wallet } from "ethers";

const dir = mkdtempSync(join(tmpdir(), "woco-attendee-admin-"));
process.chdir(dir);
process.env.FEED_PRIVATE_KEY = "33".repeat(32);
process.env.ATTENDEE_STAMPER_PRIVATE_KEY = "44".repeat(32);

const admin = await import("../src/lib/attendee-batch/admin.js");
const ledger = await import("../src/lib/attendee-batch/ledger.js");

const STAMPER = new Wallet(`0x${"44".repeat(32)}`).address.toLowerCase();
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

test("registration records the expiry from chain; refresh follows a top-up, and a vanished batch stops sales", async () => {
  const id = "05".repeat(32);
  const t0 = Date.now();
  await admin.registerAttendeeBatch(id, true, lookup({ ...good, batchTTL: 3 * 86400 }));
  const at = Date.parse(ledger.getBatchRecord(id)!.expiresAt!);
  assert.ok(Math.abs(at - (t0 + 3 * 86400_000)) < 60_000);
  ledger.setActiveBatch(id);
  await admin.refreshAttendeeBatch(undefined, lookup({ ...good, batchTTL: 40 * 86400 }));
  assert.ok(Date.parse(ledger.getBatchRecord(id)!.expiresAt!) > t0 + 39 * 86400_000);
  assert.equal(ledger.attendeeStoreRefusal(STAMPER), null);
  await admin.refreshAttendeeBatch(undefined, lookup(null));
  assert.match(ledger.attendeeStoreRefusal(STAMPER) ?? "", /expires/);
  await admin.refreshAttendeeBatch(undefined, lookup({ ...good, owner: "0x" + "98".repeat(20) }));
  assert.match(ledger.attendeeStoreRefusal(STAMPER) ?? "", /expires/);
});

test("refresh after a dilution raises the depth, so orders use the new slots; it never lowers it", async () => {
  const id = "08".repeat(32);
  await admin.registerAttendeeBatch(id, true, lookup({ ...good, depth: 17 }));
  ledger.setActiveBatch(id);
  const inBucket = (n: number) => {
    const a = new Uint8Array(32);
    a[0] = 0x12;
    a[1] = 0x34;
    a[31] = n;
    return a;
  };
  ledger.allocateOrder(inBucket(1), [inBucket(1)], { kind: "checkout" });
  ledger.allocateOrder(inBucket(2), [inBucket(2)], { kind: "checkout" });
  assert.throws(() => ledger.allocateOrder(inBucket(3), [inBucket(3)], { kind: "checkout" }), ledger.AttendeeBucketFullError);
  await admin.refreshAttendeeBatch(undefined, lookup({ ...good, depth: 18 }));
  assert.equal(ledger.getBatchRecord(id)?.depth, 18);
  assert.equal(ledger.allocateOrder(inBucket(3), [inBucket(3)], { kind: "checkout" }).record.chunks[0].slot, 2);
  await admin.refreshAttendeeBatch(undefined, lookup({ ...good, depth: 17 }));
  assert.equal(ledger.getBatchRecord(id)?.depth, 18, "a lower chain depth is ignored");
});

test("health is red while sales are refused and green on a live, roomy batch", async () => {
  const { attendeeBatchHealth } = await import("../src/lib/attendee-batch/health.js");
  const id = "06".repeat(32);
  await admin.registerAttendeeBatch(id, true, lookup({ ...good, batchTTL: 30 * 86400 }));
  ledger.setActiveBatch(id);
  const green = attendeeBatchHealth();
  assert.equal(green.ok, true, JSON.stringify(green.checks));
  await admin.refreshAttendeeBatch(undefined, lookup(null));
  const red = attendeeBatchHealth();
  assert.equal(red.ok, false);
  assert.equal(red.checks.sales.ok, false);
  assert.equal(red.checks.ttl.ok, false);
});

test("the fresh assertion is still required", async () => {
  await assert.rejects(admin.registerAttendeeBatch("04".repeat(32), false, lookup(good)), /fresh/);
});
