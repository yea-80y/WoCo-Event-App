/**
 * IndexedDB persistence for the scanner — everything a door device needs to
 * reopen fully offline: the door pass + roster key, the verification pack,
 * the decrypted roster, and the check-in nullifier set (with a pending queue
 * of records not yet acknowledged by the server).
 *
 * Plaintext roster on disk is intentional: the device already holds the
 * roster key (from the pass URL fragment) in the same store, so encrypting
 * at rest here would add no security — provisioning a device IS trusting it.
 * None of it outlives the pass: once it has ended, the attendee data and the
 * pass itself go (`cleanUpEndedEvent`).
 *
 * One phone can hold several events at once (two doors, two tabs): passes,
 * packs, rosters, conflicts, check-ins, the unsynced queue and in-flight claims
 * are all kept per event, so setting one up never touches another.
 */

import type { CheckinPack, CheckinRecord, CheckinConflict, RosterEntry } from "@woco/shared";
import { eventKeyBounds, placementOf, scopeV1Claims, scopeV1Records, storeKey } from "./scope.js";
import { endedAtMs, endedEventAction, hasExpired, type EndedAction } from "./events.js";
import type { StoredDoorEntries } from "./door-entries.js";

/**
 * A NEW database, not a version bump of the old one. Upgrading "woco-scanner" in
 * place would wait for every other connection to it to close, and the scanner
 * deployed before per-event storage holds it open in any tab it runs in - on an
 * iPhone, every QR scanned with the Camera app opens another Safari tab - so the
 * upgrade, and the page, would wait forever. Nothing else ever holds this name
 * open, and every connection closes itself on a versionchange, so no future
 * version is blocked either.
 */
const DB_NAME = "woco-scanner-v2";
const DB_VERSION = 1;
/** Per-ticket keys with no event (scope.ts). Never deleted - see `migrateLegacy`. */
const LEGACY_DB_NAME = "woco-scanner";
const MIGRATED = "migratedFromLegacy";
/** Storage keys of the legacy check-ins already merged in, so none is merged twice. */
const LEGACY_MERGED = "legacyMerged";
/** The last legacy pack's event and ticket types: places what an old tab writes after its pack is scrubbed. */
const LEGACY_PLACEMENT = "legacyPlacement";
/**
 * Legacy kv entries holding the pass and the attendee data; scrubbed once the
 * copy is in. Not `pendingClaims`: claim ids only, and an old tab re-reads them
 * on every claim - without its id, a re-scan after a lost answer would turn away
 * the person that claim had just let in.
 */
const LEGACY_SECRETS = ["pass", "pack", "roster", "conflicts"] as const;
/**
 * After the first copy, how long a boot waits to read the legacy database. With
 * no delete or upgrade of it ever queued, a version-less open has nothing to
 * wait behind; this only keeps a browser that stalls the read from stalling the
 * boot with it.
 */
const LEGACY_MERGE_WAIT_MS = 1_500;

/**
 * kv: device-wide (device id, copy marker), plus each event's door entries under
 * `doorEntriesKey` - a key, not a store, so adding them needed no version bump that a
 * tab still running the previous scanner would have to close for. Every other store is
 * per event: keyed by eventId, or by `storeKey`.
 */
const STORES = ["kv", "passes", "packs", "rosters", "conflicts", "checkins", "pending", "claims"] as const;
/** Keyed by eventId. */
const EVENT_STORES = ["passes", "packs", "rosters", "conflicts"] as const;
/** Keyed by `storeKey`: one key range per event. */
const TICKET_STORES = ["checkins", "pending", "claims"] as const;

let dbPromise: Promise<IDBDatabase> | null = null;
let factory: () => IDBFactory = () => indexedDB;

/** Tests only: point the module at a fresh fake IndexedDB. */
export function useIndexedDbForTests(f: IDBFactory): void {
  factory = () => f;
  dbPromise = null;
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const opening = openCurrent().then(async (db) => {
    try {
      await migrateLegacy(db);
      return db;
    } catch (err) {
      db.close();
      throw err;
    }
  });
  dbPromise = opening;
  // A failed open is not remembered: the boot screen's retry opens again.
  opening.catch(() => {
    if (dbPromise === opening) dbPromise = null;
  });
  return opening;
}

function openCurrent(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory().open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) db.createObjectStore(name);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}

export interface LegacyData {
  kv: Record<string, unknown>;
  checkins: unknown[];
  pending: unknown[];
}

const LEGACY_KV = ["pass", "pack", "roster", "conflicts", "pendingClaims", "deviceId"] as const;

/**
 * Copy the legacy database in, merge its check-ins, then scrub its secrets.
 *
 * The pass, pack, roster, conflicts and claims are copied once: one transaction
 * checks the marker, clears the stores, copies and sets the marker, so an
 * interrupted copy leaves nothing, a re-run starts clean, and a second tab that
 * finished first is left alone. Check-ins and the unsynced queue are merged on
 * EVERY boot: an old tab still running the previous scanner keeps writing them
 * after the copy.
 *
 * It is never deleted. A delete that an old tab's connection blocks cannot be
 * withdrawn, and runs the moment that tab closes or reloads - before its reload
 * boots here to merge what it wrote - so it would take those check-ins with it.
 * The secrets go instead, in a plain readwrite transaction no tab can block.
 */
async function migrateLegacy(db: IDBDatabase): Promise<void> {
  const reading = readLegacy();
  let legacy: LegacyData | null;
  try {
    for (;;) {
      const read = await within(reading, LEGACY_MERGE_WAIT_MS);
      if (read !== WAITED_OUT) {
        legacy = read;
        break;
      }
      // After the copy, the next boot merges instead. Before it, the boot must
      // not go on without the legacy check-ins.
      if (await readKey(db, MIGRATED)) return;
    }
  } catch (err) {
    if (!(await readKey(db, MIGRATED))) throw err;
    // The copy is in; a legacy database that will not open is left for the next boot to merge.
    console.warn("[scanner] the old scanner's storage could not be read", err);
    return;
  }
  await copyIn(db, legacy);
  if (!legacy || !LEGACY_SECRETS.some((key) => legacy.kv[key] !== undefined)) return;
  try {
    await scrubLegacy();
  } catch (err) {
    console.warn("[scanner] the old scanner's stored pass could not be removed", err);
  }
}

const WAITED_OUT = Symbol("waited out");

function within<T>(p: Promise<T>, ms: number): Promise<T | typeof WAITED_OUT> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(WAITED_OUT), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function readKey(db: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = db.transaction("kv", "readonly").objectStore("kv").get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Opened WITHOUT a version: that never upgrades an existing database, and
 * nothing deletes this one, so no other tab's connection can hold it up. If it
 * does not exist, the creation is aborted - null.
 */
function openLegacy(): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    const req = factory().open(LEGACY_DB_NAME);
    req.onupgradeneeded = () => req.transaction?.abort();
    req.onerror = (e) => {
      if (req.error?.name !== "AbortError") return reject(req.error);
      e.preventDefault();
      resolve(null);
    };
    req.onsuccess = () => {
      const legacy = req.result;
      legacy.onversionchange = () => legacy.close();
      resolve(legacy);
    };
  });
}

async function readLegacy(): Promise<LegacyData | null> {
  const legacy = await openLegacy();
  if (!legacy) return null;
  try {
    const names = ["kv", "checkins", "pending"].filter((n) => legacy.objectStoreNames.contains(n));
    if (names.length === 0) return null;
    return await new Promise<LegacyData>((resolve, reject) => {
      const data: LegacyData = { kv: {}, checkins: [], pending: [] };
      const t = legacy.transaction(names, "readonly");
      if (names.includes("kv")) {
        for (const key of LEGACY_KV) {
          const r = t.objectStore("kv").get(key);
          r.onsuccess = () => (data.kv[key] = r.result);
        }
      }
      for (const name of ["checkins", "pending"] as const) {
        if (!names.includes(name)) continue;
        const r = t.objectStore(name).getAll();
        r.onsuccess = () => (data[name] = r.result);
      }
      t.oncomplete = () => resolve(data);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error ?? new Error("reading the old scanner's storage was aborted"));
    });
  } finally {
    legacy.close();
  }
}

/**
 * Remove the pass and attendee data from the legacy database - only
 * after the copy has committed, or a copy that failed would have nothing left to
 * retry from. Its check-ins and unsynced queue stay: an old tab may still be
 * writing them, and every boot merges what is new.
 */
async function scrubLegacy(): Promise<void> {
  const legacy = await openLegacy();
  if (!legacy) return;
  try {
    if (!legacy.objectStoreNames.contains("kv")) return;
    await new Promise<void>((resolve, reject) => {
      const t = legacy.transaction("kv", "readwrite");
      for (const key of LEGACY_SECRETS) t.objectStore("kv").delete(key);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error ?? new Error("scrubbing the old scanner's storage was aborted"));
    });
  } finally {
    legacy.close();
  }
}

/** Tests only: the copy step on its own, as a second tab racing the first would run it. */
export async function copyLegacyInForTests(legacy: LegacyData | null): Promise<void> {
  await copyIn(await openDb(), legacy);
}

/**
 * `scopeV1Records` decides what moves, and skips any record it cannot read. The
 * marker gates the one-time copy only; the check-in merge runs every time.
 */
function copyIn(db: IDBDatabase, legacy: LegacyData | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = db.transaction([...STORES], "readwrite");
    const kv = t.objectStore("kv");
    const marker = kv.get(MIGRATED);
    const merged = kv.get(LEGACY_MERGED);
    const placement = kv.get(LEGACY_PLACEMENT);
    // Requests in one transaction complete in order: all three are in.
    placement.onsuccess = () => {
      const copied = Boolean(marker.result);
      if (!copied) {
        for (const name of STORES) t.objectStore(name).clear();
        if (legacy) {
          const { pass, pack, roster, conflicts, deviceId, pendingClaims } = legacy.kv;
          const eventOf = (v: unknown) => {
            const id = (v as { eventId?: unknown } | null)?.eventId;
            return typeof id === "string" && id ? id : null;
          };
          const eventId = eventOf(pack) ?? eventOf(pass);
          if (eventOf(pass)) putSkippingBad(t.objectStore("passes"), pass, eventOf(pass)!);
          if (eventOf(pack)) putSkippingBad(t.objectStore("packs"), pack, eventOf(pack)!);
          if (eventId && roster !== undefined) putSkippingBad(t.objectStore("rosters"), roster, eventId);
          if (eventId && conflicts !== undefined) putSkippingBad(t.objectStore("conflicts"), conflicts, eventId);
          if (typeof deviceId === "string") putSkippingBad(kv, deviceId, "deviceId");
          for (const [key, claimId] of Object.entries(scopeV1Claims(pack, pendingClaims))) {
            putSkippingBad(t.objectStore("claims"), claimId, key);
          }
        }
        kv.put(new Date().toISOString(), MIGRATED);
      }
      if (legacy) mergeCheckins(t, legacy, copied ? merged.result : undefined, copied ? placement.result : undefined);
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error("scanner storage copy was aborted"));
  });
}

/**
 * A union, added only where this database has no record for the ticket: the set
 * only grows, so a record already here - this scanner's own, or the server's -
 * is never replaced by the legacy copy of it.
 *
 * Each legacy record is merged once. The legacy queue is never emptied (an old
 * tab owns it), so re-adding a record after it synced, or after a reset removed
 * its event, would put it back in the unsynced queue on every boot.
 */
function mergeCheckins(t: IDBTransaction, legacy: LegacyData, mergedBefore: unknown, placedBefore: unknown): void {
  const placement = placementOf(legacy.kv.pack) ?? placementOf(placedBefore);
  if (!placement) return;
  const merged = new Set(Array.isArray(mergedBefore) ? mergedBefore.filter((k): k is string => typeof k === "string") : []);
  const added: string[] = [];
  for (const name of ["checkins", "pending"] as const) {
    const store = t.objectStore(name);
    for (const { key, record } of scopeV1Records(placement, legacy[name])) {
      if (merged.has(key)) continue;
      putSkippingBad(store, record, key, "add");
      added.push(key);
    }
  }
  const kv = t.objectStore("kv");
  kv.put(placement, LEGACY_PLACEMENT);
  if (added.length > 0) kv.put([...merged, ...new Set(added)], LEGACY_MERGED);
}

/** A value IndexedDB refuses is left behind; it never aborts the copy. An `add` refuses a key already stored. */
function putSkippingBad(store: IDBObjectStore, value: unknown, key: string, how: "put" | "add" = "put"): void {
  try {
    const req = how === "add" ? store.add(value, key) : store.put(value, key);
    req.onerror = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
  } catch (err) {
    console.warn("[scanner] a stored value could not be carried over", err);
  }
}

function inEvent(eventId: string): IDBKeyRange {
  const [lower, upper] = eventKeyBounds(eventId);
  return IDBKeyRange.bound(lower, upper, false, true);
}

function tx<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = run(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

// ── per-event state ─────────────────────────────────────────────────────────

export interface StoredPass {
  /**
   * "" once a refused pass has been cleaned up (`dropEndedEventDataIn`). An expired
   * one keeps it - it is not personal data - while it still has check-ins to upload.
   */
  token: string;
  /** The pass secret P; "" once the pass has ended and been cleaned up. */
  keyB64url: string;
  eventId: string;
  exp: number;
  /** When a tab last opened this event: a fresh open goes to the most recent live one. */
  lastUsedAt?: number;
  /** Set when the server refused the pass (revoked, bound to another phone): it opens nothing again. */
  dead?: string;
  /** See `PassSummary.expiredAt`. */
  expiredAt?: number;
}

/** Never in an event id (scope.ts), so one event's key cannot be read as another's. */
const doorEntriesKey = (eventId: string) => `doorEntries\u0000${eventId}`;

const kvGet = <T>(key: string) => tx<T | undefined>("kv", "readonly", (s) => s.get(key) as IDBRequest<T | undefined>);
const kvSet = (key: string, value: unknown) => tx("kv", "readwrite", (s) => s.put(value, key));
const get = <T>(store: string, key: string) => tx<T | undefined>(store, "readonly", (s) => s.get(key) as IDBRequest<T | undefined>);
const put = (store: string, value: unknown, key: string) => tx(store, "readwrite", (s) => s.put(value, key));

export const getPass = (eventId: string) => get<StoredPass>("passes", eventId);

/** Store an event's pass. A NEW pass also drops the door entries opened under the old one. */
export async function putPass(p: StoredPass): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(["passes", "kv"], "readwrite");
    const passes = t.objectStore("passes");
    const old = passes.get(p.eventId) as IDBRequest<StoredPass | undefined>;
    old.onsuccess = () => {
      if (old.result?.token !== p.token) t.objectStore("kv").delete(doorEntriesKey(p.eventId));
      passes.put(p, p.eventId);
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
export const getAllPasses = () => tx<StoredPass[]>("passes", "readonly", (s) => s.getAll() as IDBRequest<StoredPass[]>);
export const getPack = (eventId: string) => get<CheckinPack>("packs", eventId);
export const putPack = (p: CheckinPack) => put("packs", p, p.eventId);
export const getRoster = (eventId: string) => get<RosterEntry[]>("rosters", eventId);
export const putRoster = (eventId: string, r: RosterEntry[]) => put("rosters", r, eventId);
export const getConflicts = (eventId: string) => get<CheckinConflict[]>("conflicts", eventId);
export const putConflicts = (eventId: string, c: CheckinConflict[]) => put("conflicts", c, eventId);
export const getDoorEntries = (eventId: string) => kvGet<StoredDoorEntries>(doorEntriesKey(eventId));

/**
 * Write attendee data for an event only while `token` is still its stored pass, with
 * its secret, checked in the same transaction. A fetch that outlived its pass -
 * replaced by a newer one, or ended and cleaned up while the request was out (the
 * secret goes then, even where the token stays to upload) - writes nothing, so names
 * never come back after the clean-up. False when nothing was written.
 */
async function putUnderPass(eventId: string, token: string, writes: Array<[store: string, value: unknown, key: string]>): Promise<boolean> {
  if (!token) return false;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(["passes", ...new Set(writes.map(([store]) => store))], "readwrite");
    let wrote = false;
    const pass = t.objectStore("passes").get(eventId) as IDBRequest<StoredPass | undefined>;
    pass.onsuccess = () => {
      if (pass.result?.token !== token || !pass.result.keyB64url) return;
      for (const [store, value, key] of writes) t.objectStore(store).put(value, key);
      wrote = true;
    };
    t.oncomplete = () => resolve(wrote);
    t.onerror = () => reject(t.error);
  });
}

export const putPackUnderPass = (token: string, p: CheckinPack) => putUnderPass(p.eventId, token, [["packs", p, p.eventId]]);
export const putRosterUnderPass = (eventId: string, token: string, r: RosterEntry[]) => putUnderPass(eventId, token, [["rosters", r, eventId]]);
export const putDoorEntries = (eventId: string, token: string, s: StoredDoorEntries) =>
  putUnderPass(eventId, token, [["kv", s, doorEntriesKey(eventId)]]);

/**
 * Read-modify-write in one transaction, so one tab's change cannot undo another's.
 * With `token`, only that pass changes: an answer about a pass another tab has since
 * replaced says nothing about the new one.
 */
async function updatePass(eventId: string, change: Partial<StoredPass>, token?: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction("passes", "readwrite");
    const store = t.objectStore("passes");
    const req = store.get(eventId) as IDBRequest<StoredPass | undefined>;
    req.onsuccess = () => {
      if (req.result && (token === undefined || req.result.token === token)) store.put({ ...req.result, ...change }, eventId);
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export const markPassDead = (eventId: string, message: string, token?: string) => updatePass(eventId, { dead: message }, token);
/** The server said this pass is past its `exp`, whatever this phone's clock says. */
export const markPassExpired = (eventId: string, token: string, at: number) => updatePass(eventId, { expiredAt: at }, token);
export const touchPass = (eventId: string, at: number) => updatePass(eventId, { lastUsedAt: at });

/**
 * Remove one event from this phone - "Reset" in that event's tab. Every other
 * event, and every other tab, is untouched.
 */
export async function clearEvent(eventId: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction([...EVENT_STORES, ...TICKET_STORES, "kv"], "readwrite");
    clearEventIn(t, eventId);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

function clearEventIn(t: IDBTransaction, eventId: string): void {
  for (const name of EVENT_STORES) t.objectStore(name).delete(eventId);
  for (const name of TICKET_STORES) t.objectStore(name).delete(inEvent(eventId));
  t.objectStore("kv").delete(doorEntriesKey(eventId));
}

/**
 * An ended event's attendee data goes - the roster, the pack (it carries the roster
 * ciphertext), the door entries - and so does the pass secret, which nothing can use
 * any more. An expired pass keeps its token, which is not personal data, so its
 * unsynced check-ins can still be uploaded (owner, 2026-10-15); a refused one loses
 * that too. What is left of the pass says when it ended, and it never opens again.
 * Its check-ins stay.
 */
function dropEndedEventDataIn(t: IDBTransaction, pass: StoredPass | undefined, now: number): void {
  if (!pass) return;
  t.objectStore("packs").delete(pass.eventId);
  t.objectStore("rosters").delete(pass.eventId);
  t.objectStore("kv").delete(doorEntriesKey(pass.eventId));
  const token = pass.dead ? "" : pass.token;
  if (pass.keyB64url || token !== pass.token || (!pass.dead && pass.expiredAt === undefined)) {
    // An expired pass keeps the moment it ended, so a clock set back later cannot reopen it.
    const expiredAt = pass.dead ? pass.expiredAt : hasExpired(pass, now) ? endedAtMs(pass) : now;
    t.objectStore("passes").put({ ...pass, token, keyB64url: "", ...(expiredAt === undefined ? {} : { expiredAt }) }, pass.eventId);
  }
}

const ENDED_STORES = [...EVENT_STORES, ...TICKET_STORES, "kv"] as const;

/** `dropEndedEventDataIn` on its own, for an event already known to be over. */
export async function dropAttendeeData(eventId: string, now = Date.now()): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(["passes", "packs", "rosters", "kv"], "readwrite");
    const pass = t.objectStore("passes").get(eventId) as IDBRequest<StoredPass | undefined>;
    pass.onsuccess = () => dropEndedEventDataIn(t, pass.result, now);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

/**
 * One event's clean-up after its pass ended (`endedEventAction`), decided and done in
 * ONE transaction against what is stored now: a tab may have just set up a new pass
 * for the event, and a live pass is never touched.
 */
export async function cleanUpEndedEvent(eventId: string, now: number): Promise<EndedAction> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction([...ENDED_STORES], "readwrite");
    let action: EndedAction = "keep";
    const pass = t.objectStore("passes").get(eventId) as IDBRequest<StoredPass | undefined>;
    const unsynced = t.objectStore("pending").count(inEvent(eventId));
    // Requests in one transaction complete in order: both are in.
    unsynced.onsuccess = () => {
      action = endedEventAction(pass.result, unsynced.result > 0, now);
      if (action === "clear") clearEventIn(t, eventId);
      else if (action === "drop-attendee-data") dropEndedEventDataIn(t, pass.result, now);
    };
    t.oncomplete = () => resolve(action);
    t.onerror = () => reject(t.error);
  });
}

/** Stable random device id — lets the server attribute offline duplicates. */
export async function getDeviceId(): Promise<string> {
  const existing = await kvGet<string>("deviceId");
  if (existing) return existing;
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  await kvSet("deviceId", id);
  return id;
}

// ── nullifier set ───────────────────────────────────────────────────────────

/** In-memory key for one ticket of the CURRENT event; stored keys add the event (`storeKey`). */
export function ticketKey(seriesId: string, edition: number): string {
  return `${seriesId} ${edition}`;
}

export const getAllCheckins = (eventId: string) =>
  tx<CheckinRecord[]>("checkins", "readonly", (s) => s.getAll(inEvent(eventId)) as IDBRequest<CheckinRecord[]>);

export const getPending = (eventId: string) =>
  tx<CheckinRecord[]>("pending", "readonly", (s) => s.getAll(inEvent(eventId)) as IDBRequest<CheckinRecord[]>);

/** Every unsynced record's stored key, across all events. */
export const getAllPendingKeys = () =>
  tx<IDBValidKey[]>("pending", "readonly", (s) => s.getAllKeys()).then((keys) => keys.map(String));

/**
 * Atomic check-and-mark: returns the existing record if the ticket was
 * already checked in (duplicate), otherwise records it (nullifier + pending
 * sync queue) in one transaction and returns null.
 */
export async function checkAndMark(eventId: string, record: CheckinRecord): Promise<CheckinRecord | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(["checkins", "pending"], "readwrite");
    const key = storeKey(eventId, record.seriesId, record.edition);
    const store = t.objectStore("checkins");
    const getReq = store.get(key) as IDBRequest<CheckinRecord | undefined>;
    getReq.onsuccess = () => {
      const existing = getReq.result;
      if (existing) {
        resolve(existing);
        return;
      }
      store.put(record, key);
      t.objectStore("pending").put(record, key);
      t.oncomplete = () => resolve(null);
    };
    t.onerror = () => reject(t.error);
  });
}

// ── in-flight claims (#641) ─────────────────────────────────────────────────
// A claim whose answer never arrived may still have been recorded. Re-scanning
// that ticket must retry the SAME attempt (same claimId) so the server says
// "admitted" to it rather than "already in" - otherwise a lost response would
// turn away the person it had just let in.

export const getPendingClaimId = (eventId: string, seriesId: string, edition: number) =>
  get<string>("claims", storeKey(eventId, seriesId, edition));

export const setPendingClaimId = (eventId: string, seriesId: string, edition: number, claimId: string) =>
  put("claims", claimId, storeKey(eventId, seriesId, edition)).then(() => undefined);

export const clearPendingClaimId = (eventId: string, seriesId: string, edition: number) =>
  tx("claims", "readwrite", (s) => s.delete(storeKey(eventId, seriesId, edition))).then(() => undefined);

/**
 * Fold an event's server set in (server records win only where we have none),
 * and drop the unsynced records the server acknowledged (`ticketKey`s).
 */
export async function absorbServerCheckins(eventId: string, records: CheckinRecord[], ackedPendingKeys: string[]): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(["checkins", "pending"], "readwrite");
    const checkins = t.objectStore("checkins");
    for (const r of records) {
      const key = storeKey(eventId, r.seriesId, r.edition);
      const getReq = checkins.get(key) as IDBRequest<CheckinRecord | undefined>;
      getReq.onsuccess = () => {
        if (!getReq.result || r.at < getReq.result.at) checkins.put(r, key);
      };
    }
    const pending = t.objectStore("pending");
    for (const key of ackedPendingKeys) {
      const at = key.lastIndexOf(" ");
      pending.delete(storeKey(eventId, key.slice(0, at), Number(key.slice(at + 1))));
    }
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

