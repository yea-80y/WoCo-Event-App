/**
 * Sealed orders held until they are paid for (#546).
 *
 * An order box goes onto Swarm only once its sale is paid. Until then the
 * server holds the ciphertext here: it is sealed in the buyer's browser to the
 * organiser's X-Wing key, so holding it gives the server nothing it can read,
 * and its reference is the Swarm root of its exact bytes, known before any
 * upload. Storing only paid orders means:
 *   - an unpaid or abandoned checkout (and the web client's re-send after every
 *     pause in typing) never takes a permanent slot in the attendee batch;
 *   - filling the batch on purpose costs a card payment per order;
 *   - data about people who never bought is deleted here after 24 h, for real,
 *     instead of sitting on Swarm until erased or expired.
 *
 * Lifecycle: `holdPrepared` (prepare-order: MEMORY only - the web client sends
 * one after every pause in typing, so these are many and disposable) ->
 * `commitHold` (create-checkout, the buyer is on the way to Stripe: persisted,
 * one write per checkout attempt) -> `markHeldPaid` (fulfilment, before the
 * mint) -> stored on the attendee batch (fulfilment, then the retry worker) ->
 * `releaseHeldOrder`. Unpaid holds go after HOLD_TTL_MS; paid ones are kept
 * until stored, however long that takes. A prepared hold lost to a restart
 * costs nothing: checkout re-holds the box the client sends inline.
 *
 * The persisted file MUST survive restarts: a paid order that is not yet
 * stored exists nowhere else. A present-but-unreadable file is never
 * overwritten; new commits are refused (the sale then gets the minimal server
 * seal) until it is restored.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../marketing/persist.js";

const DATA_DIR = join(process.cwd(), ".data");
const STORE_FILE = join(DATA_DIR, "held-orders.json");

/** Matches the order-ref token's lifetime: after that the ref cannot be used anyway. */
export const HOLD_TTL_MS = 24 * 60 * 60 * 1000;
/** Unpaid holds kept at most, in memory and on disk each; the oldest unpaid one
 *  makes room, so a full store never refuses a sale. Paid ones never count. */
export let MAX_UNPAID_HOLDS = 5_000;

export interface HeldOrder {
  /** Canonical box JSON, exactly the bytes whose root is the key. */
  json: string;
  heldAt: string;
  eventId?: string;
  seriesId?: string;
  /** Set by fulfilment before the mint. From then on the hold never expires. */
  paidAt?: string;
  sessionId?: string;
}

interface Store {
  v: 1;
  orders: Record<string, HeldOrder>;
}

let store: Store = { v: 1, orders: {} };
let loaded = false;
let unreadable: string | null = null;
/** prepare-order holds: memory only, insertion-ordered (oldest first). */
const prepared = new Map<string, HeldOrder>();

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  if (!existsSync(STORE_FILE)) return;
  try {
    const raw = JSON.parse(readFileSync(STORE_FILE, "utf-8")) as Store;
    if (raw?.v !== 1 || typeof raw.orders !== "object") throw new Error("unrecognised shape");
    store = raw;
  } catch (err) {
    unreadable = (err as Error).message;
    console.error(`[held-orders] ${STORE_FILE} is present but unreadable (${unreadable}); refusing new holds until it is restored`);
  }
}

function persist(): boolean {
  return writeJsonAtomic(STORE_FILE, store, "held-orders");
}

function key(root: string): string {
  return root.toLowerCase().replace(/^0x/, "");
}

/** Remember a prepare-order box, in memory only. Never throws. */
export function holdPrepared(root: string, json: string, nowMs: number = Date.now()): void {
  const k = key(root);
  prepared.delete(k);
  prepared.set(k, { json, heldAt: new Date(nowMs).toISOString() });
  for (const [k2, o] of prepared) {
    if (prepared.size <= MAX_UNPAID_HOLDS && nowMs - Date.parse(o.heldAt) <= HOLD_TTL_MS) break;
    prepared.delete(k2);
  }
}

/**
 * Persist the hold for a checkout: the buyer is on the way to pay. `json` is
 * the box when checkout received it inline, else the prepared hold is used.
 * Throws when there is nothing to commit or the store cannot take it; the
 * caller then lets fulfilment seal the minimal order.
 */
export function commitHold(
  root: string,
  json: string | null,
  meta: { eventId?: string; seriesId?: string } = {},
  nowMs: number = Date.now(),
): void {
  ensureLoaded();
  if (unreadable) throw new Error(`held-orders store unreadable: ${unreadable}`);
  const k = key(root);
  const bytes = json ?? prepared.get(k)?.json ?? store.orders[k]?.json;
  if (!bytes) throw new Error("nothing held under this reference");
  const existing = store.orders[k];
  if (existing) {
    if (existing.json !== bytes) throw new Error("a different order is already held under this reference");
    if (!existing.eventId && meta.eventId) existing.eventId = meta.eventId;
    if (!existing.seriesId && meta.seriesId) existing.seriesId = meta.seriesId;
    if (!persist()) throw new Error("held-orders write failed");
    return;
  }
  sweepExpired(nowMs, false);
  const unpaid = Object.entries(store.orders).filter(([, o]) => !o.paidAt);
  if (unpaid.length >= MAX_UNPAID_HOLDS) {
    unpaid.sort(([, a], [, b]) => a.heldAt.localeCompare(b.heldAt));
    for (const [k2] of unpaid.slice(0, unpaid.length - MAX_UNPAID_HOLDS + 1)) delete store.orders[k2];
  }
  store.orders[k] = {
    json: bytes,
    heldAt: new Date(nowMs).toISOString(),
    ...(meta.eventId ? { eventId: meta.eventId } : {}),
    ...(meta.seriesId ? { seriesId: meta.seriesId } : {}),
  };
  if (!persist()) {
    delete store.orders[k];
    throw new Error("held-orders write failed");
  }
  prepared.delete(k);
}

/** A copy of the held order (committed first, then prepared), or null. */
export function getHeldOrder(root: string): HeldOrder | null {
  ensureLoaded();
  const k = key(root);
  const o = store.orders[k] ?? prepared.get(k);
  return o ? { ...o } : null;
}

/**
 * Fulfilment claims a held order for a paid session, BEFORE the mint. Returns
 * false when nothing is held (expired, evicted, never held, or the store is
 * unreadable): the caller then seals the minimal order instead.
 */
export function markHeldPaid(root: string, sessionId: string, nowMs: number = Date.now()): boolean {
  ensureLoaded();
  if (unreadable) return false;
  const o = store.orders[key(root)];
  if (!o) return false;
  if (o.paidAt) return true;
  o.paidAt = new Date(nowMs).toISOString();
  o.sessionId = sessionId;
  if (!persist()) {
    delete o.paidAt;
    delete o.sessionId;
    return false;
  }
  return true;
}

/** Drop a hold: once its order is stored on Swarm, or when it is erased. */
export function releaseHeldOrder(root: string): boolean {
  ensureLoaded();
  prepared.delete(key(root));
  if (unreadable) return false;
  const k = key(root);
  const o = store.orders[k];
  if (!o) return true;
  delete store.orders[k];
  if (!persist()) {
    store.orders[k] = o;
    return false;
  }
  return true;
}

/** Paid orders still waiting to be stored, oldest first. */
export function paidUnstored(): Array<{ root: string } & HeldOrder> {
  ensureLoaded();
  return Object.entries(store.orders)
    .filter(([, o]) => o.paidAt)
    .map(([root, o]) => ({ root, ...o }))
    .sort((a, b) => a.paidAt!.localeCompare(b.paidAt!));
}

/** Delete unpaid holds past HOLD_TTL_MS. Returns how many went. */
export function sweepExpired(nowMs: number = Date.now(), write = true): number {
  ensureLoaded();
  for (const [k, o] of prepared) if (nowMs - Date.parse(o.heldAt) > HOLD_TTL_MS) prepared.delete(k);
  if (unreadable) return 0;
  let n = 0;
  for (const [k, o] of Object.entries(store.orders)) {
    if (!o.paidAt && nowMs - Date.parse(o.heldAt) > HOLD_TTL_MS) {
      delete store.orders[k];
      n++;
    }
  }
  if (n > 0 && write) persist();
  return n;
}

export function heldOrdersHealth(nowMs: number = Date.now()) {
  ensureLoaded();
  const paid = unreadable ? [] : paidUnstored();
  const oldestPaidMs = paid.length ? nowMs - Date.parse(paid[0].paidAt!) : 0;
  const unpaid = Object.values(store.orders).filter((o) => !o.paidAt).length;
  return {
    ok: !unreadable && oldestPaidMs < 15 * 60 * 1000,
    unreadable: unreadable !== null,
    prepared: prepared.size,
    unpaid,
    paidUnstored: paid.length,
    oldestPaidUnstoredMinutes: Math.round(oldestPaidMs / 60000),
  };
}

/** Test seam only. */
export function _setMaxUnpaidHoldsForTests(n: number): void {
  MAX_UNPAID_HOLDS = n;
}

/** Test seam only. */
export function _resetHeldOrdersForTests(): void {
  prepared.clear();
  store = { v: 1, orders: {} };
  loaded = false;
  unreadable = null;
}
