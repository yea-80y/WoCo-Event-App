/**
 * Private receipts kept on this device (`src/lib/holding/device-store.ts`): the secret
 * from the moment a Keep link opens, the checked box from the first press. Pinned: an
 * entry opens only under its own order's slot; a field once known is never dropped; the
 * sign-out sweep removes every entry; and none of it touches the network.
 */
import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex } from "@noble/hashes/utils.js";
import { holdingPickupId } from "@woco/shared/holding/derive";
import { StorageKeys } from "@woco/shared";
import { getKV, putKV } from "../src/lib/auth/storage/indexeddb.ts";
import * as device from "../src/lib/holding/device-store.ts";
import { makeBox, secret } from "./holding-fixture.ts";

const realFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  throw new Error("the device store never touches the network");
}) as typeof fetch;
test.after(() => {
  globalThis.fetch = realFetch;
});

const ROOT = "cd".repeat(32);
const ACCOUNT = "0x" + "a1".repeat(20);
const keyOf = (r: Uint8Array) => `${StorageKeys.HOLDING_DEVICE}:${holdingPickupId(r)}`;

test("a link's secret is kept, filed under its order; reading it back gives the same", async () => {
  const r = secret(31);
  const kept = await device.rememberKeepLink(r, ROOT, 1000);
  assert.equal(kept.pickupId, holdingPickupId(r));
  assert.equal(kept.r, bytesToHex(r));
  assert.equal(kept.boxRoot, ROOT);
  assert.deepEqual(await device.readDeviceReceipt(kept.pickupId), kept);
  // Under the device key: no secret in the clear.
  const blob = JSON.stringify(await getKV(keyOf(r)));
  assert.ok(!blob.includes(bytesToHex(r)));
});

test("a field once known is never dropped: a second open of the link keeps the box, the account, the erase", async () => {
  const r = secret(32);
  await device.rememberKeepLink(r, ROOT, 1000);
  const box = makeBox(r, 2);
  await device.rememberDeviceBox(bytesToHex(r), box, ROOT, 2000);
  await device.markDeviceReceiptSaved(bytesToHex(r), ACCOUNT.toUpperCase().replace("0X", "0x"), 3000);
  await device.markDeviceReceiptErased(bytesToHex(r), 4000);
  // The link opened again, with no box root this time.
  const again = await device.rememberKeepLink(r, undefined, 5000);
  assert.deepEqual(again.box, box);
  assert.equal(again.boxRoot, ROOT);
  assert.equal(again.savedTo, ACCOUNT, "lowercased");
  assert.equal(again.serverErased, true);
  assert.equal(again.keptAt, 1000, "first kept, not last opened");
});

test("an entry moved to another order's slot does not open there", async () => {
  const a = secret(33);
  const b = secret(34);
  await device.rememberKeepLink(a, ROOT);
  await device.rememberKeepLink(b, ROOT);
  await putKV(keyOf(b), await getKV(keyOf(a)));
  assert.equal(await device.readDeviceReceipt(holdingPickupId(b)), null, "the tag binds the order");
  assert.ok(await device.readDeviceReceipt(holdingPickupId(a)));
});

test("an entry whose secret is another order's does not open, even sealed under the right slot", async () => {
  const { AAD, encrypt, ensureDeviceKey } = await import("../src/lib/auth/storage/encryption.ts");
  const a = secret(39);
  const b = secret(40);
  const idB = holdingPickupId(b);
  await putKV(keyOf(b), await encrypt(await ensureDeviceKey(), AAD.HOLDING_DEVICE_ORDER(idB), { v: 1, r: bytesToHex(a), keptAt: 1 }));
  assert.equal(await device.readDeviceReceipt(idB), null);
});

test("a malformed root never replaces a good one, and one already stored is not read back", async () => {
  const r = secret(26);
  await device.rememberKeepLink(r, ROOT);
  assert.equal((await device.rememberKeepLink(r, "not-a-root")).boxRoot, ROOT, "the good root stays");
  assert.equal((await device.readDeviceReceipt(holdingPickupId(r)))!.boxRoot, ROOT);
  // An entry that holds one anyway (an older build, a hand edit): read without it.
  const { AAD, encrypt, ensureDeviceKey } = await import("../src/lib/auth/storage/encryption.ts");
  const odd = secret(27);
  const id = holdingPickupId(odd);
  await putKV(keyOf(odd), await encrypt(await ensureDeviceKey(), AAD.HOLDING_DEVICE_ORDER(id), { v: 1, r: bytesToHex(odd), keptAt: 1, boxRoot: "ZZ" }));
  const got = await device.readDeviceReceipt(id);
  assert.ok(got);
  assert.equal(got.boxRoot, undefined);
});

test("list: every entry this device can open, newest first; a malformed root is not kept", async () => {
  await device.forgetAllDeviceReceipts();
  await device.rememberKeepLink(secret(35), ROOT, 100);
  await device.rememberKeepLink(secret(36), "not-a-root", 300);
  await device.rememberKeepLink(secret(37), undefined, 200);
  const list = await device.listDeviceReceipts();
  assert.deepEqual(list.map((e) => e.pickupId), [secret(36), secret(37), secret(35)].map(holdingPickupId));
  assert.equal(list[0]!.boxRoot, undefined);
});

test("only a Keep link makes an entry: a later step on a missing one does nothing (Fable 3b condition 3)", async () => {
  await device.forgetAllDeviceReceipts();
  const r = secret(28);
  const rHex = bytesToHex(r);
  assert.equal(await device.rememberDeviceBox(rHex, makeBox(r, 1), ROOT), null);
  assert.equal(await device.rememberDeviceTitle(rHex, "An event"), null);
  assert.equal(await device.markDeviceReceiptSaved(rHex, ACCOUNT), null);
  assert.equal(await device.markDeviceReceiptErased(rHex), null);
  assert.deepEqual(await device.listDeviceReceipts(), [], "nothing written back");
});

test("a sign-out sweep waits for a step already queued, and a step queued after it writes nothing back", async () => {
  await device.forgetAllDeviceReceipts();
  const r = secret(29);
  const rHex = bytesToHex(r);
  await device.rememberKeepLink(r, ROOT);
  // In flight together, in this order: a mark, the sweep, then a late title.
  const mark = device.markDeviceReceiptSaved(rHex, ACCOUNT);
  const sweep = device.forgetAllDeviceReceipts();
  const late = device.rememberDeviceTitle(rHex, "Late");
  assert.ok(await mark, "the step before the sweep finished first");
  await sweep;
  assert.equal(await late, null, "the step after it found nothing to update");
  assert.deepEqual(await device.listDeviceReceipts(), []);
});

test("a session clear (boot or forced): saved and unopenable entries go, an unsaved link stays (Fable 3b delta)", async () => {
  await device.forgetAllDeviceReceipts();
  const unsaved = secret(21);
  const saved = secret(22);
  const odd = secret(23);
  await device.rememberKeepLink(unsaved, ROOT);
  await device.rememberKeepLink(saved, ROOT);
  await device.markDeviceReceiptSaved(bytesToHex(saved), ACCOUNT);
  // An entry this device can no longer open (another device key, a damaged blob).
  await putKV(keyOf(odd), { iv: "00".repeat(12), ct: "00".repeat(40) });
  await device.forgetSavedDeviceReceipts();
  assert.deepEqual((await device.listDeviceReceipts()).map((e) => e.pickupId), [holdingPickupId(unsaved)]);
  assert.equal(await getKV(keyOf(odd)), null, "the unopenable one is gone too");
});

test("a session clear never deletes an entry because storage failed to answer", async () => {
  await device.forgetAllDeviceReceipts();
  const r = secret(24);
  await device.rememberKeepLink(r, ROOT);
  // Listing answers; every single-entry read fails, as a busy or broken store might.
  const proto = (globalThis as unknown as { IDBObjectStore: { prototype: { get: unknown } } }).IDBObjectStore.prototype;
  const realGet = proto.get;
  proto.get = () => {
    throw new Error("storage busy");
  };
  try {
    await device.forgetSavedDeviceReceipts();
  } finally {
    proto.get = realGet;
  }
  assert.ok(await device.readDeviceReceipt(holdingPickupId(r)), "untouched");
});

test("sign-out sweep: every entry goes, nothing else in the store", async () => {
  await device.rememberKeepLink(secret(38), ROOT);
  await putKV("woco:auth:last-way-in", "passkey");
  await device.forgetAllDeviceReceipts();
  assert.deepEqual(await device.listDeviceReceipts(), []);
  assert.equal(await getKV("woco:auth:last-way-in"), "passkey");
});
