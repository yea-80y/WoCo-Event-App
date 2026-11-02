/**
 * #983 held tickets: each emailed ticket's QR sealed to the organiser's order key, the
 * copy a bounced ticket is resent from. The server must never be able to read one back,
 * a sale keeps its first copy, and a copy that cannot be read is never written over.
 *
 * MUTATION: drop the re-read after the awaits and "write-once" goes red; overwrite an
 * unreadable file and "never overwritten" goes red; seal every ticket under one edition
 * and "each ticket opens under its own seat" goes red; let a malformed session id through
 * and "nothing outside the directory" goes red.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveXWingKeypairFromSeed } from "@woco/shared/crypto/xwing";
import { openBoxJson, ticketHoldSealContext } from "@woco/shared/crypto/sealed-box";

const EVENT = "e0000000-0000-4000-8000-000000000983";
const SERIES = "s0000000-0000-4000-8000-000000000001";
const KEY_REF = "ab".repeat(32);
const ORGANISER = deriveXWingKeypairFromSeed("0x" + "4d".repeat(32));
const SIG = `0x${"cd".repeat(65)}`;
const qr = (edition: number) => `woco://t/${EVENT}/${SERIES}/${edition}/${SIG}`;
const sid = (n: number) => `cs_test_hold${String(n).padStart(10, "0")}`;

let dir: string;
let originalCwd: string;
let store: typeof import("../src/lib/ticket-hold/store.js");
const keyReads: string[] = [];
const fetchKey = async (ref: string) => {
  keyReads.push(ref);
  return ORGANISER.publicKey;
};
const input = (sessionId: string, editions = [1, 2]) => ({
  sessionId,
  eventId: EVENT,
  seriesId: SERIES,
  orderKeyRef: KEY_REF,
  tickets: editions.map((edition) => ({ edition, qrContent: qr(edition) })),
});
const holdFile = (sessionId: string) => join(dir, ".data", "ticket-holds", `${sessionId}.json`);

before(async () => {
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "woco-983-holds-"));
  process.chdir(dir);
  store = await import("../src/lib/ticket-hold/store.js");
});

after(() => {
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

test("each ticket is sealed to the organiser's key and opens only under its own seat", async () => {
  assert.equal(await store.holdTickets(input(sid(1)), fetchKey), true);
  assert.deepEqual(keyReads, [KEY_REF], "the key named, never another");
  const hold = store.getTicketHold(sid(1))!;
  assert.equal(hold.eventId, EVENT);
  assert.equal(hold.orderKeyRef, KEY_REF);
  assert.deepEqual(hold.tickets.map((t) => t.edition), [1, 2]);
  for (const t of hold.tickets) {
    const opened = await openBoxJson(ORGANISER.secretKey, t.box, ticketHoldSealContext(EVENT, SERIES, t.edition, sid(1)));
    assert.deepEqual(opened, { v: 1, sessionId: sid(1), seriesId: SERIES, edition: t.edition, qrContent: qr(t.edition) });
    assert.equal(t.qrHash, store.ticketQrHash(qr(t.edition)), "what a resend must match");
  }
  await assert.rejects(openBoxJson(ORGANISER.secretKey, hold.tickets[0]!.box, ticketHoldSealContext(EVENT, SERIES, 2, sid(1))));
  await assert.rejects(openBoxJson(ORGANISER.secretKey, hold.tickets[0]!.box, ticketHoldSealContext(EVENT, SERIES, 1, sid(9))), "another sale's");
  assert.ok(!readFileSync(holdFile(sid(1)), "utf-8").includes(SIG), "no QR in the clear on disk");
});

test("write-once: a sale keeps its first copy, with no second key read", async () => {
  const first = readFileSync(holdFile(sid(1)), "utf-8");
  store._dropTicketHoldCacheForTests();
  const reads = keyReads.length;
  assert.equal(await store.holdTickets(input(sid(1), [7]), fetchKey), true);
  assert.equal(readFileSync(holdFile(sid(1)), "utf-8"), first);
  assert.equal(keyReads.length, reads, "a retried webhook costs no bee read");
});

test("two holds of one sale at once: the first to finish wins, the other writes nothing", async () => {
  const slowKey = async (ref: string) => {
    await new Promise((r) => setTimeout(r, 30));
    return fetchKey(ref);
  };
  const [a, b] = await Promise.all([store.holdTickets(input(sid(2), [1]), fetchKey), store.holdTickets(input(sid(2), [9]), slowKey)]);
  assert.equal(a && b, true);
  store._dropTicketHoldCacheForTests();
  assert.deepEqual(store.getTicketHold(sid(2))!.tickets.map((t) => t.edition), [1]);
});

test("a copy present but unreadable is never overwritten, and alarms", async () => {
  mkdirSync(join(dir, ".data", "ticket-holds"), { recursive: true });
  writeFileSync(holdFile(sid(3)), "{ not json");
  store._dropTicketHoldCacheForTests();
  assert.equal(await store.holdTickets(input(sid(3)), fetchKey), false);
  assert.equal(readFileSync(holdFile(sid(3)), "utf-8"), "{ not json");
  assert.throws(() => store.getTicketHold(sid(3)), store.TicketHoldUnreadableError);
  const h = store.ticketHoldsHealth();
  assert.equal(h.ok, false);
  assert.equal(h.unreadable, 1);
  // Restored by an operator: green again.
  store.deleteTicketHold(sid(3));
  assert.equal(store.ticketHoldsHealth().ok, true);
});

test("an order key that cannot be read leaves no copy and never throws", async () => {
  const failedBefore = store.ticketHoldsHealth().failed;
  const ok = await store.holdTickets(input(sid(4)), async () => {
    throw new Error("bee down");
  });
  assert.equal(ok, false);
  assert.equal(existsSync(holdFile(sid(4))), false);
  assert.equal(store.ticketHoldsHealth().failed, failedBefore + 1);
});

test("nothing outside the directory: a session id that is not one writes nothing", async () => {
  const reads = keyReads.length;
  for (const bad of ["../escape", "cs_test_short", "cs_live_aaaaaaaaaa/../../x", ""]) {
    assert.equal(await store.holdTickets(input(bad), fetchKey), false, bad);
    assert.equal(store.getTicketHold(bad), null);
  }
  assert.equal(keyReads.length, reads, "refused before anything is fetched or sealed");
  assert.deepEqual(readdirSync(dir).sort(), [".data"]);
});

test("the QR hash is sha256 of the exact bytes", () => {
  assert.equal(store.ticketQrHash("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.notEqual(store.ticketQrHash(qr(1)), store.ticketQrHash(`${qr(1)} `));
});

test("copies are listed by event for the sweep, and delete with any half-written file", async () => {
  await store.holdTickets({ ...input(sid(5)), eventId: "e0000000-0000-4000-8000-000000000984" }, fetchKey);
  store._dropTicketHoldCacheForTests();
  const byEvent = store.ticketHoldsByEvent();
  assert.equal(store._ticketHoldCacheSizeForTests(), 0, "listing every copy keeps none of them in memory");
  assert.deepEqual(byEvent.get(EVENT)?.sort(), [sid(1), sid(2)]);
  assert.deepEqual(byEvent.get("e0000000-0000-4000-8000-000000000984"), [sid(5)]);
  writeFileSync(`${holdFile(sid(5))}.tmp`, "{}");
  store.deleteTicketHold(sid(5));
  assert.equal(existsSync(holdFile(sid(5))), false);
  assert.equal(existsSync(`${holdFile(sid(5))}.tmp`), false);
  assert.equal(store.getTicketHold(sid(5)), null);
});

test("memory holds at most 1000 copies, the oldest going first; disk keeps them all", async () => {
  store._dropTicketHoldCacheForTests();
  for (let n = 100; n < 1102; n++) {
    assert.equal(await store.holdTickets(input(sid(n), [1]), fetchKey), true);
  }
  assert.equal(store._ticketHoldCacheSizeForTests(), 1000);
  assert.ok(store.getTicketHold(sid(100)), "an evicted copy still reads from disk");
});
