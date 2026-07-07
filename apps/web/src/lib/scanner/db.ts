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

const DB_NAME = "woco-scanner";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("kv");
      db.createObjectStore("checkins");
      db.createObjectStore("pending");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
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

export function ticketKey(seriesId: string, edition: number): string {
  return `${seriesId} ${edition}`;
}

export const getCheckin = (seriesId: string, edition: number) =>
  tx<CheckinRecord | undefined>("checkins", "readonly", (s) => s.get(ticketKey(seriesId, edition)) as IDBRequest<CheckinRecord | undefined>);

export const getAllCheckins = () =>
  tx<CheckinRecord[]>("checkins", "readonly", (s) => s.getAll() as IDBRequest<CheckinRecord[]>);

export const getPending = () =>
  tx<CheckinRecord[]>("pending", "readonly", (s) => s.getAll() as IDBRequest<CheckinRecord[]>);

/**
 * Atomic check-and-mark: returns the existing record if the ticket was
 * already checked in (duplicate), otherwise records it (nullifier + pending
 * sync queue) in one transaction and returns null.
 */
export async function checkAndMark(record: CheckinRecord): Promise<CheckinRecord | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(["checkins", "pending"], "readwrite");
    const key = ticketKey(record.seriesId, record.edition);
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

/** Fold the server's merged set in (server records win only where we have none). */
export async function absorbServerCheckins(records: CheckinRecord[], ackedPendingKeys: string[]): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(["checkins", "pending"], "readwrite");
    const checkins = t.objectStore("checkins");
    for (const r of records) {
      const key = ticketKey(r.seriesId, r.edition);
      const getReq = checkins.get(key) as IDBRequest<CheckinRecord | undefined>;
      getReq.onsuccess = () => {
        if (!getReq.result || r.at < getReq.result.at) checkins.put(r, key);
      };
    }
    const pending = t.objectStore("pending");
    for (const key of ackedPendingKeys) pending.delete(key);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

/** Wipe the device (switch event / hand device back). */
export async function resetDevice(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(["kv", "checkins", "pending"], "readwrite");
    t.objectStore("checkins").clear();
    t.objectStore("pending").clear();
    const kv = t.objectStore("kv");
    for (const key of ["pass", "pack", "roster", "conflicts"]) kv.delete(key);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
