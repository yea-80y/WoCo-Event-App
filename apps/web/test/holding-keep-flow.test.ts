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
import { acceptKeepLink, finishErase, isKnownLedger, recheckDeviceBox, saveToAccount, showReceipt, type KeepFlowDeps } from "../src/lib/holding/keep-flow.ts";
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
    assert.equal(await finishErase(pickupId, ACCOUNT, second.deps), "erased");
    kept = (await device.readDeviceReceipt(pickupId))!;
    assert.equal(kept.serverErased, true);
    // Done is done: no second request.
    assert.equal(await finishErase(pickupId, ACCOUNT, second.deps), "erased");
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

test("a receipt no longer on the device says so - never 'try later' (Fable 3b condition 2)", async () => {
  const r = secret(63);
  const keys = await holdingGenKeysOf(`0x${"63".repeat(32)}`);
  const box = makeBox(r, 1);
  const { pickupId } = await device.rememberKeepLink(r, ROOT);
  await device.forgetAllDeviceReceipts();
  const { deps, calls } = flow({ fetchBox: async (got) => okFrom(got, box) });
  assert.deepEqual(await showReceipt(pickupId, deps), { kind: "not-on-device" });
  assert.deepEqual(await saveToAccount(pickupId, keys, ACCOUNT, deps), { kind: "not-on-device" });
  assert.equal(await finishErase(pickupId, ACCOUNT, deps), "not-on-device");
  assert.deepEqual(calls, { fetchBox: 0, erase: 0 });

  // Gone WHILE the box was being fetched: shown nowhere, and not written back.
  const r2 = secret(64);
  const kept2 = await device.rememberKeepLink(r2, ROOT);
  const racing = flow({
    fetchBox: async (got) => {
      await device.forgetAllDeviceReceipts();
      return okFrom(got, makeBox(r2, 1));
    },
  });
  assert.deepEqual(await showReceipt(kept2.pickupId, racing.deps), { kind: "not-on-device" });
  assert.equal(await device.readDeviceReceipt(kept2.pickupId), null);
});

test("a save Swarm cannot place says so in words for the person (HoldingSaveError), never raw", async () => {
  const [{ liveHoldingFeedIO }, { HoldingSaveError }] = await Promise.all([
    import("../src/lib/holding/holding-io.ts"),
    import("../src/lib/holding/account-copy.ts"),
  ]);
  const keys = await holdingGenKeysOf(`0x${"65".repeat(32)}`);
  // Every read fails (fetch throws here), so no version can be proven next.
  const base = { read: { status: "unavailable" as const, reason: "test" }, nextVersion: null, owner: keys.signer.address.slice(2), topic: "woco/holding/v1/" + "65".repeat(32), route: "etherna" as never };
  await assert.rejects(
    liveHoldingFeedIO.write({ signer: keys.signer, topic: base.topic, base, build: async () => ({}) }),
    (e: unknown) => e instanceof HoldingSaveError && /could not be read just now/.test((e as Error).message),
  );
});

test("finish erase: never for a receipt not saved in an account", async () => {
  const r = secret(60);
  const { deps, calls } = flow();
  const { pickupId } = await device.rememberKeepLink(r, ROOT);
  assert.equal(await finishErase(pickupId, ACCOUNT, deps), "not-saved");
  assert.equal(calls.erase, 0);
});

test("finish erase: only for the account it was saved to (Fable 3b, carried to 3c)", async () => {
  const r = secret(62);
  const keys = await holdingGenKeysOf(`0x${"62".repeat(32)}`);
  const { deps, calls } = flow({ fetchBox: async (got) => okFrom(got, makeBox(r, 1)), erase: "later" });
  const { pickupId } = await device.rememberKeepLink(r, ROOT);
  await showReceipt(pickupId, deps);
  assert.equal((await saveToAccount(pickupId, keys, ACCOUNT, deps)).kind, "saved");
  const erases = calls.erase;
  const other = "0x" + "c3".repeat(20);
  assert.equal(await finishErase(pickupId, other, deps), "not-saved");
  assert.equal(calls.erase, erases, "nothing asked of the server for another account");
  assert.equal(await finishErase(pickupId, ACCOUNT.toUpperCase().replace("0X", "0x"), deps), "later", "the same account, any case");
  assert.equal(calls.erase, erases + 1);
});

test("recheck on mount: a box the device keeps is checked again with NO network - shown, or nothing", async () => {
  const r = secret(63);
  const before = fetches;
  const { deps, calls } = flow({ fetchBox: async (got) => okFrom(got, makeBox(r, 2)) });
  const { pickupId } = await device.rememberKeepLink(r, ROOT);
  assert.equal(await recheckDeviceBox(pickupId, { device }), null, "no box yet: the Show button");
  await showReceipt(pickupId, deps);
  const shown = calls.fetchBox;

  const got = await recheckDeviceBox(pickupId, { device });
  assert.equal(got?.kind, "shown");
  assert.deepEqual(got!.receipts.map((c) => c.receipt.edition), [7, 8]);
  assert.equal(calls.fetchBox, shown, "no fetch");
  assert.equal(fetches, before, "no request of any kind");

  // A kept box that no longer checks, or names a ledger this build does not know: nothing shown, nothing fetched.
  const bad = secret(64);
  const { pickupId: badId } = await device.rememberKeepLink(bad, ROOT);
  await device.rememberDeviceBox(bytesToHex(bad), makeBox(secret(65), 1), ROOT);
  assert.equal(await recheckDeviceBox(badId, { device }), null);
  const foreign = secret(66);
  const { pickupId: foreignId } = await device.rememberKeepLink(foreign, ROOT);
  await device.rememberDeviceBox(bytesToHex(foreign), foreignBox(foreign), ROOT);
  assert.equal(await recheckDeviceBox(foreignId, { device }), null);
  assert.equal(await recheckDeviceBox("ab".repeat(32), { device }), null, "not on this device");
  assert.equal(fetches, before);
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
