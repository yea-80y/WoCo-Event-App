/**
 * The scanner's door entries rules (pure): pages, removals, resets, a box that does not
 * open, and which list wins at the door. Real sealing, as the server does it.
 *
 * MUTATION: let an "add" through after a "remove" and "a removal is final" goes red; skip
 * the reset and "another pass starts again" goes red; let a sale entry replace the
 * organiser's and "the organiser's roster wins" goes red; drop the plaintext/line check
 * and "a box for another ticket is refused" goes red; make one failed open throw and
 * "one bad line never stops the rest" goes red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { hexToBytes } from "@noble/hashes/utils.js";
import { doorEntriesKeypair } from "@woco/shared/checkin/door-entries-key";
import { doorKeyRefOf } from "@woco/shared/checkin/door-keys";
import { doorEntrySealContext, sealBoxJson } from "@woco/shared/crypto/sealed-box";
import type { DoorEntriesPage, DoorEntryLogItem, DoorEntryPlaintext, RosterEntry } from "@woco/shared";
import {
  applyDoorEntriesPage,
  emptyDoorEntries,
  fetchDoorEntriesPage,
  mergeDoorRoster,
  restoreDoorEntries,
  shouldFetchMore,
  toStoredDoorEntries,
  type DoorEntriesContext,
} from "../src/lib/scanner/door-entries.ts";

const EVENT = "0b3c5c1e-7d1a-4c55-9a8e-2f6d0e1b9c44";
const SERIES = "5d6e7f80-0000-4000-8000-000000000002";
const JTI = "a".repeat(32);
const P = hexToBytes("42".repeat(32));
const ctx: DoorEntriesContext = { eventId: EVENT, passSecret: P, seriesName: () => "General" };
const pk = doorEntriesKeypair(P).publicKey;

let seq = 0;
async function add(edition: number, plain: Partial<DoorEntryPlaintext> = {}, sealFor = { seriesId: SERIES, edition }): Promise<DoorEntryLogItem> {
  const body: DoorEntryPlaintext = { v: 1, seriesId: sealFor.seriesId, edition: sealFor.edition, email: `b${edition}@example.com`, buyerName: `Buyer ${edition}`, ...plain };
  const box = await sealBoxJson(pk, body, doorEntrySealContext(EVENT, JTI, sealFor.seriesId, sealFor.edition));
  return { seq: ++seq, kind: "add", seriesId: SERIES, edition, box, at: "2026-10-14T20:00:00Z" };
}
const remove = (edition: number): DoorEntryLogItem => ({ seq: ++seq, kind: "remove", seriesId: SERIES, edition, at: "2026-10-14T21:00:00Z" });
const page = (log: DoorEntryLogItem[], over: Partial<DoorEntriesPage> = {}): DoorEntriesPage => ({
  jti: JTI, doorKeyRef: doorKeyRefOf(pk), next: log.at(-1)?.seq ?? 0, reset: false, more: false, log, ...over,
});

test("a sale's entry opens as a roster entry marked as a sale, the card name as its name", async () => {
  const { state, failed } = await applyDoorEntriesPage(emptyDoorEntries(), page([await add(1)]), ctx);
  assert.equal(failed, 0);
  assert.deepEqual([...state.entries.values()], [
    { seriesId: SERIES, seriesName: "General", edition: 1, name: "Buyer 1", email: "b1@example.com", source: "sale" },
  ]);
  assert.equal(state.jti, JTI);
});

test("pages apply in turn, and the cursor moves", async () => {
  const p1 = page([await add(1), await add(2)]);
  const s1 = (await applyDoorEntriesPage(emptyDoorEntries(), p1, ctx)).state;
  const p2 = page([await add(3)]);
  const s2 = (await applyDoorEntriesPage(s1, p2, ctx)).state;
  assert.deepEqual([...s2.entries.keys()].sort(), [`${SERIES} 1`, `${SERIES} 2`, `${SERIES} 3`]);
  assert.equal(s2.next, p2.next);
});

test("a removal is final: the entry goes and a later add for it is ignored", async () => {
  const s1 = (await applyDoorEntriesPage(emptyDoorEntries(), page([await add(1), await add(2)]), ctx)).state;
  const s2 = (await applyDoorEntriesPage(s1, page([remove(2)]), ctx)).state;
  assert.equal(s2.entries.has(`${SERIES} 2`), false);
  assert.ok(s2.tombstones.has(`${SERIES} 2`));
  const s3 = (await applyDoorEntriesPage(s2, page([await add(2)]), ctx)).state;
  assert.equal(s3.entries.has(`${SERIES} 2`), false);
});

test("a reset, or a page for another pass, starts again from empty", async () => {
  const s1 = (await applyDoorEntriesPage(emptyDoorEntries(), page([await add(1), remove(9)]), ctx)).state;
  const reset = (await applyDoorEntriesPage(s1, page([], { reset: true, next: 0 }), ctx)).state;
  assert.equal(reset.entries.size, 0);
  assert.equal(reset.tombstones.size, 0);
  const other = (await applyDoorEntriesPage(s1, page([], { jti: "b".repeat(32), next: 0 }), ctx)).state;
  assert.equal(other.entries.size, 0);
  assert.equal(other.jti, "b".repeat(32));
});

test("one bad line never stops the rest: a box that does not open, or names another ticket, is skipped", async () => {
  const good = await add(1);
  const tampered = { ...(await add(2)), box: { v: 2, enc: "00".repeat(1120), ct: "00".repeat(40) } } as DoorEntryLogItem;
  const misfiled = await add(3, {}, { seriesId: SERIES, edition: 4 }); // sealed for ticket 4, filed as 3
  const { state, failed } = await applyDoorEntriesPage(emptyDoorEntries(), page([good, tampered, misfiled]), ctx);
  assert.equal(failed, 2);
  assert.deepEqual([...state.entries.keys()], [`${SERIES} 1`]);
});

test("a box whose plaintext names another ticket is refused even when it opens", async () => {
  const line = await add(5);
  const lying = async () => ({ v: 1 as const, seriesId: SERIES, edition: 6, email: "x@example.com" });
  const { state, failed } = await applyDoorEntriesPage(emptyDoorEntries(), page([line]), ctx, lying);
  assert.equal(failed, 1);
  assert.equal(state.entries.size, 0);
});

test("the door's list: tombstone hides, the organiser's roster wins, a sale fills the gap", async () => {
  const state = (await applyDoorEntriesPage(emptyDoorEntries(), page([await add(1), await add(2), remove(3)]), ctx)).state;
  const roster: RosterEntry[] = [
    { seriesId: SERIES, seriesName: "General", edition: 1, name: "Order-form name" },
    { seriesId: SERIES, seriesName: "General", edition: 3, name: "Erased person" },
  ];
  const list = mergeDoorRoster(roster, state);
  assert.deepEqual(list.map((r) => [r.edition, r.name, r.source]), [
    [1, "Order-form name", undefined],
    [2, "Buyer 2", "sale"],
  ]);
});


// ── what a reload starts from, and what the server's answers mean ───────────

test("a stored list restores under its own pass only; another pass's, or one that does not read, starts empty", async () => {
  const state = (await applyDoorEntriesPage(emptyDoorEntries(), page([await add(1), await add(2), remove(2)]), ctx)).state;
  const stored = toStoredDoorEntries(state);
  assert.deepEqual(JSON.parse(JSON.stringify(stored)), stored, "plain data: nothing depends on cloning a Map");
  const back = restoreDoorEntries(stored, JTI);
  assert.deepEqual([...back.entries.keys()], [`${SERIES} 1`]);
  assert.deepEqual([...back.tombstones], [`${SERIES} 2`]);
  assert.equal(back.next, state.next);

  for (const [what, value, jti] of [
    ["another pass's", stored, "b".repeat(32)],
    ["no pass id", stored, null],
    ["nothing stored", undefined, JTI],
    ["a bad cursor", { ...stored, next: -1 }, JTI],
    ["no arrays", { ...stored, entries: "x" }, JTI],
  ] as const) {
    const s = restoreDoorEntries(value, jti);
    assert.equal(s.entries.size + s.tombstones.size + s.next, 0, what);
    assert.equal(s.jti, null, what);
  }
  const hidden = restoreDoorEntries({ ...stored, entries: [...stored.entries, { seriesId: SERIES, edition: 2, email: "x@example.com" }] }, JTI);
  assert.equal(hidden.entries.has(`${SERIES} 2`), false, "a tombstone still hides a stored entry");
});

test("the server's answers: a page, a refused pass (expired or not), an outdated scanner, and everything else is 'later'", async () => {
  const pg = page([await add(1)]);
  const answer = (status: number, body: unknown) =>
    fetchDoorEntriesPage({ fetchFn: async () => Response.json(body, { status }), apiBase: "", eventId: EVENT, token: "t", deviceId: "dev00001", since: 0 });
  assert.deepEqual(await answer(200, { ok: true, data: pg }), { kind: "page", page: pg });
  assert.deepEqual(await answer(401, { ok: false, error: "Door pass revoked", reason: "revoked" }), { kind: "dead", message: "Door pass revoked", expired: false });
  assert.deepEqual(await answer(401, { ok: false, error: "Door pass expired", reason: "expired" }), { kind: "dead", message: "Door pass expired", expired: true });
  assert.equal((await answer(403, { ok: false, error: "Door pass is for a different event" })).kind, "dead");
  assert.equal((await answer(409, { ok: false, error: "one scanner", reason: "wrong-device" })).kind, "dead");
  assert.deepEqual(await answer(400, { ok: false, reason: "outdated-client" }), { kind: "outdated" });
  for (const [status, body] of [[503, { ok: false }], [500, null], [200, { ok: true }], [200, { ok: true, data: { ...pg, log: "x" } }], [400, { ok: false }]] as const) {
    assert.deepEqual(await answer(status, body), { kind: "later" }, `${status} ${JSON.stringify(body)}`);
  }
  const offline = await fetchDoorEntriesPage({ fetchFn: async () => { throw new TypeError("offline"); }, apiBase: "", eventId: EVENT, token: "t", deviceId: "d", since: 0 });
  assert.deepEqual(offline, { kind: "later" });
});

test("more pages: asked for at once only while the cursor moves", async () => {
  const pg = page([await add(1)], { next: 7, more: true });
  assert.equal(shouldFetchMore(pg, 3), true);
  assert.equal(shouldFetchMore({ ...pg, more: false }, 3), false);
  assert.equal(shouldFetchMore(pg, 7), false, "a server that says more without moving waits for the next tick");
  assert.equal(shouldFetchMore({ ...pg, next: 0, reset: true }, 9), true, "a log that started again is read from its start");
});

test("the door entries key is derived once per page, never per line, and zeroed after", async () => {
  const derived: Uint8Array[] = [];
  const counting: DoorEntriesContext = {
    ...ctx,
    deriveKeypair: (p) => {
      const kp = doorEntriesKeypair(p);
      derived.push(kp.secretKey);
      return kp;
    },
  };
  const lines = [await add(1), await add(2), remove(9), await add(3)];
  const { state, failed } = await applyDoorEntriesPage(emptyDoorEntries(), page(lines), counting);
  assert.equal(failed, 0);
  assert.equal(state.entries.size, 3, "every line opened");
  assert.equal(derived.length, 1, "one keygen for the whole page");
  assert.ok(derived[0].every((b) => b === 0), "the secret key is zeroed once the page is done");

  derived.length = 0;
  await applyDoorEntriesPage(emptyDoorEntries(), page([remove(10), remove(11)]), counting);
  assert.equal(derived.length, 0, "a page with nothing to open derives nothing");

  derived.length = 0;
  const throwing = async () => { throw new Error("does not open"); };
  await applyDoorEntriesPage(emptyDoorEntries(), page([await add(4)]), counting, throwing);
  assert.ok(derived.length === 1 && derived[0].every((b) => b === 0), "zeroed even when nothing opens");
});
