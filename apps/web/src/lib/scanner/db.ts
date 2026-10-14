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

const DB_NAME = "woco-scanner";
/** v2: check-ins, the unsynced queue and in-flight claims are keyed per event (scope.ts). */
const DB_VERSION = 2;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (e.oldVersion < 1) {
        db.createObjectStore("kv");
        db.createObjectStore("checkins");
        db.createObjectStore("pending");
      } else if (e.oldVersion < 2) {
        migrateV1(req.transaction!);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** Re-key v1 records under the stored pack's event; see `scopeV1Records` for what is dropped and why. */
function migrateV1(t: IDBTransaction): void {
  const kv = t.objectStore("kv");
  const packReq = kv.get("pack") as IDBRequest<CheckinPack | undefined>;
  packReq.onsuccess = () => {
    const pack = packReq.result;
    for (const name of ["checkins", "pending"]) {
      const store = t.objectStore(name);
      const all = store.getAll() as IDBRequest<CheckinRecord[]>;
      all.onsuccess = () => {
        store.clear();
        for (const { key, record } of scopeV1Records(pack, all.result)) store.put(record, key);
      };
    }
    const claimsReq = kv.get("pendingClaims") as IDBRequest<Record<string, string> | undefined>;
    claimsReq.onsuccess = () => kv.put(scopeV1Claims(pack, claimsReq.result ?? {}), "pendingClaims");
  };
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
