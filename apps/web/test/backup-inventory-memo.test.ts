/**
 * The backup panels' memo (#166 item 4, #689): what it may remember, and that a
 * write retires every read already running. Without the second, a read that
 * began before "add a backup" lands after it and pins the pre-add list for ten
 * minutes - the panel would say the new backup is not there.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { BackupInventoryEntry } from "@woco/shared";
import { BackupInventoryMemo } from "../src/lib/manifest/backup-inventory-memo.js";
import type { BackupHistoryRead } from "../src/lib/manifest/backup-inventory.js";

const P = `0x${"aa".repeat(20)}`;
const entry = (g: string) => ({ method: "wallet", guardianAddress: g, addedAt: 1 }) as BackupInventoryEntry;
const known = (gs: string[], settled = true): BackupHistoryRead => ({ status: "known", backups: gs.map(entry), settled });
const names = (r: BackupHistoryRead) => (r.status === "known" ? r.backups.map((b) => b.guardianAddress) : r.status);

/** A read the test finishes by hand. */
function pending() {
  let finish!: (r: BackupHistoryRead) => void;
  const promise = new Promise<BackupHistoryRead>((r) => (finish = r));
  return { load: () => promise, finish };
}

test("a settled answer is remembered; the next read costs nothing", async () => {
  const memo = new BackupInventoryMemo(60_000);
  let loads = 0;
  const load = async () => (loads++, known(["a"]));
  await memo.read(P, load);
  assert.deepEqual(names(await memo.read(P, load)), ["a"]);
  assert.equal(loads, 1);
});

test("an unsettled list and an unreadable manifest are shown, never remembered", async () => {
  for (const answer of [known(["a"], false), { status: "unavailable", reason: "x" } as BackupHistoryRead]) {
    const memo = new BackupInventoryMemo(60_000);
    let loads = 0;
    await memo.read(P, async () => (loads++, answer));
    await memo.read(P, async () => (loads++, answer));
    assert.equal(loads, 2);
  }
});

test("callers during one read share it", async () => {
  const memo = new BackupInventoryMemo(60_000);
  const r = pending();
  let loads = 0;
  const a = memo.read(P, () => (loads++, r.load()));
  const b = memo.read(P, () => (loads++, r.load()));
  r.finish(known(["a"]));
  assert.deepEqual([names(await a), names(await b)], [["a"], ["a"]]);
  assert.equal(loads, 1);
});

test("a write forgets the remembered list", async () => {
  const memo = new BackupInventoryMemo(60_000);
  await memo.read(P, async () => known(["a"]));
  memo.drop(); // a backup was added
  let loads = 0;
  assert.deepEqual(names(await memo.read(P, async () => (loads++, known(["a", "b"])))), ["a", "b"]);
  assert.equal(loads, 1, "the pre-write list was served from memory");
});

test("a read that began before a write is neither kept nor joined", async () => {
  const memo = new BackupInventoryMemo(60_000);
  const before = pending();
  const stale = memo.read(P, before.load);

  memo.drop(); // a backup was added
  const after = memo.read(P, async () => known(["a", "b"]));
  before.finish(known(["a"])); // the old read lands late
  assert.deepEqual(names(await stale), ["a"]);
  assert.deepEqual(names(await after), ["a", "b"], "a caller after the write joined the read from before it");

  let loads = 0;
  assert.deepEqual(names(await memo.read(P, async () => (loads++, known(["x"])))), ["a", "b"]);
  assert.equal(loads, 0, "the post-write answer is the one remembered");
});

test("the late read cannot overwrite even when nothing else has read since", async () => {
  const memo = new BackupInventoryMemo(60_000);
  const before = pending();
  const stale = memo.read(P, before.load);
  memo.drop();
  before.finish(known(["a"]));
  await stale;
  let loads = 0;
  await memo.read(P, async () => (loads++, known(["a", "b"])));
  assert.equal(loads, 1, "the pre-write list was remembered");
});

test("another account and an expired answer both read again", async () => {
  let now = 0;
  const memo = new BackupInventoryMemo(1_000, () => now);
  await memo.read(P, async () => known(["a"]));
  let loads = 0;
  await memo.read(`0x${"bb".repeat(20)}`, async () => (loads++, known([])));
  now = 1_001;
  await memo.read(P, async () => (loads++, known(["a"])));
  assert.equal(loads, 2);
});
