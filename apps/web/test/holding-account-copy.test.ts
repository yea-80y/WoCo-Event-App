/**
 * The buyer's own receipt copies (`src/lib/holding/account-copy.ts`, spec-receipt-note 5.1):
 * saved and read back before they count, found only under their own generation's keys,
 * never written over an index that cannot be read, and carried whole to new keys.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  holdingCopyOf,
  holdingCopyTopic,
  holdingIndexEntryOf,
  holdingIndexTopic,
  sameHoldingCopy,
} from "@woco/shared/holding/copy";
import { holdingIndexSealContext, openBoxJson, sealBoxJsonCompressed } from "@woco/shared/crypto/sealed-box";
import { holdingPickupId } from "@woco/shared/holding/derive";
import {
  addToHoldingIndex,
  holdingGenKeysOf,
  listHeldOrders,
  moveHoldingCopies,
  readAllHoldingCopies,
  readHoldingCopy,
  readHoldingIndex,
  saveHoldingCopy,
  writeHoldingCopies,
  writeHoldingCopy,
  type HoldingGenKeys,
} from "../src/lib/holding/account-copy.ts";
import { fakeFeeds, makeBox, secret } from "./holding-fixture.ts";

const S0 = `0x${"31".repeat(32)}`;
const S1 = `0x${"32".repeat(32)}`;
const S2 = `0x${"33".repeat(32)}`;
const R1 = secret(1);
const R2 = secret(2);
const R3 = secret(3);

const gen = (s: string) => holdingGenKeysOf(s);

function indexTopic(k: HoldingGenKeys) {
  return holdingIndexTopic(k.salt);
}

test("a generation's keys come from its secret: signer, order key and salt", async () => {
  const a = await gen(S0);
  const b = await gen(S1);
  assert.match(a.signer.address, /^0x[0-9a-f]{40}$/);
  assert.notEqual(a.signer.address, b.signer.address);
  assert.notEqual(bytesToHex(a.salt), bytesToHex(b.salt));
  assert.notEqual(bytesToHex(a.orderPublicKey), bytesToHex(b.orderPublicKey));
  assert.deepEqual(await gen(S0.slice(2)), a, "with or without 0x");
});

test("save: the copy and its index line land, and read back as saved", async () => {
  const f = fakeFeeds();
  const k = await gen(S0);
  const box = makeBox(R1, 2);
  assert.equal(await saveHoldingCopy(k, R1, box, f.io), "saved");

  const copy = await readHoldingCopy(k, holdingPickupId(R1), f.io);
  assert.ok(copy && copy !== "unavailable");
  assert.ok(sameHoldingCopy(copy, holdingCopyOf(R1, box)));
  const index = await readHoldingIndex(k, f.io);
  assert.deepEqual(index, { v: 1, orders: [holdingIndexEntryOf(holdingPickupId(R1), box)] });

  // Stored under the generation's own signer, at salted topics, sealed: no secret in the clear.
  for (const w of f.writes) assert.equal(w.owner, k.signer.address);
  assert.deepEqual(f.writes.map((w) => w.topic).sort(), [holdingCopyTopic(k.salt, holdingPickupId(R1)), indexTopic(k)].sort());
  const stored = [...f.feeds.values()].flat().join("");
  assert.ok(!stored.includes(bytesToHex(R1)), "the order secret in the clear");
  assert.ok(!stored.includes(holdingPickupId(R1)), "the pickup id in the clear");
});

test("save again: nothing is written when the same copy and line are already there", async () => {
  const f = fakeFeeds();
  const k = await gen(S0);
  const box = makeBox(R1, 2);
  await saveHoldingCopy(k, R1, box, f.io);
  const n = f.writes.length;
  // Another receipt order in the array, same receipts: still the same copy.
  assert.equal(await saveHoldingCopy(k, R1, { v: 1, receipts: [...box.receipts].reverse() }, f.io), "saved");
  assert.equal(f.writes.length, n);
});

test("a re-made box goes on top: the copy's next version, the line replaced", async () => {
  const f = fakeFeeds();
  const k = await gen(S0);
  await saveHoldingCopy(k, R1, makeBox(R1, 2), f.io);
  const remade = makeBox(R1, 2, 40);
  assert.equal(await saveHoldingCopy(k, R1, remade, f.io), "saved");
  const copy = await readHoldingCopy(k, holdingPickupId(R1), f.io);
  assert.ok(copy && copy !== "unavailable" && sameHoldingCopy(copy, holdingCopyOf(R1, remade)));
  const index = await readHoldingIndex(k, f.io);
  assert.ok(index && index !== "unavailable");
  assert.deepEqual(index.orders.map((e) => e.editions), [[41, 42]]);
});

test("two orders: the index lists both, each copy under its own topic", async () => {
  const f = fakeFeeds();
  const k = await gen(S0);
  await saveHoldingCopy(k, R1, makeBox(R1, 1), f.io);
  await saveHoldingCopy(k, R2, makeBox(R2, 3, 20), f.io);
  const index = await readHoldingIndex(k, f.io);
  assert.ok(index && index !== "unavailable");
  assert.deepEqual(index.orders.map((e) => e.pickupId).sort(), [holdingPickupId(R1), holdingPickupId(R2)].sort());
  const all = await readAllHoldingCopies([k], f.io);
  assert.equal(all.complete, true);
  assert.equal(all.copies.length, 2);
});

test("another tab's index line, written at the version we aimed for, survives our save", async () => {
  const f = fakeFeeds();
  const k = await gen(S0);
  await saveHoldingCopy(k, R1, makeBox(R1, 1), f.io);
  const topic = indexTopic(k);
  const theirs = { v: 1, orders: [holdingIndexEntryOf(holdingPickupId(R1), makeBox(R1, 1)), holdingIndexEntryOf(holdingPickupId(R3), makeBox(R3, 1, 30))] };
  const sealedTheirs = await sealBoxJsonCompressed(k.orderPublicKey, theirs, holdingIndexSealContext(topic));
  let raced = false;
  f.beforeWrite = (owner, t, version) => {
    if (t === topic && !raced) {
      raced = true;
      f.put(owner, t, version, sealedTheirs);
    }
  };
  assert.equal(await saveHoldingCopy(k, R2, makeBox(R2, 1, 20), f.io), "saved");
  assert.ok(raced);
  const index = await readHoldingIndex(k, f.io);
  assert.ok(index && index !== "unavailable");
  assert.deepEqual(index.orders.map((e) => e.pickupId).sort(), [R1, R2, R3].map((r) => holdingPickupId(r)).sort());
});

test("an index that cannot be read or opened is never written over", async () => {
  const k = await gen(S0);
  // Unreadable right now.
  const f = fakeFeeds();
  await saveHoldingCopy(k, R1, makeBox(R1, 1), f.io);
  f.failReads.add(indexTopic(k));
  const before = f.writes.length;
  await assert.rejects(saveHoldingCopy(k, R2, makeBox(R2, 1, 20), f.io));
  assert.equal(f.writes.filter((w) => w.topic === indexTopic(k)).length, f.writes.slice(0, before).filter((w) => w.topic === indexTopic(k)).length);
  assert.equal(await readHoldingIndex(k, f.io), "unavailable");

  // Opens - the account wrote it - but is not a list this build knows (a newer layout).
  for (const newer of [{ v: 2, orders: [], more: true }, { v: 1, orders: "not a list" }]) {
    const g = fakeFeeds();
    g.put(k.signer.address, indexTopic(k), 0, await sealBoxJsonCompressed(k.orderPublicKey, newer, holdingIndexSealContext(indexTopic(k))));
    await assert.rejects(addToHoldingIndex(k, [holdingIndexEntryOf(holdingPickupId(R2), makeBox(R2, 1))], g.io), /could not be opened/);
    assert.equal(g.writes.length, 0);
    assert.equal(await readHoldingIndex(k, g.io), "unavailable");
  }
  // A box version or shape this build does not know: as newer, never a jam to walk past
  // (Fable 3c PR 1, 2: interleaved pages always leave a well-formed box).
  for (const unknown of [{ v: 3, enc: "00", ct: "00" }, { v: 2, enc: "zz", ct: "00" }]) {
    const h = fakeFeeds();
    h.put(k.signer.address, indexTopic(k), 0, unknown);
    await assert.rejects(addToHoldingIndex(k, [holdingIndexEntryOf(holdingPickupId(R2), makeBox(R2, 1))], h.io), /could not be opened/);
    assert.equal(h.writes.length, 0);
  }
});

test("a page that reads ABSENT is not a jam: the list stops, nothing is written, a mover refuses (Fable 3c PR 1, 1)", async () => {
  const g0 = await gen(S0);
  const g1 = await gen(S1);
  const setup = async () => {
    const f = fakeFeeds();
    await saveHoldingCopy(g0, R1, makeBox(R1, 1), f.io); // index v0
    await saveHoldingCopy(g0, R2, makeBox(R2, 1, 20), f.io); // index v1
    return f;
  };
  // The head: a lost chunk or a false 404 under a manifest a confirmed save may have written;
  // or a manifest this code never writes.
  for (const why of ["missing-page", "page-count"] as const) {
    const head = await setup();
    head.put(g0.signer.address, indexTopic(g0), 2, { lostPage: true });
    head.spent.set(indexTopic(g0), 2);
    head.spentBy.set(`${indexTopic(g0)}@2`, why);
    assert.equal(await readHoldingIndex(g0, head.io), "unavailable", why);
    assert.deepEqual(head.readsAt, [], "not walked");
    const n = head.writes.length;
    await assert.rejects(saveHoldingCopy(g0, R3, makeBox(R3, 1, 30), head.io), /could not be read/);
    assert.equal(head.writes.filter((w) => w.topic === indexTopic(g0)).length, head.writes.slice(0, n).filter((w) => w.topic === indexTopic(g0)).length);
    assert.equal((await readAllHoldingCopies([g0], head.io)).complete, false);
    await assert.rejects(moveHoldingCopies([g0], g1, head.io));
  }

  // Below a jam, the walk stops there too.
  const below = await setup();
  jam(below, g0, 3, 1);
  below.spentBelow.add(`${indexTopic(g0)}@2`);
  below.spentBy.set(`${indexTopic(g0)}@2`, "missing-page");
  assert.equal(await readHoldingIndex(g0, below.io), "unavailable");
  assert.deepEqual(below.readsAt, [`${indexTopic(g0)}@2`]);
});

test("every chunk found but not one value - a length mismatch or not JSON - is a race: walked past", async () => {
  const k = await gen(S0);
  for (const why of ["length", "not-json"] as const) {
    const f = fakeFeeds();
    await saveHoldingCopy(k, R1, makeBox(R1, 1), f.io); // index v0
    f.put(k.signer.address, indexTopic(k), 1, { torn: true });
    f.spentBelow.add(`${indexTopic(k)}@1`);
    f.spentBy.set(`${indexTopic(k)}@1`, why);
    f.put(k.signer.address, indexTopic(k), 2, { torn: true });
    f.spent.set(indexTopic(k), 2);
    f.spentBy.set(`${indexTopic(k)}@2`, why);
    assert.deepEqual(await listed(k, f.io), [holdingPickupId(R1)], why);
  }
});

test("a decapsulation fault BELOW a jam stops the walk: it says nothing about what that version holds", async () => {
  const f = fakeFeeds();
  const k = await gen(S0);
  await saveHoldingCopy(k, R1, makeBox(R1, 1), f.io); // index v0
  await saveHoldingCopy(k, R2, makeBox(R2, 1, 20), f.io); // index v1
  const v1 = JSON.parse(f.feeds.get(`${k.signer.address.slice(2)}|${indexTopic(k)}`)![1]!) as { enc: string };
  // Its X25519 half zeroed: a well-formed box whose key exchange cannot complete.
  f.put(k.signer.address, indexTopic(k), 1, { ...v1, enc: v1.enc.slice(0, v1.enc.length - 64) + "0".repeat(64) });
  jam(f, k, 2, 0);
  assert.equal(await readHoldingIndex(k, f.io), "unavailable");
  assert.deepEqual(f.readsAt, [`${indexTopic(k)}@1`], "never walked on to v0");
});

test("a key or decapsulation fault is not a jam: nothing is walked or written", async () => {
  const f = fakeFeeds();
  const k = await gen(S0);
  await saveHoldingCopy(k, R1, makeBox(R1, 1), f.io);
  const broken = { ...k, orderSecretKey: new Uint8Array(5) };
  assert.equal(await readHoldingIndex(broken, f.io), "unavailable");
  assert.deepEqual(f.readsAt, []);
  const n = f.writes.length;
  await assert.rejects(addToHoldingIndex(broken, [holdingIndexEntryOf(holdingPickupId(R2), makeBox(R2, 1))], f.io), /could not be read/);
  assert.equal(f.writes.length, n);
});

// ---------------------------------------------------------------------------
// A jammed list (Fable 3a, 5): two writers raced at one version and its pages
// interleaved, so it is spent or does not open. No save counted on it.
// ---------------------------------------------------------------------------

/** The sealed list at `version`, its ciphertext damaged as interleaved pages leave it. */
function jam(f: ReturnType<typeof fakeFeeds>, k: HoldingGenKeys, version: number, from: number) {
  const good = JSON.parse(f.feeds.get(`${k.signer.address.slice(2)}|${indexTopic(k)}`)![from]!) as { ct: string };
  const ct = good.ct.slice(0, 40) + (good.ct[40] === "0" ? "1" : "0") + good.ct.slice(41);
  f.put(k.signer.address, indexTopic(k), version, { ...good, ct });
}

async function listed(k: HoldingGenKeys, io: ReturnType<typeof fakeFeeds>["io"]) {
  const index = await readHoldingIndex(k, io);
  assert.ok(index && index !== "unavailable", `list read: ${String(index)}`);
  return index.orders.map((e) => e.pickupId).sort();
}

test("a jammed head that does not open: the newest version below it is the list, and the next save goes on top", async () => {
  const f = fakeFeeds();
  const k = await gen(S0);
  await saveHoldingCopy(k, R1, makeBox(R1, 1), f.io); // index v0
  await saveHoldingCopy(k, R2, makeBox(R2, 1, 20), f.io); // index v1
  jam(f, k, 2, 1);
  assert.deepEqual(await listed(k, f.io), [R1, R2].map((r) => holdingPickupId(r)).sort());
  assert.deepEqual(f.readsAt, [`${indexTopic(k)}@1`]);

  assert.equal(await saveHoldingCopy(k, R3, makeBox(R3, 1, 30), f.io), "saved");
  const indexWrites = f.writes.filter((w) => w.topic === indexTopic(k));
  assert.equal(indexWrites.at(-1)!.version, 3, "written past the jam");
  f.readsAt.length = 0;
  assert.deepEqual(await listed(k, f.io), [R1, R2, R3].map((r) => holdingPickupId(r)).sort());
  assert.deepEqual(f.readsAt, [], "healed: the head opens again");
});

test("a spent head: built from the newest version below that opens, past a run of jams", async () => {
  const f = fakeFeeds();
  const k = await gen(S0);
  await saveHoldingCopy(k, R1, makeBox(R1, 1), f.io); // index v0
  jam(f, k, 1, 0);
  f.spentBelow.add(`${indexTopic(k)}@2`);
  f.put(k.signer.address, indexTopic(k), 3, { torn: true });
  f.spent.set(indexTopic(k), 3);
  assert.deepEqual(await listed(k, f.io), [holdingPickupId(R1)]);
  assert.deepEqual(f.readsAt, [2, 1, 0].map((v) => `${indexTopic(k)}@${v}`));

  assert.equal(await saveHoldingCopy(k, R2, makeBox(R2, 1, 20), f.io), "saved");
  assert.equal(f.writes.filter((w) => w.topic === indexTopic(k)).at(-1)!.version, 4);
  f.spent.clear();
  assert.deepEqual(await listed(k, f.io), [R1, R2].map((r) => holdingPickupId(r)).sort());
});

test("a jam at the first version: nothing below it was ever listed, so the list starts empty", async () => {
  const f = fakeFeeds();
  const k = await gen(S0);
  await saveHoldingCopy(k, R1, makeBox(R1, 1), f.io); // index v0
  jam(f, k, 0, 0);
  assert.equal(await readHoldingIndex(k, f.io), null);
  assert.equal(await saveHoldingCopy(k, R2, makeBox(R2, 1, 20), f.io), "saved");
  assert.deepEqual(await listed(k, f.io), [holdingPickupId(R2)]);

  const g = fakeFeeds();
  g.put(k.signer.address, indexTopic(k), 0, { torn: true });
  g.spent.set(indexTopic(k), 0);
  assert.equal(await readHoldingIndex(k, g.io), null);
});

test("walking down a jam stops on anything uncertain: an unanswered read, a gap, a newer layout, the cap", async () => {
  const k = await gen(S0);
  const setup = async () => {
    const f = fakeFeeds();
    await saveHoldingCopy(k, R1, makeBox(R1, 1), f.io); // index v0
    await saveHoldingCopy(k, R2, makeBox(R2, 1, 20), f.io); // index v1
    jam(f, k, 2, 1);
    return f;
  };
  const refusesToWrite = async (f: Awaited<ReturnType<typeof setup>>) => {
    assert.equal(await readHoldingIndex(k, f.io), "unavailable");
    const n = f.writes.length;
    await assert.rejects(addToHoldingIndex(k, [holdingIndexEntryOf(holdingPickupId(R3), makeBox(R3, 1, 30))], f.io));
    assert.equal(f.writes.length, n);
  };

  const unanswered = await setup();
  unanswered.failReadsAt.add(`${indexTopic(k)}@1`);
  await refusesToWrite(unanswered);

  const gap = await setup();
  gap.feeds.get(`${k.signer.address.slice(2)}|${indexTopic(k)}`)![1] = undefined as unknown as string;
  await refusesToWrite(gap);

  const newer = await setup();
  newer.put(k.signer.address, indexTopic(k), 1, await sealBoxJsonCompressed(k.orderPublicKey, { v: 9 }, holdingIndexSealContext(indexTopic(k))));
  await refusesToWrite(newer);

  // A run of jams longer than the cap is not walked to its end.
  const { HOLDING_INDEX_WALK_MAX } = await import("../src/lib/holding/account-copy.ts");
  const long = await setup();
  const head = HOLDING_INDEX_WALK_MAX + 3;
  for (let v = 2; v < head; v++) long.spentBelow.add(`${indexTopic(k)}@${v}`);
  long.put(k.signer.address, indexTopic(k), head, { torn: true });
  long.spent.set(indexTopic(k), head);
  await refusesToWrite(long);
  assert.ok(long.readsAt.length <= 2 * HOLDING_INDEX_WALK_MAX, "never past the cap");
  // One short of the cap still reaches the good version.
  const reach = await setup();
  const near = HOLDING_INDEX_WALK_MAX + 1;
  for (let v = 2; v < near; v++) reach.spentBelow.add(`${indexTopic(k)}@${v}`);
  reach.put(k.signer.address, indexTopic(k), near, { torn: true });
  reach.spent.set(indexTopic(k), near);
  assert.deepEqual(await listed(k, reach.io), [R1, R2].map((r) => holdingPickupId(r)).sort());
});

test("a jammed list reads complete for a mover: every order a save counted on is below the jam", async () => {
  const f = fakeFeeds();
  const g0 = await gen(S0);
  const g1 = await gen(S1);
  await saveHoldingCopy(g0, R1, makeBox(R1, 1), f.io);
  await saveHoldingCopy(g0, R2, makeBox(R2, 1, 20), f.io);
  jam(f, g0, 2, 1);
  const all = await readAllHoldingCopies([g0], f.io);
  assert.equal(all.complete, true);
  assert.equal(await moveHoldingCopies([g0], g1, f.io), 2);
});

test("a save whose sealed bytes do not open under the account's key is not saved", async () => {
  // A key pair that does not match (a bug, not an attack): caught before anything trusts it.
  const f = fakeFeeds();
  const k = { ...(await gen(S0)), orderPublicKey: (await gen(S1)).orderPublicKey };
  await assert.rejects(writeHoldingCopy(k, holdingCopyOf(R1, makeBox(R1, 1)), f.io), /saved receipt does not open/);
  await assert.rejects(saveHoldingCopy(k, R1, makeBox(R1, 1), f.io), /does not open/);
  const g = fakeFeeds();
  const good = await gen(S0);
  await saveHoldingCopy(good, R1, makeBox(R1, 1), g.io);
  await assert.rejects(addToHoldingIndex(k, [holdingIndexEntryOf(holdingPickupId(R2), makeBox(R2, 1))], g.io), /does not open/);
});

test("an unconfirmed copy is not saved, and its index line is not written", async () => {
  const f = fakeFeeds();
  const k = await gen(S0);
  f.unconfirmAfter = 0;
  assert.equal(await saveHoldingCopy(k, R1, makeBox(R1, 1), f.io), "unconfirmed");
  assert.equal(f.writes.filter((w) => w.topic === indexTopic(k)).length, 0);
  // The bytes did land: the next attempt finds them and only adds the line.
  f.unconfirmAfter = Infinity;
  assert.equal(await saveHoldingCopy(k, R1, makeBox(R1, 1), f.io), "saved");
  assert.equal(f.writes.filter((w) => w.topic !== indexTopic(k)).length, 1);
});

test("an unconfirmed index line is not saved", async () => {
  const f = fakeFeeds();
  const k = await gen(S0);
  f.unconfirmAfter = 1;
  assert.equal(await saveHoldingCopy(k, R1, makeBox(R1, 1), f.io), "unconfirmed");
});

test("a generation finds and opens only its own copies", async () => {
  const f = fakeFeeds();
  const a = await gen(S0);
  const b = await gen(S1);
  await saveHoldingCopy(a, R1, makeBox(R1, 1), f.io);
  assert.equal(await readHoldingIndex(b, f.io), null);
  assert.equal(await readHoldingCopy(b, holdingPickupId(R1), f.io), null);
  // The same bytes copied under b's signer and topic still do not open: sealed to a's key.
  // A well-formed box that fails its tag reads as a JAM (Fable 3c PR 1 delta, inherent: the
  // two cannot be told apart), so with nothing below it b holds no copy - never a's.
  const sealed = f.latest(a.signer.address, holdingCopyTopic(a.salt, holdingPickupId(R1)));
  f.put(b.signer.address, holdingCopyTopic(b.salt, holdingPickupId(R1)), 0, sealed);
  assert.equal(await readHoldingCopy(b, holdingPickupId(R1), f.io), null);
  // Listed in b's index all the same, that missing copy keeps a mover from calling b complete.
  await addToHoldingIndex(b, [holdingIndexEntryOf(holdingPickupId(R1), makeBox(R1, 1))], f.io);
  assert.equal((await readAllHoldingCopies([b], f.io)).complete, false);
});

/** Another writer's interleaved pages at `version` of `topic`: a well-formed box that fails its tag. */
function jamAt(f: ReturnType<typeof fakeFeeds>, owner: string, topic: string, version: number, from: number) {
  const good = JSON.parse(f.feeds.get(`${owner.slice(2)}|${topic}`)![from]!) as { ct: string };
  const ct = good.ct.slice(0, 40) + (good.ct[40] === "0" ? "1" : "0") + good.ct.slice(41);
  f.put(owner, topic, version, { ...good, ct });
}

test("a jammed copy reads as the newest version below it that opens: one race never stops a mover (Fable 3c PR 1)", async () => {
  const f = fakeFeeds();
  const g0 = await gen(S0);
  const g1 = await gen(S1);
  const id = holdingPickupId(R1);
  const topic = holdingCopyTopic(g0.salt, id);
  await saveHoldingCopy(g0, R1, makeBox(R1, 2), f.io); // copy v0
  jamAt(f, g0.signer.address, topic, 1, 0);
  const copy = await readHoldingCopy(g0, id, f.io);
  assert.ok(copy && copy !== "unavailable" && sameHoldingCopy(copy, holdingCopyOf(R1, makeBox(R1, 2))));
  assert.deepEqual(f.readsAt, [`${topic}@0`]);
  assert.equal((await readAllHoldingCopies([g0], f.io)).complete, true);
  assert.equal(await moveHoldingCopies([g0], g1, f.io), 1);

  // A spent head is walked past only for a race (every chunk found): a page that reads absent stops.
  const spent = fakeFeeds();
  await saveHoldingCopy(g0, R1, makeBox(R1, 2), spent.io);
  spent.put(g0.signer.address, topic, 1, { torn: true });
  spent.spent.set(topic, 1);
  assert.ok(sameHoldingCopy((await readHoldingCopy(g0, id, spent.io)) as never, holdingCopyOf(R1, makeBox(R1, 2))));
  spent.spentBy.set(`${topic}@1`, "missing-page");
  assert.equal(await readHoldingCopy(g0, id, spent.io), "unavailable");

  // A copy that opens and is in a layout this build does not know is never "none".
  const newer = fakeFeeds();
  const { holdingCopySealContext } = await import("@woco/shared/crypto/sealed-box");
  newer.put(g0.signer.address, topic, 0, await sealBoxJsonCompressed(g0.orderPublicKey, { v: 9 }, holdingCopySealContext(id)));
  assert.equal(await readHoldingCopy(g0, id, newer.io), "unavailable");

  // Walking down stops on anything uncertain: here, a version below that does not answer.
  const unsure = fakeFeeds();
  await saveHoldingCopy(g0, R1, makeBox(R1, 2), unsure.io);
  jamAt(unsure, g0.signer.address, topic, 1, 0);
  unsure.failReadsAt.add(`${topic}@0`);
  assert.equal(await readHoldingCopy(g0, id, unsure.io), "unavailable");
  assert.equal((await readAllHoldingCopies([g0], unsure.io)).complete, false);
});

test("a list screen reads every generation's list, shows one the scan could not see past, and says when one is missing", async () => {
  const f = fakeFeeds();
  const g0 = await gen(S0);
  const g1 = await gen(S1);
  await saveHoldingCopy(g0, R1, makeBox(R1, 1), f.io);
  await saveHoldingCopy(g0, R2, makeBox(R2, 1, 20), f.io);
  const remade = makeBox(R1, 1, 50);
  await saveHoldingCopy(g1, R1, remade, f.io);

  const all = await listHeldOrders([g0, g1], f.io);
  assert.equal(all.complete, true);
  const byId = new Map(all.orders.map((o) => [o.pickupId, o]));
  assert.equal(byId.size, 2);
  assert.deepEqual(byId.get(holdingPickupId(R1))!.editions, [51], "the newest generation's line wins");

  // The scan stops one version short of g0's head: a mover refuses, a list shows that version.
  f.dirty.add(indexTopic(g0));
  assert.equal(await readHoldingIndex(g0, f.io), "unavailable");
  const early = await listHeldOrders([g0], f.io);
  assert.deepEqual(early.orders.map((o) => o.pickupId), [holdingPickupId(R1)]);
  assert.equal(early.complete, true);
  f.dirty.clear();

  // An unreadable generation: the rest still shows, and the list says it is not whole.
  f.failReads.add(indexTopic(g1));
  const part = await listHeldOrders([g0, g1], f.io);
  assert.equal(part.complete, false);
  assert.deepEqual(part.orders.map((o) => o.pickupId).sort(), [R1, R2].map((r) => holdingPickupId(r)).sort());
  // Never written from: reading lists writes nothing.
  const n = f.writes.length;
  await listHeldOrders([g0, g1], f.io);
  assert.equal(f.writes.length, n);
});

test("saves for one copy signer run one at a time: the copy and its line, every carried copy and the list (Fable 3c PR 1)", async () => {
  const f = fakeFeeds();
  const k = await gen(S0);
  const to = await gen(S1);
  const held: string[] = [];
  let active = 0;
  let most = 0;
  const { withWebLock } = await import("../src/lib/utils/web-lock.ts");
  f.io.exclusive = (owner, save) => {
    held.push(owner);
    return withWebLock(`test:${owner}`, async () => {
      most = Math.max(most, ++active);
      try {
        await new Promise((r) => setTimeout(r, 5));
        return await save();
      } finally {
        active--;
      }
    }, { timeoutMs: 10_000, locks: null });
  };
  const outs = await Promise.all([
    saveHoldingCopy(k, R1, makeBox(R1, 1), f.io),
    saveHoldingCopy(k, R2, makeBox(R2, 1, 20), f.io),
    saveHoldingCopy(k, R3, makeBox(R3, 1, 30), f.io),
  ]);
  assert.deepEqual(outs, ["saved", "saved", "saved"]);
  assert.equal(most, 1, "never two at once");
  assert.deepEqual(held, [k.signer.address, k.signer.address, k.signer.address].map((a) => a.toLowerCase()));
  assert.deepEqual(await listed(k, f.io), [R1, R2, R3].map((r) => holdingPickupId(r)).sort());
  // Each save is one copy version and one list version: none was superseded.
  assert.equal(f.writes.length, 6);

  held.length = 0;
  assert.equal(await moveHoldingCopies([k], to, f.io), 3);
  assert.deepEqual(held, [to.signer.address.toLowerCase()], "the carry holds the NEW signer's lock, once");
});

test("a copy filed under another order's id is refused", async () => {
  const f = fakeFeeds();
  const k = await gen(S0);
  await saveHoldingCopy(k, R1, makeBox(R1, 1), f.io);
  const { holdingCopySealContext } = await import("@woco/shared/crypto/sealed-box");
  // R2's copy, sealed under R1's context and filed at R1's topic: opens, but is not R1's.
  const wrong = await sealBoxJsonCompressed(k.orderPublicKey, holdingCopyOf(R2, makeBox(R2, 1)), holdingCopySealContext(holdingPickupId(R1)));
  f.put(k.signer.address, holdingCopyTopic(k.salt, holdingPickupId(R1)), 1, wrong);
  assert.equal(await readHoldingCopy(k, holdingPickupId(R1), f.io), "unavailable");
});

test("reading every generation: the newest copy of an order wins; a missing or unreadable one makes it incomplete", async () => {
  const f = fakeFeeds();
  const g0 = await gen(S0);
  const g1 = await gen(S1);
  await saveHoldingCopy(g0, R1, makeBox(R1, 1), f.io);
  await saveHoldingCopy(g0, R2, makeBox(R2, 1, 20), f.io);
  const remade = makeBox(R1, 1, 50);
  await saveHoldingCopy(g1, R1, remade, f.io);

  const all = await readAllHoldingCopies([g0, g1], f.io);
  assert.equal(all.complete, true);
  const byId = new Map(all.copies.map((c) => [c.entry.pickupId, c]));
  assert.equal(byId.size, 2);
  assert.ok(sameHoldingCopy(byId.get(holdingPickupId(R1))!.copy, holdingCopyOf(R1, remade)));

  // Listed in g0's index but the copy cannot be read.
  f.failReads.add(holdingCopyTopic(g0.salt, holdingPickupId(R2)));
  assert.equal((await readAllHoldingCopies([g0, g1], f.io)).complete, false);
  f.failReads.clear();
  f.failReads.add(indexTopic(g0));
  assert.equal((await readAllHoldingCopies([g0, g1], f.io)).complete, false);
});

test("move: every generation's copies land under the new keys, read back; a second run writes nothing", async () => {
  const f = fakeFeeds();
  const g0 = await gen(S0);
  const g1 = await gen(S1);
  const g2 = await gen(S2);
  await saveHoldingCopy(g0, R1, makeBox(R1, 2), f.io);
  await saveHoldingCopy(g1, R2, makeBox(R2, 1, 20), f.io);
  assert.equal(await moveHoldingCopies([g0, g1], g2, f.io), 2);
  const moved = await readAllHoldingCopies([g2], f.io);
  assert.equal(moved.complete, true);
  assert.deepEqual(moved.copies.map((c) => c.entry.pickupId).sort(), [holdingPickupId(R1), holdingPickupId(R2)].sort());
  // One index write for the lot.
  assert.equal(f.writes.filter((w) => w.topic === indexTopic(g2)).length, 1);
  const n = f.writes.length;
  assert.equal(await moveHoldingCopies([g0, g1], g2, f.io), 2);
  assert.equal(f.writes.length, n);
  // The old copies stay where they were.
  assert.equal((await readAllHoldingCopies([g0], f.io)).copies.length, 1);
});

test("a list or copy read that may have stopped short of the head is never taken as complete (Fable 3a, 1)", async () => {
  const f = fakeFeeds();
  const g0 = await gen(S0);
  const g1 = await gen(S1);
  await saveHoldingCopy(g0, R1, makeBox(R1, 1), f.io);
  await saveHoldingCopy(g0, R2, makeBox(R2, 1, 20), f.io);
  // The list's scan stops one version early: it would show R1 only.
  f.dirty.add(indexTopic(g0));
  assert.equal(await readHoldingIndex(g0, f.io), "unavailable");
  assert.equal((await readAllHoldingCopies([g0], f.io)).complete, false);
  const n = f.writes.length;
  await assert.rejects(moveHoldingCopies([g0], g1, f.io));
  assert.equal(f.writes.length, n, "nothing carried off a short list");
  f.dirty.clear();

  // A copy read the same way.
  f.dirty.add(holdingCopyTopic(g0.salt, holdingPickupId(R1)));
  assert.equal(await readHoldingCopy(g0, holdingPickupId(R1), f.io), "unavailable");
  assert.equal((await readAllHoldingCopies([g0], f.io)).complete, false);
});

test("'already there' is said only off a read that is certainly the head", async () => {
  const f = fakeFeeds();
  const k = await gen(S0);
  // v0 = the first box, v1 = a box re-made later; a short scan sees v0.
  await saveHoldingCopy(k, R1, makeBox(R1, 1), f.io);
  await saveHoldingCopy(k, R1, makeBox(R1, 1, 40), f.io);
  f.dirty.add(holdingCopyTopic(k.salt, holdingPickupId(R1)));
  await assert.rejects(saveHoldingCopy(k, R1, makeBox(R1, 1), f.io), "never 'saved' off v0");
  f.dirty.clear();
  // The list the same way: a short scan of it never decides "already listed".
  await saveHoldingCopy(k, R2, makeBox(R2, 1, 20), f.io);
  f.dirty.add(indexTopic(k));
  const writes = f.writes.length;
  await assert.rejects(addToHoldingIndex(k, [holdingIndexEntryOf(holdingPickupId(R1), makeBox(R1, 1, 40))], f.io));
  assert.equal(f.writes.length, writes);
});

test("copies are owned by the account's own copy signer, never its public content-feed signer", async () => {
  const { deriveFeedSignerKey } = await import("@woco/shared");
  const { holdingCopySigner } = await import("@woco/shared/holding/copy");
  const { hexToBytes } = await import("@noble/hashes/utils.js");
  const k = await gen(S0);
  assert.equal(k.signer.address, holdingCopySigner(hexToBytes(S0.slice(2))).address);
  assert.notEqual(k.signer.address, deriveFeedSignerKey(S0).address.toLowerCase());
  const f = fakeFeeds();
  await saveHoldingCopy(k, R1, makeBox(R1, 1), f.io);
  for (const w of f.writes) assert.equal(w.owner, k.signer.address);
});

test("move: an incomplete read moves nothing; nothing to move writes nothing", async () => {
  const f = fakeFeeds();
  const g0 = await gen(S0);
  const g1 = await gen(S1);
  await saveHoldingCopy(g0, R1, makeBox(R1, 1), f.io);
  f.failReads.add(holdingCopyTopic(g0.salt, holdingPickupId(R1)));
  const n = f.writes.length;
  await assert.rejects(moveHoldingCopies([g0], g1, f.io));
  assert.equal(f.writes.length, n);

  const empty = fakeFeeds();
  assert.equal(await moveHoldingCopies([g0], g1, empty.io), 0);
  assert.equal(empty.writes.length, 0);
  // Not even a read of the new generation: a never-written feed's thorough read can come
  // back inconclusive, and would hold the removal open for an account with no receipts.
  assert.deepEqual(empty.reads, [indexTopic(g0)]);
});

test("move: a copy or index that does not read back under the new keys fails the move", async () => {
  const g0 = await gen(S0);
  const g1 = await gen(S1);
  for (const after of [0, 1]) {
    const f = fakeFeeds();
    await saveHoldingCopy(g0, R1, makeBox(R1, 1), f.io);
    f.unconfirmAfter = f.writes.length + after;
    await assert.rejects(moveHoldingCopies([g0], g1, f.io));
  }
  const f = fakeFeeds();
  await assert.doesNotReject(writeHoldingCopies(g1, [], f.io));
  assert.equal(f.writes.length, 0);
});

test("the index is sealed to the generation's order key, bound to its topic", async () => {
  const f = fakeFeeds();
  const k = await gen(S0);
  await saveHoldingCopy(k, R1, makeBox(R1, 1), f.io);
  const sealed = f.latest(k.signer.address, indexTopic(k));
  const opened = await openBoxJson(k.orderSecretKey, sealed, holdingIndexSealContext(indexTopic(k)));
  assert.deepEqual(opened, { v: 1, orders: [holdingIndexEntryOf(holdingPickupId(R1), makeBox(R1, 1))] });
});
