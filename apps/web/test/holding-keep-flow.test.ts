/**
 * The Keep page's steps (`src/lib/holding/keep-flow.ts`), spec-receipt-note 5.2 and the
 * 3a carried item 11:
 * - opening a link does NOTHING over the network (spec section 10: "the Keep page does
 *   nothing on load");
 * - a receipt is shown only once checked against the secret AND against a ticket ledger
 *   this build knows;
 * - the secret is never dropped, whatever any step answers;
 * - our copy is erased only after the account's copy read back, and the device records
 *   what happened.
 */
import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex } from "@noble/hashes/utils.js";
import { holdingPickupId } from "@woco/shared/holding/derive";
import { holdingKeepFragment } from "@woco/shared/holding/pickup";
import type { HoldingBoxV1 } from "@woco/shared/holding/box";
import { checkedHoldingBox } from "@woco/shared/holding/open";
import { holdingGenKeysOf, readHoldingIndex } from "../src/lib/holding/account-copy.ts";
import * as device from "../src/lib/holding/device-store.ts";
import type { BoxSourceResult } from "../src/lib/holding/box-source.ts";
import type { EraseResult } from "../src/lib/api/holdings.ts";
import { acceptKeepLink, finishErase, isKnownLedger, saveToAccount, showReceipt, type KeepFlowDeps } from "../src/lib/holding/keep-flow.ts";
import { fakeFeeds, makeBox, secret } from "./holding-fixture.ts";

let fetches = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  fetches++;
  throw new Error("no network in these tests");
}) as typeof fetch;
test.after(() => {
  globalThis.fetch = realFetch;
});

const ROOT = "ef".repeat(32);
const ACCOUNT = "0x" + "b2".repeat(20);

function flow(over: { fetchBox?: (r: Uint8Array, root: string | undefined) => Promise<BoxSourceResult>; erase?: EraseResult; feeds?: ReturnType<typeof fakeFeeds> } = {}) {
  const feeds = over.feeds ?? fakeFeeds();
  const calls = { fetchBox: 0, erase: 0 };
  const deps: KeepFlowDeps = {
    device,
    fetchBox: async (r, root) => (calls.fetchBox++, over.fetchBox ? over.fetchBox(r, root) : { kind: "later" }),
    keepDeps: async () => ({ io: feeds.io, erase: async () => (calls.erase++, over.erase ?? "erased"), now: () => 1_800_000_000_000 }),
  };
  return { deps, calls, feeds };
}

const okFrom = (r: Uint8Array, box: HoldingBoxV1, root = ROOT): BoxSourceResult => ({ kind: "ok", ...checkedHoldingBox(r, box), boxRoot: root });

/** A box that checks against `r` but names a ticket ledger this build does not know. */
function foreignBox(r: Uint8Array): HoldingBoxV1 {
  const box = makeBox(r, 1);
  return { v: 1, receipts: box.receipts.map((e) => ({ ...e, ledger: "0x" + "99".repeat(20) })) };
}

test("ON LOAD: accepting a link keeps its secret on the device and touches no network", async () => {
  const r = secret(41);
  const { deps, calls } = flow();
  const before = fetches;
  const got = await acceptKeepLink(holdingKeepFragment(r, ROOT), deps);
  assert.notEqual(got, "malformed");
  if (got === "malformed") return;
  assert.equal(got.pickupId, holdingPickupId(r));
  assert.equal(got.boxRoot, ROOT);
  // Listing what the device keeps is the page's other load step: local too.
  assert.ok((await device.listDeviceReceipts()).some((e) => e.pickupId === got.pickupId));
  assert.equal(fetches, before, "no request of any kind");
  assert.deepEqual(calls, { fetchBox: 0, erase: 0 });
});

test("a malformed link keeps nothing", async () => {
  const { deps } = flow();
  for (const f of ["#/keep?k=short", "#/keep?b=" + ROOT, "#/keep?k=" + "A".repeat(43) + "&x=1", "#/tickets"]) {
    assert.equal(await acceptKeepLink(f, deps), "malformed", f);
  }
});

test("show: fetched, checked, kept on the device; the next show needs no fetch at all", async () => {
  const r = secret(42);
  const box = makeBox(r, 2);
  const { deps, calls } = flow({ fetchBox: async (got, root) => (assert.equal(root, ROOT), okFrom(got, box)) });
  const { pickupId } = (await device.rememberKeepLink(r, ROOT));
  const shown = await showReceipt(pickupId, deps);
  assert.equal(shown.kind, "shown");
  if (shown.kind !== "shown") return;
  assert.deepEqual(shown.receipts.map((c) => c.receipt.holder), box.receipts.map((e) => e.holder));
  assert.deepEqual((await device.readDeviceReceipt(pickupId))!.box, checkedHoldingBox(r, box).box);
  assert.equal(calls.fetchBox, 1);
  assert.equal((await showReceipt(pickupId, deps)).kind, "shown");
  assert.equal(calls.fetchBox, 1, "from the device, checked again, no fetch");
});

test("show: a box naming a ledger this build does not know is neither shown nor kept", async () => {
  const r = secret(43);
  const box = foreignBox(r);
  assert.equal(await isKnownLedger(box), false);
  assert.equal(await isKnownLedger(makeBox(r, 1)), true);
  const { deps } = flow({ fetchBox: async (got) => okFrom(got, box) });
  const { pickupId } = await device.rememberKeepLink(r, ROOT);
  assert.deepEqual(await showReceipt(pickupId, deps), { kind: "unknown-ledger" });
  assert.equal((await device.readDeviceReceipt(pickupId))!.box, undefined);
});

test("show: not found, later or refused - the secret stays on the device every time", async () => {
  const r = secret(44);
  const { pickupId } = await device.rememberKeepLink(r, ROOT);
  for (const answer of [{ kind: "not-found" }, { kind: "later" }, { kind: "refused", reason: "unopenable" }] as BoxSourceResult[]) {
    const { deps } = flow({ fetchBox: async () => answer });
    assert.deepEqual(await showReceipt(pickupId, deps), answer);
    assert.equal((await device.readDeviceReceipt(pickupId))!.r, bytesToHex(r));
  }
  // And a throw.
  const { deps } = flow({ fetchBox: async () => { throw new Error("gateway exploded"); } });
  await assert.rejects(showReceipt(pickupId, deps));
  assert.equal((await device.readDeviceReceipt(pickupId))!.r, bytesToHex(r));
});

test("save: read back in the account, THEN our copy erased; the device records both", async () => {
  const r = secret(45);
  const box = makeBox(r, 2);
  const keys = await holdingGenKeysOf(`0x${"45".repeat(32)}`);
  const { deps, calls, feeds } = flow({ fetchBox: async (got) => okFrom(got, box) });
  const { pickupId } = await device.rememberKeepLink(r, ROOT);
  assert.deepEqual(await saveToAccount(pickupId, keys, ACCOUNT, deps), { kind: "not-shown" }, "never before it was shown");
  assert.equal(calls.erase, 0);
  await showReceipt(pickupId, deps);
  assert.deepEqual(await saveToAccount(pickupId, keys, ACCOUNT, deps), { kind: "saved", erase: "erased" });
  assert.equal(calls.erase, 1);
  const index = await readHoldingIndex(keys, feeds.io);
  assert.ok(index && index !== "unavailable" && index.orders.some((o) => o.pickupId === pickupId), "in the account's list");
  const kept = (await device.readDeviceReceipt(pickupId))!;
  assert.equal(kept.savedTo, ACCOUNT);
  assert.equal(kept.serverErased, true);
  assert.equal(kept.r, bytesToHex(r), "still on the device until sign-out");
});

test("save: not read back - our copy is left alone, and nothing says saved", async () => {
  const r = secret(46);
  const keys = await holdingGenKeysOf(`0x${"46".repeat(32)}`);
  const feeds = fakeFeeds();
  feeds.unconfirmAfter = 0;
  const { deps, calls } = flow({ fetchBox: async (got) => okFrom(got, makeBox(r, 1)), feeds });
  const { pickupId } = await device.rememberKeepLink(r, ROOT);
  await showReceipt(pickupId, deps);
  assert.deepEqual(await saveToAccount(pickupId, keys, ACCOUNT, deps), { kind: "unconfirmed" });
  assert.equal(calls.erase, 0);
  const kept = (await device.readDeviceReceipt(pickupId))!;
  assert.equal(kept.savedTo, undefined);
  assert.equal(kept.serverErased, undefined);
});

test("save then erase answers busy, refused or later: saved stands, the erase can be finished later", async () => {
  for (const [i, erase] of (["busy", "refused", "later"] as const).entries()) {
    const r = secret(50 + i);
    const keys = await holdingGenKeysOf(`0x${String(50 + i).repeat(32)}`);
    const feeds = fakeFeeds();
    const first = flow({ fetchBox: async (got) => okFrom(got, makeBox(r, 1)), erase, feeds });
    const { pickupId } = await device.rememberKeepLink(r, ROOT);
    await showReceipt(pickupId, first.deps);
    assert.deepEqual(await saveToAccount(pickupId, keys, ACCOUNT, first.deps), { kind: "saved", erase });
    let kept = (await device.readDeviceReceipt(pickupId))!;
    assert.equal(kept.savedTo, ACCOUNT, erase);
    assert.equal(kept.serverErased, undefined, erase);

    const second = flow({ erase: "erased", feeds });
    assert.equal(await finishErase(pickupId, second.deps), "erased");
    kept = (await device.readDeviceReceipt(pickupId))!;
    assert.equal(kept.serverErased, true);
    // Done is done: no second request.
    assert.equal(await finishErase(pickupId, second.deps), "erased");
    assert.equal(second.calls.erase, 1);
  }
});

test("save: never a box naming an unknown ledger, however it reached the device", async () => {
  const r = secret(62);
  const keys = await holdingGenKeysOf(`0x${"62".repeat(32)}`);
  const { deps, calls } = flow();
  await device.rememberKeepLink(r, ROOT);
  const { pickupId } = await device.rememberDeviceBox(bytesToHex(r), foreignBox(r), ROOT);
  assert.deepEqual(await saveToAccount(pickupId, keys, ACCOUNT, deps), { kind: "not-shown" });
  assert.equal(calls.erase, 0);
  assert.deepEqual(await showReceipt(pickupId, deps), { kind: "unknown-ledger" });
});

test("finish erase: never for a receipt not saved in an account", async () => {
  const r = secret(60);
  const { deps, calls } = flow();
  const { pickupId } = await device.rememberKeepLink(r, ROOT);
  assert.equal(await finishErase(pickupId, deps), "not-saved");
  assert.equal(calls.erase, 0);
});

test("a 'gone' erase (nothing of ours left) counts as done", async () => {
  const r = secret(61);
  const keys = await holdingGenKeysOf(`0x${"61".repeat(32)}`);
  const { deps } = flow({ fetchBox: async (got) => okFrom(got, makeBox(r, 1)), erase: "gone" });
  const { pickupId } = await device.rememberKeepLink(r, ROOT);
  await showReceipt(pickupId, deps);
  assert.deepEqual(await saveToAccount(pickupId, keys, ACCOUNT, deps), { kind: "saved", erase: "gone" });
  assert.equal((await device.readDeviceReceipt(pickupId))!.serverErased, true);
});
