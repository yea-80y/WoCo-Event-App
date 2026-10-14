/**
 * The scanner's storage moved to a new database, "woco-scanner-v2", instead of
 * upgrading "woco-scanner" in place (Fable sign-off, 2026-10-14). An in-place
 * upgrade waits for every other connection to close, and the scanner deployed
 * before it holds one open in every tab it runs in - on an iPhone, each QR
 * scanned with the Camera app opens another Safari tab - so the page would sit
 * on "Loading…" forever. The legacy database is read WITHOUT a version (never an
 * upgrade, never blocked), copied in once, and deleted when the old tabs let go.
 * An old tab keeps writing check-ins to it after the copy, so every boot merges
 * those in (never over a record already here) before it asks for the delete.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CheckinRecord } from "@woco/shared";
import * as db from "../src/lib/scanner/db.js";
import { storeKey } from "../src/lib/scanner/scope.js";

const EVENT = "e0000000-0000-4000-8000-000000000001";
const PACK = { v: 1, eventId: EVENT, eventTitle: "Now", eventDate: "2026-10-20T19:00:00.000Z", series: [{ seriesId: "ser-now", name: "GA", totalSupply: 10 }], checkins: [], generatedAt: "2026-10-14T18:00:00.000Z" };
const PASS = { token: "v1.tok", keyB64url: "key", eventId: EVENT, exp: 1_900_000_000 };
const rec = (seriesId: string, edition: number): CheckinRecord =>
  ({ seriesId, edition, at: `2026-10-14T19:00:0${edition}.000Z`, deviceId: "legacydevice0001", method: "scan" });

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** A "woco-scanner" v1 database as the deployed scanner left it: per-ticket keys, no event. */
async function seedLegacy(f: IDBFactory, data: {
  kv?: Record<string, unknown>;
  checkins?: [string, unknown][];
  pending?: [string, unknown][];
}): Promise<IDBDatabase> {
  const open = f.open("woco-scanner", 1);
  open.onupgradeneeded = () => {
    for (const name of ["kv", "checkins", "pending"]) open.result.createObjectStore(name);
  };
  const legacy = await request(open);
  const t = legacy.transaction(["kv", "checkins", "pending"], "readwrite");
  for (const [k, v] of Object.entries(data.kv ?? {})) t.objectStore("kv").put(v, k);
  for (const [k, v] of data.checkins ?? []) t.objectStore("checkins").put(v, k);
  for (const [k, v] of data.pending ?? []) t.objectStore("pending").put(v, k);
  await new Promise((resolve) => (t.oncomplete = resolve));
  return legacy;
}

const names = async (f: IDBFactory) => (await f.databases()).map((d) => d.name).sort();

async function eventually(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`never happened: ${what}`);
}

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`blocked: ${what}`)), ms))]);
}

const LEGACY = {
  kv: {
    pass: PASS,
    pack: PACK,
    roster: [{ seriesId: "ser-now", edition: 1, name: "Ada" }],
    deviceId: "legacydevice0001",
    pendingClaims: { "ser-now 1": "claim-1", "ser-old 2": "claim-2" },
  },
  checkins: [["ser-now 1", rec("ser-now", 1)], ["ser-old 2", rec("ser-old", 2)]] as [string, unknown][],
  pending: [["ser-now 1", rec("ser-now", 1)], ["ser-old 2", rec("ser-old", 2)]] as [string, unknown][],
};

test("a legacy database is copied in under its event, and then deleted", async () => {
  const f = new IDBFactory();
  (await seedLegacy(f, LEGACY)).close();
  db.useIndexedDbForTests(f);

  assert.deepEqual(await db.getAllCheckins(EVENT), [rec("ser-now", 1)]);
  assert.deepEqual(await db.getPending(EVENT), [rec("ser-now", 1)]);
  assert.deepEqual(await db.getAllPendingKeys(), [storeKey(EVENT, "ser-now", 1)], "another event's record is not put under this one");
  assert.equal(await db.getPendingClaimId(EVENT, "ser-now", 1), "claim-1");
  assert.deepEqual(await db.getPass(EVENT), PASS, "the pass, pack and roster move under their event");
  assert.equal((await db.getPack(EVENT))?.eventTitle, "Now");
  assert.deepEqual(await db.getRoster(EVENT), [{ seriesId: "ser-now", edition: 1, name: "Ada" }]);
  assert.equal(await db.getDeviceId(), "legacydevice0001", "the same device id, so a single-scanner pass still knows this phone");
  await eventually(async () => !(await names(f)).includes("woco-scanner"), "legacy database deleted");
});

test("an open legacy connection in another tab does not hold the boot up", { timeout: 5_000 }, async () => {
  const f = new IDBFactory();
  const otherTab = await seedLegacy(f, LEGACY); // stays open; the deployed scanner sets no versionchange handler
  db.useIndexedDbForTests(f);

  assert.deepEqual(await within(db.getAllCheckins(EVENT), 2_000, "boot with a legacy tab open"), [rec("ser-now", 1)]);
  assert.ok((await names(f)).includes("woco-scanner"), "the delete waits for that tab...");
  otherTab.close();
  await eventually(async () => !(await names(f)).includes("woco-scanner"), "...and runs once it lets go");
});

test("a copy that never committed is redone from scratch; one that did is not, but later legacy check-ins are merged", async () => {
  const f = new IDBFactory();
  // What an interrupted earlier attempt could have left: the stores, a stray record, no marker.
  const pre = f.open("woco-scanner-v2", 1);
  pre.onupgradeneeded = () => {
    for (const name of ["kv", "passes", "packs", "rosters", "conflicts", "checkins", "pending", "claims"]) pre.result.createObjectStore(name);
  };
  const stale = await request(pre);
  const t = stale.transaction("checkins", "readwrite");
  t.objectStore("checkins").put(rec("ser-now", 9), storeKey(EVENT, "ser-now", 9));
  await new Promise((r) => (t.oncomplete = r));
  stale.close();
  (await seedLegacy(f, LEGACY)).close();

  db.useIndexedDbForTests(f);
  assert.deepEqual(await db.getAllCheckins(EVENT), [rec("ser-now", 1)], "cleared, then copied");

  // A check-in made after the copy, and a legacy database that reappears (an old
  // tab writing again): the same ticket under its own record, and a new one.
  await db.checkAndMark(EVENT, rec("ser-now", 3));
  const theirs = { ...rec("ser-now", 3), at: "2026-10-14T20:00:00.000Z", deviceId: "oldtab0000000001" };
  (await seedLegacy(f, {
    kv: { pack: PACK, pass: { ...PASS, token: "v1.other" }, roster: [] },
    checkins: [["ser-now 3", theirs], ["ser-now 5", rec("ser-now", 5)]],
    pending: [["ser-now 3", theirs], ["ser-now 5", rec("ser-now", 5)]],
  })).close();
  db.useIndexedDbForTests(f); // the next boot
  const after = await db.getAllCheckins(EVENT);
  assert.deepEqual(after.map((r) => r.edition), [1, 3, 5], "written to the legacy database after the copy: merged in");
  assert.deepEqual(after.find((r) => r.edition === 3), rec("ser-now", 3), "a record already here is never replaced");
  const pending = await db.getPending(EVENT);
  assert.deepEqual(pending.map((r) => r.edition), [1, 3, 5], "and queued to sync");
  assert.deepEqual(pending.find((r) => r.edition === 3), rec("ser-now", 3));
  assert.deepEqual(await db.getPass(EVENT), PASS, "the pass, pack and roster are copied once only");
  assert.equal((await db.getRoster(EVENT))?.length, 1);
});

test("an old tab's check-in after the copy survives the next boot's delete", { timeout: 5_000 }, async (t) => {
  const f = new IDBFactory();
  (await seedLegacy(f, LEGACY)).close();
  db.useIndexedDbForTests(f);
  await db.getAllCheckins(EVENT); // the copy; nothing holds the legacy database, so its delete runs
  await eventually(async () => !(await names(f)).includes("woco-scanner"), "first delete");
  // A tab still on the previous scanner opens it again, admits a ticket offline and stays open.
  const oldTab = await seedLegacy(f, { kv: { pack: PACK }, checkins: [["ser-now 4", rec("ser-now", 4)]], pending: [["ser-now 4", rec("ser-now", 4)]] });
  t.after(() => oldTab.close()); // a failed assertion must not leave the delete waiting and the run open
  db.useIndexedDbForTests(f); // the next boot merges, then asks for the delete, which waits for that tab
  assert.deepEqual((await within(db.getAllCheckins(EVENT), 2_000, "boot")).map((r) => r.edition), [1, 4]);
  assert.ok((await names(f)).includes("woco-scanner"), "the delete waits for the old tab...");
  oldTab.close(); // it reloads into this version
  await eventually(async () => !(await names(f)).includes("woco-scanner"), "...and runs once it lets go");
  db.useIndexedDbForTests(f);
  assert.deepEqual((await db.getAllCheckins(EVENT)).map((r) => r.edition), [1, 4], "its check-in outlived the delete");
  assert.deepEqual((await db.getPending(EVENT)).map((r) => r.edition), [1, 4]);
});

test("a later boot is not held up by an earlier boot's delete that an old tab still blocks", { timeout: 8_000 }, async (t) => {
  const f = new IDBFactory();
  const oldTab = await seedLegacy(f, LEGACY);
  t.after(() => oldTab.close());
  db.useIndexedDbForTests(f);
  await db.getAllCheckins(EVENT); // copied; its delete waits for the old tab
  db.useIndexedDbForTests(f); // another tab, or this one reloaded: a read of the legacy database queues behind that delete
  assert.deepEqual(await within(db.getAllCheckins(EVENT), 4_000, "a boot behind a waiting delete"), [rec("ser-now", 1)]);
  oldTab.close();
  await eventually(async () => !(await names(f)).includes("woco-scanner"), "the delete runs once the old tab lets go");
});

test("a boot that waited out a queued delete asks for no second one", { timeout: 8_000 }, async (t) => {
  const f = new IDBFactory();
  const oldTab = await seedLegacy(f, LEGACY);
  t.after(() => oldTab.close());
  db.useIndexedDbForTests(f);
  await db.getAllCheckins(EVENT); // copied; its delete waits for the old tab
  db.useIndexedDbForTests(f);
  const waiting = db.getAllCheckins(EVENT); // its read queues behind that delete
  await new Promise((r) => setTimeout(r, 50));
  // Another tab on the previous scanner opens the legacy database meanwhile: queued after that read.
  const another = seedLegacy(f, { kv: { pack: PACK }, checkins: [["ser-now 7", rec("ser-now", 7)]] });
  await waiting;
  oldTab.close(); // the first delete runs, then that tab recreates the database and admits a ticket
  const anotherTab = await another;
  anotherTab.close(); // a second delete, queued behind it, would now take that check-in
  db.useIndexedDbForTests(f);
  assert.deepEqual((await db.getAllCheckins(EVENT)).map((r) => r.edition), [1, 7]);
});

test("a legacy database that will not open fails the first copy, but never a boot after it", async () => {
  const real = new IDBFactory();
  (await seedLegacy(real, LEGACY)).close();
  let legacyBroken = true;
  const f = new Proxy(real, {
    get(target, prop) {
      if (prop === "open") {
        return (...args: Parameters<IDBFactory["open"]>) => {
          if (args[0] === "woco-scanner" && legacyBroken) throw new DOMException("storage unavailable", "UnknownError");
          return target.open(...args);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  db.useIndexedDbForTests(f);
  await assert.rejects(db.getAllCheckins(EVENT), "no copy yet: the boot must not go on without the legacy check-ins");
  legacyBroken = false;
  assert.deepEqual(await db.getAllCheckins(EVENT), [rec("ser-now", 1)], "the retry copies");
  await eventually(async () => !(await names(real)).includes("woco-scanner"), "first delete");
  (await seedLegacy(real, { kv: { pack: PACK }, checkins: [["ser-now 6", rec("ser-now", 6)]] })).close();
  legacyBroken = true;
  db.useIndexedDbForTests(f);
  assert.deepEqual(await db.getAllCheckins(EVENT), [rec("ser-now", 1)], "after the copy the boot goes on");
  assert.ok((await names(real)).includes("woco-scanner"), "and the unread legacy database is not deleted");
});

test("a record that cannot be read is skipped; the rest still move", async () => {
  const f = new IDBFactory();
  (await seedLegacy(f, {
    kv: { pack: PACK, pendingClaims: { "ser-now 1": 42, "nonsense": "x", "ser-now 2": "claim-ok" } },
    checkins: [
      ["a", null],
      ["b", { seriesId: 5, edition: 1 }],
      ["c", { seriesId: "ser-now", edition: 0 }],
      ["d", "not a record"],
      ["ser-now 2", rec("ser-now", 2)],
    ],
  })).close();
  db.useIndexedDbForTests(f);
  assert.deepEqual(await db.getAllCheckins(EVENT), [rec("ser-now", 2)]);
  assert.equal(await db.getPendingClaimId(EVENT, "ser-now", 2), "claim-ok");
  assert.equal(await db.getPendingClaimId(EVENT, "ser-now", 1), undefined);
});

test("no legacy database: boot works and none is created", async () => {
  const f = new IDBFactory();
  db.useIndexedDbForTests(f);
  assert.deepEqual(await db.getAllCheckins(EVENT), []);
  assert.deepEqual(await names(f), ["woco-scanner-v2"]);
});

test("a newer version of this database is never blocked by an open scanner", { timeout: 5_000 }, async () => {
  const f = new IDBFactory();
  db.useIndexedDbForTests(f);
  await db.getAllCheckins(EVENT); // this tab holds a connection
  let blocked = false;
  const next = f.open("woco-scanner-v2", 2);
  next.onblocked = () => (blocked = true);
  const upgraded = await within(request(next), 2_000, "a future version opening");
  assert.equal(upgraded.version, 2);
  assert.equal(blocked, false, "the open connection closed itself on versionchange");
  upgraded.close();
});

test("a second tab that copies after the first has finished changes nothing", async () => {
  const f = new IDBFactory();
  (await seedLegacy(f, LEGACY)).close();
  db.useIndexedDbForTests(f);
  await db.getAllCheckins(EVENT); // the first tab's copy
  await db.checkAndMark(EVENT, rec("ser-now", 3));
  // The second tab read the legacy data before the first committed, and copies now.
  await db.copyLegacyInForTests({ kv: { pack: PACK }, checkins: [rec("ser-now", 1)], pending: [] });
  assert.deepEqual((await db.getAllCheckins(EVENT)).map((r) => r.edition).sort(), [1, 3]);
});
