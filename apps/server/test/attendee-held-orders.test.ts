/**
 * Orders held until paid (#546). A paid order that is not yet on Swarm exists
 * only in this store, so it must survive restarts and never expire; an unpaid
 * one must be deleted after its day, and a full store must make room rather
 * than refuse a sale.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "woco-held-orders-"));
process.chdir(dir);
const held = await import("../src/lib/attendee-batch/held-orders.js");
const FILE = join(dir, ".data", "held-orders.json");

const T0 = Date.parse("2026-09-28T10:00:00Z");
const root = (n: number) => n.toString(16).padStart(64, "0");

test("a committed hold survives a restart; a paid one never expires, an unpaid one goes after a day", () => {
  held.commitHold(root(1), '{"v":2,"enc":"aa","ct":"bb"}', { eventId: "e1", seriesId: "s1" }, T0);
  held.commitHold(root(2), '{"v":2,"enc":"cc","ct":"dd"}', {}, T0);
  assert.equal(held.markHeldPaid(root(1), "cs_1", T0 + 60_000), true);
  held._resetHeldOrdersForTests();
  assert.equal(held.getHeldOrder(root(1))?.sessionId, "cs_1", "reloaded from disk");
  assert.equal(held.sweepExpired(T0 + held.HOLD_TTL_MS + 1), 1);
  assert.equal(held.getHeldOrder(root(2)), null, "unpaid hold deleted");
  assert.ok(held.getHeldOrder(root(1)), "paid hold kept");
  assert.deepEqual(held.paidUnstored().map((o) => o.root), [root(1)]);
  assert.equal(held.releaseHeldOrder(root(1)), true);
  assert.equal(held.getHeldOrder(root(1)), null);
});

test("a prepared hold is memory only: it never touches disk, and a restart forgets it", () => {
  const before = (() => { try { return readFileSync(FILE, "utf-8"); } catch { return ""; } })();
  held.holdPrepared(root(5), '{"prep":1}', T0);
  assert.equal(held.getHeldOrder(root(5))?.json, '{"prep":1}');
  const after = (() => { try { return readFileSync(FILE, "utf-8"); } catch { return ""; } })();
  assert.equal(after, before, "no write for a prepared hold");
  held.commitHold(root(5), null, { eventId: "e5" }, T0);
  held._resetHeldOrdersForTests();
  assert.equal(held.getHeldOrder(root(5))?.eventId, "e5", "committed hold reloads");
  held.holdPrepared(root(6), '{"prep":2}', T0);
  held._resetHeldOrdersForTests();
  assert.equal(held.getHeldOrder(root(6)), null, "prepared hold forgotten");
  assert.throws(() => held.commitHold(root(6), null, {}, T0), /nothing held/);
  held.releaseHeldOrder(root(5));
});

test("nothing held means nothing to claim: fulfilment falls back to its own seal", () => {
  assert.equal(held.markHeldPaid(root(99), "cs_x", T0), false);
});

test("the same reference cannot hold different bytes", () => {
  held.commitHold(root(3), '{"v":2,"enc":"01","ct":"02"}', {}, T0);
  held.commitHold(root(3), '{"v":2,"enc":"01","ct":"02"}', { eventId: "e3" }, T0);
  assert.equal(held.getHeldOrder(root(3))?.eventId, "e3");
  assert.throws(() => held.commitHold(root(3), '{"v":2,"enc":"01","ct":"03"}', {}, T0));
  held.releaseHeldOrder(root(3));
});

test("full stores evict the oldest UNPAID hold instead of refusing, and never a paid one", () => {
  held._setMaxUnpaidHoldsForTests(20);
  held.commitHold(root(10), "{}", {}, T0 - 1000);
  held.markHeldPaid(root(10), "cs_10", T0);
  for (let i = 0; i < 20; i++) held.commitHold(root(1000 + i), `{"i":${i}}`, {}, T0 + i);
  held.commitHold(root(999_999), '{"new":true}', {}, T0 + 20);
  assert.equal(held.getHeldOrder(root(1000)), null, "oldest unpaid evicted");
  assert.ok(held.getHeldOrder(root(999_999)), "new hold taken");
  assert.ok(held.getHeldOrder(root(10)), "paid hold untouched");
  for (let i = 0; i < 25; i++) held.holdPrepared(root(5000 + i), "{}", T0 + i);
  assert.equal(held.getHeldOrder(root(5000)), null, "oldest prepared evicted");
  assert.ok(held.getHeldOrder(root(5024)));
  for (let i = 0; i < 20; i++) held.releaseHeldOrder(root(1000 + i));
  for (let i = 0; i < 25; i++) held.releaseHeldOrder(root(5000 + i));
  held.releaseHeldOrder(root(999_999));
  held.releaseHeldOrder(root(10));
  held._setMaxUnpaidHoldsForTests(5_000);
});

test("health goes red when a paid order waits more than 15 minutes to be stored", () => {
  held.commitHold(root(20), "{}", {}, T0);
  held.markHeldPaid(root(20), "cs_20", T0);
  assert.equal(held.heldOrdersHealth(T0 + 14 * 60_000).ok, true);
  assert.equal(held.heldOrdersHealth(T0 + 16 * 60_000).ok, false);
  held.releaseHeldOrder(root(20));
});

// Last: leaves the file unreadable.
test("a present but unreadable store refuses new commits and is not overwritten", () => {
  writeFileSync(FILE, "{ not json");
  held._resetHeldOrdersForTests();
  assert.throws(() => held.commitHold(root(30), "{}", {}, T0));
  assert.equal(held.markHeldPaid(root(30), "cs", T0), false);
  assert.equal(held.heldOrdersHealth(T0).ok, false);
  assert.equal(readFileSync(FILE, "utf-8"), "{ not json");
});
