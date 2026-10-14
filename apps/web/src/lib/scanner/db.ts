/**
 * IndexedDB persistence for the scanner — everything a door device needs to
 * reopen fully offline: the door pass + roster key, the verification pack,
 * the decrypted roster, and the check-in nullifier set (with a pending queue
 * of records not yet acknowledged by the server).
 *
 * Plaintext roster on disk is intentional: the device already holds the
 * roster key (from the pass URL fragment) in the same store, so encrypting
 * at rest here would add no security — provisioning a device IS trusting it.
 *
 * One phone can hold several events at once (two doors, two tabs): passes,
 * packs, rosters, conflicts, check-ins, the unsynced queue and in-flight claims
 * are all kept per event, so setting one up never touches another.
 */

import type { CheckinPack, CheckinRecord, CheckinConflict, RosterEntry } from "@woco/shared";
import { eventKeyBounds, scopeV1Claims, scopeV1Records, storeKey } from "./scope.js";

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
/** Per-ticket keys with no event (scope.ts). Read once, copied in, then deleted. */
const LEGACY_DB_NAME = "woco-scanner";
const MIGRATED = "migratedFromLegacy";

/** kv: device-wide (device id, copy marker). Every other store is per event: keyed by eventId, or by `storeKey`. */
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
 * Copy the legacy database in once. The copy is one transaction that checks the
 * marker, clears the stores, copies and sets the marker: an interrupted copy
 * leaves nothing, a re-run starts clean, and a second tab that finished first is
 * left alone.
 */
async function migrateLegacy(db: IDBDatabase): Promise<void> {
  if (!(await readKey(db, MIGRATED))) await copyIn(db, await readLegacy());
  dropLegacy();
}

function readKey(db: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = db.transaction("kv", "readonly").objectStore("kv").get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Opened WITHOUT a version: that never upgrades an existing database, so it can
 * never wait on another tab. If it does not exist, the creation is aborted - null.
 */
function readLegacy(): Promise<LegacyData | null> {
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
      const names = ["kv", "checkins", "pending"].filter((n) => legacy.objectStoreNames.contains(n));
      if (names.length === 0) {
        legacy.close();
        return resolve(null);
      }
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
      t.oncomplete = () => {
        legacy.close();
        resolve(data);
      };
      t.onerror = () => {
        legacy.close();
        reject(t.error);
      };
    };
  });
}

/** Tests only: the copy step on its own, as a second tab racing the first would run it. */
export async function copyLegacyInForTests(legacy: LegacyData | null): Promise<void> {
  await copyIn(await openDb(), legacy);
}

/** `scopeV1Records` decides what moves, and skips any record it cannot read. */
function copyIn(db: IDBDatabase, legacy: LegacyData | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = db.transaction([...STORES], "readwrite");
    const kv = t.objectStore("kv");
    const marker = kv.get(MIGRATED);
    marker.onsuccess = () => {
      if (marker.result) return;
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
        for (const name of ["checkins", "pending"] as const) {
          const store = t.objectStore(name);
          for (const { key, record } of scopeV1Records(pack, legacy[name])) putSkippingBad(store, record, key);
        }
      }
      kv.put(new Date().toISOString(), MIGRATED);
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error("scanner storage copy was aborted"));
  });
}

/** A value IndexedDB refuses is left behind; it never aborts the copy. */
function putSkippingBad(store: IDBObjectStore, value: unknown, key: string): void {
  try {
    const req = store.put(value, key);
    req.onerror = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
  } catch (err) {
    console.warn("[scanner] a stored value could not be carried over", err);
  }
}

/**
 * Remove the legacy database, plaintext roster and all. Never awaited: while an
 * old tab holds it the delete just waits, and nothing here waits on it.
 */
function dropLegacy(): void {
  try {
    factory().deleteDatabase(LEGACY_DB_NAME);
  } catch {
    // Next boot tries again.
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
  token: string;
  keyB64url: string;
  eventId: string;
  exp: number;
  /** When a tab last opened this event: a fresh open goes to the most recent live one. */
  lastUsedAt?: number;
  /** Set when the server refused the pass (revoked, bound to another phone): it opens nothing again. */
  dead?: string;
}

const kvGet = <T>(key: string) => tx<T | undefined>("kv", "readonly", (s) => s.get(key) as IDBRequest<T | undefined>);
const kvSet = (key: string, value: unknown) => tx("kv", "readwrite", (s) => s.put(value, key));
const get = <T>(store: string, key: string) => tx<T | undefined>(store, "readonly", (s) => s.get(key) as IDBRequest<T | undefined>);
const put = (store: string, value: unknown, key: string) => tx(store, "readwrite", (s) => s.put(value, key));

export const getPass = (eventId: string) => get<StoredPass>("passes", eventId);
export const putPass = (p: StoredPass) => put("passes", p, p.eventId);
export const getAllPasses = () => tx<StoredPass[]>("passes", "readonly", (s) => s.getAll() as IDBRequest<StoredPass[]>);
export const getPack = (eventId: string) => get<CheckinPack>("packs", eventId);
export const putPack = (p: CheckinPack) => put("packs", p, p.eventId);
export const getRoster = (eventId: string) => get<RosterEntry[]>("rosters", eventId);
export const putRoster = (eventId: string, r: RosterEntry[]) => put("rosters", r, eventId);
export const getConflicts = (eventId: string) => get<CheckinConflict[]>("conflicts", eventId);
export const putConflicts = (eventId: string, c: CheckinConflict[]) => put("conflicts", c, eventId);

/** Read-modify-write in one transaction, so one tab's change cannot undo another's. */
async function updatePass(eventId: string, change: Partial<StoredPass>): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction("passes", "readwrite");
    const store = t.objectStore("passes");
    const req = store.get(eventId) as IDBRequest<StoredPass | undefined>;
    req.onsuccess = () => {
      if (req.result) store.put({ ...req.result, ...change }, eventId);
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export const markPassDead = (eventId: string, message: string) => updatePass(eventId, { dead: message });
export const touchPass = (eventId: string, at: number) => updatePass(eventId, { lastUsedAt: at });

/**
 * Remove one event from this phone - "Reset" in that event's tab. Every other
 * event, and every other tab, is untouched.
 */
export async function clearEvent(eventId: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction([...EVENT_STORES, ...TICKET_STORES], "readwrite");
    for (const name of EVENT_STORES) t.objectStore(name).delete(eventId);
    for (const name of TICKET_STORES) t.objectStore(name).delete(inEvent(eventId));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

/** An ended event's attendee data (roster) and pack go; its check-ins stay while any are unsynced. */
export async function dropAttendeeData(eventId: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(["packs", "rosters"], "readwrite");
    t.objectStore("packs").delete(eventId);
    t.objectStore("rosters").delete(eventId);
    t.oncomplete = () => resolve();
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

