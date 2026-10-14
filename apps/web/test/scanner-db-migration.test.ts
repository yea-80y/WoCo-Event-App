/**
 * The scanner's storage moved to a new database, "woco-scanner-v2", instead of
 * upgrading "woco-scanner" in place (Fable sign-off, 2026-10-14). An in-place
 * upgrade waits for every other connection to close, and the scanner deployed
 * before it holds one open in every tab it runs in - on an iPhone, each QR
 * scanned with the Camera app opens another Safari tab - so the page would sit
 * on "Loading…" forever. The legacy database is read WITHOUT a version (never an
 * upgrade, never blocked) and copied in once.
 *
 * It is never deleted (coordinator decision, 2026-10-15): a delete that an old
 * tab blocks cannot be withdrawn and runs the moment that tab closes, taking
 * whatever it wrote after the copy. Instead its pass and attendee data are
 * scrubbed after the copy, and its check-ins - which an old tab may still be
 * writing - are merged on every boot, each once, never over a record already here.
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

/** Counts every delete the scanner asks for. There must never be one. */
function spyOnDeletes(f: IDBFactory): () => number {
  let deletes = 0;
  const real = f.deleteDatabase.bind(f);
  f.deleteDatabase = (name: string) => {
    deletes += 1;
    return real(name);
  };
  return () => deletes;
}

/** The legacy database as an old tab would read it now. */
async function readLegacyAs(f: IDBFactory): Promise<{ kv: Record<string, unknown>; checkins: IDBValidKey[]; pending: IDBValidKey[] }> {
  const legacy = await request(f.open("woco-scanner"));
  const t = legacy.transaction(["kv", "checkins", "pending"], "readonly");
  const kv: Record<string, unknown> = {};
  for (const key of ["pass", "pack", "roster", "conflicts", "pendingClaims", "deviceId"]) {
    const r = t.objectStore("kv").get(key);
    r.onsuccess = () => {
      if (r.result !== undefined) kv[key] = r.result;
    };
  }
  const checkins = request(t.objectStore("checkins").getAllKeys());
  const pending = request(t.objectStore("pending").getAllKeys());
  await new Promise((resolve) => (t.oncomplete = resolve));
  legacy.close();
  return { kv, checkins: await checkins, pending: await pending };
}

/** What the deployed scanner's checkAndMark writes: the nullifier and the unsynced queue, together. */
async function oldTabAdmits(oldTab: IDBDatabase, r: CheckinRecord): Promise<void> {
  const t = oldTab.transaction(["checkins", "pending"], "readwrite");
  t.objectStore("checkins").put(r, `${r.seriesId} ${r.edition}`);
  t.objectStore("pending").put(r, `${r.seriesId} ${r.edition}`);
  await new Promise((resolve) => (t.oncomplete = resolve));
}

const editions = (records: CheckinRecord[]) => records.map((r) => r.edition);

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

test("a legacy database is copied in under its event, its pass and attendee data scrubbed, and never deleted", async () => {
  const f = new IDBFactory();
  const deletes = spyOnDeletes(f);
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

  const legacy = await readLegacyAs(f);
  assert.deepEqual(legacy.kv, { deviceId: "legacydevice0001" }, "pass, pack, roster, conflicts and claims are scrubbed");
  assert.deepEqual(legacy.checkins, ["ser-now 1", "ser-old 2"], "its check-ins stay, every one");
  assert.deepEqual(legacy.pending, ["ser-now 1", "ser-old 2"], "and its unsynced queue");
  assert.ok((await names(f)).includes("woco-scanner"));
  assert.equal(deletes(), 0, "no delete is ever asked for");
});

test("an open legacy connection in another tab holds up neither the boot nor the scrub", { timeout: 5_000 }, async (t) => {
  const f = new IDBFactory();
  const otherTab = await seedLegacy(f, LEGACY); // stays open; the deployed scanner sets no versionchange handler
  t.after(() => otherTab.close());
  db.useIndexedDbForTests(f);

  assert.deepEqual(await within(db.getAllCheckins(EVENT), 1_000, "boot with a legacy tab open"), [rec("ser-now", 1)]);
  assert.deepEqual((await readLegacyAs(f)).kv, { deviceId: "legacydevice0001" });
  db.useIndexedDbForTests(f); // and every boot after it
  assert.deepEqual(await within(db.getAllCheckins(EVENT), 1_000, "a later boot with a legacy tab open"), [rec("ser-now", 1)]);
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

test("an old tab's check-ins after the copy survive any number of later boots, with no delete ever asked for", { timeout: 10_000 }, async (t) => {
  const f = new IDBFactory();
  const deletes = spyOnDeletes(f);
  const oldTab = await seedLegacy(f, LEGACY); // open throughout, as a tab still on the previous scanner
  t.after(() => oldTab.close());
  db.useIndexedDbForTests(f);
  assert.deepEqual(editions(await db.getAllCheckins(EVENT)), [1]);

  // It admits a ticket offline after the copy - after its pack was scrubbed, too.
  await oldTabAdmits(oldTab, rec("ser-now", 4));
  db.useIndexedDbForTests(f);
  assert.deepEqual(editions(await db.getAllCheckins(EVENT)), [1, 4], "merged on the next boot");
  await oldTabAdmits(oldTab, rec("ser-now", 5));
  for (let boot = 0; boot < 4; boot++) {
    db.useIndexedDbForTests(f);
    assert.deepEqual(editions(await db.getAllCheckins(EVENT)), [1, 4, 5], `boot ${boot + 3}`);
    assert.deepEqual(editions(await db.getPending(EVENT)), [1, 4, 5]);
  }
  oldTab.close(); // it reloads into this version
  db.useIndexedDbForTests(f);
  assert.deepEqual(editions(await db.getAllCheckins(EVENT)), [1, 4, 5]);
  assert.deepEqual((await readLegacyAs(f)).checkins, ["ser-now 1", "ser-now 4", "ser-now 5", "ser-old 2"], "the legacy check-ins are all still there");
  assert.equal(deletes(), 0);
});

test("a legacy record is merged once: after it synced, or its event was reset, it does not come back", async () => {
  const f = new IDBFactory();
  (await seedLegacy(f, LEGACY)).close();
  db.useIndexedDbForTests(f);
  assert.deepEqual(editions(await db.getPending(EVENT)), [1]);

  await db.absorbServerCheckins(EVENT, [], ["ser-now 1"]); // the server acknowledged it
  db.useIndexedDbForTests(f);
  assert.deepEqual(await db.getPending(EVENT), [], "not queued again from the legacy queue, which still holds it");
  assert.deepEqual(editions(await db.getAllCheckins(EVENT)), [1]);

  await db.clearEvent(EVENT); // "Reset"
  db.useIndexedDbForTests(f);
  assert.deepEqual(await db.getAllCheckins(EVENT), []);
  assert.deepEqual(await db.getAllPendingKeys(), [], "a reset event's records stay gone");
});

test("the scrub waits for the copy: a copy that fails leaves the legacy pass for the retry", async () => {
  const real = new IDBFactory();
  (await seedLegacy(real, LEGACY)).close();
  let copyFails = true;
  const failingCopy = (target: IDBDatabase): IDBDatabase =>
    new Proxy(target, {
      get(d, prop) {
        if (prop === "transaction") {
          return (stores: string | string[], mode?: IDBTransactionMode) => {
            if (copyFails && Array.isArray(stores) && stores.length === 8 && mode === "readwrite") {
              throw new DOMException("storage full", "QuotaExceededError");
            }
            return d.transaction(stores, mode);
          };
        }
        const value = Reflect.get(d, prop, d);
        return typeof value === "function" ? value.bind(d) : value;
      },
      set: (d, prop, value) => Reflect.set(d, prop, value, d),
    });
  const f = new Proxy(real, {
    get(target, prop) {
      if (prop === "open") {
        return (...args: Parameters<IDBFactory["open"]>) => {
          const req = target.open(...args);
          if (args[0] !== "woco-scanner-v2") return req;
          return new Proxy(req, {
            get: (r, p) => (p === "result" ? failingCopy(r.result) : Reflect.get(r, p, r)),
            set: (r, p, value) => Reflect.set(r, p, value, r),
          });
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  db.useIndexedDbForTests(f);
  await assert.rejects(db.getAllCheckins(EVENT));
  assert.deepEqual(Object.keys((await readLegacyAs(real)).kv).sort(), ["deviceId", "pack", "pass", "pendingClaims", "roster"], "nothing scrubbed");
  copyFails = false;
  assert.deepEqual(await db.getAllCheckins(EVENT), [rec("ser-now", 1)], "the retry copies");
  assert.deepEqual(await db.getPass(EVENT), PASS);
  assert.deepEqual((await readLegacyAs(real)).kv, { deviceId: "legacydevice0001" }, "and only then scrubs");
});

test("a legacy read that stalls holds up the first copy only", { timeout: 15_000 }, async (t) => {
  const stalled: { onerror?: (e: Event) => void; error: DOMException | null }[] = [];
  const release = () => {
    for (const req of stalled.splice(0)) {
      req.error = new DOMException("stalled", "UnknownError");
      req.onerror?.({ preventDefault() {} } as Event);
    }
  };
  t.after(release);
  const stalling = (real: IDBFactory, on: () => boolean) =>
    new Proxy(real, {
      get(target, prop) {
        if (prop === "open") {
          return (...args: Parameters<IDBFactory["open"]>) => {
            if (args[0] !== "woco-scanner" || !on()) return target.open(...args);
            const req = { error: null, result: undefined, transaction: null };
            stalled.push(req);
            return req;
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

  // After the copy: the boot goes on without this boot's merge.
  const copied = new IDBFactory();
  (await seedLegacy(copied, LEGACY)).close();
  let stall = false;
  db.useIndexedDbForTests(stalling(copied, () => stall));
  await db.getAllCheckins(EVENT);
  stall = true;
  db.useIndexedDbForTests(stalling(copied, () => stall));
  assert.deepEqual(await within(db.getAllCheckins(EVENT), 4_000, "a boot after the copy"), [rec("ser-now", 1)]);
  release();

  // Before it: the boot waits, rather than run without the legacy check-ins.
  const fresh = new IDBFactory();
  (await seedLegacy(fresh, LEGACY)).close();
  db.useIndexedDbForTests(stalling(fresh, () => true));
  const booting = db.getAllCheckins(EVENT);
  let settled = false;
  booting.then(() => (settled = true), () => (settled = true));
  await new Promise((r) => setTimeout(r, 3_500));
  assert.equal(settled, false, "still waiting after two read caps");
  release();
  await assert.rejects(booting, "a read that fails before the copy fails the boot, for its retry");
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
  legacyBroken = true;
  db.useIndexedDbForTests(f);
  assert.deepEqual(await db.getAllCheckins(EVENT), [rec("ser-now", 1)], "after the copy the boot goes on");
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
