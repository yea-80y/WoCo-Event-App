/**
 * IndexedDB persistence for the scanner — everything a door device needs to
 * reopen fully offline: the door pass + roster key, the verification pack,
 * the decrypted roster, and the check-in nullifier set (with a pending queue
 * of records not yet acknowledged by the server).
 *
 * Plaintext roster on disk is intentional: the device already holds the
 * roster key (from the pass URL fragment) in the same store, so encrypting
 * at rest here would add no security — provisioning a device IS trusting it.
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
      db.createObjectStore("kv");
      db.createObjectStore("checkins");
      db.createObjectStore("pending");
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
    const t = db.transaction(["kv", "checkins", "pending"], "readwrite");
    const kv = t.objectStore("kv");
    const marker = kv.get(MIGRATED);
    marker.onsuccess = () => {
      if (marker.result) return;
      for (const name of ["kv", "checkins", "pending"]) t.objectStore(name).clear();
      if (legacy) {
        const pack = legacy.kv.pack as CheckinPack | undefined;
        for (const key of LEGACY_KV) {
          const value = key === "pendingClaims" ? scopeV1Claims(pack, legacy.kv.pendingClaims) : legacy.kv[key];
          if (value !== undefined) putSkippingBad(kv, value, key);
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

// ── kv slots ────────────────────────────────────────────────────────────────

export interface StoredPass {
  token: string;
  keyB64url: string;
  eventId: string;
  exp: number;
}

const kvGet = <T>(key: string) => tx<T | undefined>("kv", "readonly", (s) => s.get(key) as IDBRequest<T | undefined>);
const kvSet = (key: string, value: unknown) => tx("kv", "readwrite", (s) => s.put(value, key));

export const getStoredPass = () => kvGet<StoredPass>("pass");
export const setStoredPass = (p: StoredPass) => kvSet("pass", p);

/**
 * Passes of earlier events that still have unsynced check-ins on this phone, by
 * event: their records sync with their own pass only, never the current one's.
 */
export const getEarlierPasses = async () => (await kvGet<Record<string, StoredPass>>("earlierPasses")) ?? {};
export const setEarlierPasses = (p: Record<string, StoredPass>) => kvSet("earlierPasses", p);
export const getStoredPack = () => kvGet<CheckinPack>("pack");
export const setStoredPack = (p: CheckinPack) => kvSet("pack", p);
export const getStoredRoster = () => kvGet<RosterEntry[]>("roster");
export const setStoredRoster = (r: RosterEntry[]) => kvSet("roster", r);
export const getStoredConflicts = () => kvGet<CheckinConflict[]>("conflicts");
export const setStoredConflicts = (c: CheckinConflict[]) => kvSet("conflicts", c);

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

type PendingClaims = Record<string, string>;

export async function getPendingClaimId(eventId: string, seriesId: string, edition: number): Promise<string | undefined> {
  return ((await kvGet<PendingClaims>("pendingClaims")) ?? {})[storeKey(eventId, seriesId, edition)];
}

export async function setPendingClaimId(eventId: string, seriesId: string, edition: number, claimId: string): Promise<void> {
  const all = (await kvGet<PendingClaims>("pendingClaims")) ?? {};
  all[storeKey(eventId, seriesId, edition)] = claimId;
  await kvSet("pendingClaims", all);
}

export async function clearPendingClaimId(eventId: string, seriesId: string, edition: number): Promise<void> {
  const all = (await kvGet<PendingClaims>("pendingClaims")) ?? {};
  delete all[storeKey(eventId, seriesId, edition)];
  await kvSet("pendingClaims", all);
}

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

/** Wipe the device (hand it back): every event's records, unsynced ones included. */
export async function resetDevice(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(["kv", "checkins", "pending"], "readwrite");
    t.objectStore("checkins").clear();
    t.objectStore("pending").clear();
    const kv = t.objectStore("kv");
    for (const key of ["pass", "pack", "roster", "conflicts", "pendingClaims", "earlierPasses"]) kv.delete(key);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
