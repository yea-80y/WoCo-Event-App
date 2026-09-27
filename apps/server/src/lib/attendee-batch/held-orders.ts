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
 * `commitHold` (create-checkout, the buyer is on the way to Stripe: one file) ->
 * `markHeldPaid` (fulfilment, before the mint) -> stored on the attendee batch
 * once tickets are minted (fulfilment, then the retry worker) ->
 * `releaseHeldOrder`. Unpaid holds go after HOLD_TTL_MS; paid ones are kept
 * until stored, however long that takes. A prepared hold lost to a restart
 * costs nothing: checkout re-holds the box the client sends inline.
 *
 * ONE FILE PER COMMITTED HOLD (`.data/held-orders/{root}.json`, the
 * broadcast-jobs pattern): each commit, payment mark and release touches one
 * small file, never a rewrite of every hold. The directory MUST survive
 * restarts: a paid order that is not yet stored exists nowhere else. A file
 * that does not parse is left untouched, counted, and its reference refused;
 * an unreadable directory refuses every commit (the sale then gets the
 * minimal server seal) until it is restored.
 */

import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../marketing/persist.js";

const DATA_DIR = join(process.cwd(), ".data");
const HOLDS_DIR = join(DATA_DIR, "held-orders");

/** Matches the order-ref token's lifetime: after that the ref cannot be used anyway. */
export const HOLD_TTL_MS = 24 * 60 * 60 * 1000;
/** Committed unpaid holds kept at most; the oldest makes room, so a full store
 *  never refuses a sale. Paid ones never count. */
export let MAX_UNPAID_HOLDS = 5_000;
/** Prepared (memory) holds kept at most. They live minutes; the oldest makes room. */
export let MAX_PREPARED_HOLDS = 1_000;

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

const committed = new Map<string, HeldOrder>();
/** prepare-order holds: memory only, insertion-ordered (oldest first). */
const prepared = new Map<string, HeldOrder>();
/** References whose file would not parse: left alone, never overwritten. */
const unreadableRefs = new Set<string>();
let dirUnreadable: string | null = null;
let loaded = false;

function key(root: string): string {
  return root.toLowerCase().replace(/^0x/, "");
}

function fileFor(k: string): string {
  return join(HOLDS_DIR, `${k}.json`);
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  if (!existsSync(HOLDS_DIR)) return;
  let names: string[];
  try {
    names = readdirSync(HOLDS_DIR).filter((n) => /^[0-9a-f]{64}\.json$/.test(n));
  } catch (err) {
    dirUnreadable = (err as Error).message;
    console.error(`[held-orders] ${HOLDS_DIR} is unreadable (${dirUnreadable}); refusing new holds until it is restored`);
    return;
  }
  for (const name of names) {
    const k = name.slice(0, 64);
    try {
      const o = JSON.parse(readFileSync(join(HOLDS_DIR, name), "utf-8")) as HeldOrder;
      if (typeof o?.json !== "string" || typeof o.heldAt !== "string") throw new Error("unrecognised shape");
      committed.set(k, o);
    } catch (err) {
      unreadableRefs.add(k);
      console.error(`[held-orders] ${name} is unreadable (${(err as Error).message}); left untouched`);
    }
  }
}

function writeHold(k: string, o: HeldOrder): boolean {
  return writeJsonAtomic(fileFor(k), o, "held-orders");
}

function deleteHold(k: string): boolean {
  try {
    unlinkSync(fileFor(k));
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/** Remember a prepare-order box, in memory only. Never throws. */
export function holdPrepared(root: string, json: string, nowMs: number = Date.now()): void {
  const k = key(root);
  prepared.delete(k);
  prepared.set(k, { json, heldAt: new Date(nowMs).toISOString() });
  for (const [k2, o] of prepared) {
    if (prepared.size <= MAX_PREPARED_HOLDS && nowMs - Date.parse(o.heldAt) <= HOLD_TTL_MS) break;
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
  if (dirUnreadable) throw new Error(`held-orders store unreadable: ${dirUnreadable}`);
  const k = key(root);
  if (unreadableRefs.has(k)) throw new Error("the held-order file for this reference is unreadable");
  const existing = committed.get(k);
  const bytes = json ?? prepared.get(k)?.json ?? existing?.json;
  if (!bytes) throw new Error("nothing held under this reference");
  if (existing) {
    if (existing.json !== bytes) throw new Error("a different order is already held under this reference");
    const next = { ...existing };
    if (!next.eventId && meta.eventId) next.eventId = meta.eventId;
    if (!next.seriesId && meta.seriesId) next.seriesId = meta.seriesId;
    if (next.eventId === existing.eventId && next.seriesId === existing.seriesId) return;
    if (!writeHold(k, next)) throw new Error("held-orders write failed");
    committed.set(k, next);
    return;
  }
  sweepExpired(nowMs);
  const unpaid = [...committed].filter(([, o]) => !o.paidAt);
  if (unpaid.length >= MAX_UNPAID_HOLDS) {
    unpaid.sort(([, a], [, b]) => a.heldAt.localeCompare(b.heldAt));
    for (const [k2] of unpaid.slice(0, unpaid.length - MAX_UNPAID_HOLDS + 1)) {
      if (deleteHold(k2)) committed.delete(k2);
    }
  }
  const o: HeldOrder = {
    json: bytes,
    heldAt: new Date(nowMs).toISOString(),
    ...(meta.eventId ? { eventId: meta.eventId } : {}),
    ...(meta.seriesId ? { seriesId: meta.seriesId } : {}),
  };
  if (!writeHold(k, o)) throw new Error("held-orders write failed");
  committed.set(k, o);
  prepared.delete(k);
}

/** A copy of the held order (committed first, then prepared), or null. */
export function getHeldOrder(root: string): HeldOrder | null {
  ensureLoaded();
  const k = key(root);
  const o = committed.get(k) ?? prepared.get(k);
  return o ? { ...o } : null;
}

/**
 * Fulfilment claims a committed hold for a paid session, BEFORE the mint.
 * Returns false when nothing is held (expired, evicted, never committed,
 * unreadable) or another session already claimed it: the caller then seals
 * the minimal order instead.
 */
export function markHeldPaid(root: string, sessionId: string, nowMs: number = Date.now()): boolean {
  ensureLoaded();
  const k = key(root);
  const o = committed.get(k);
  if (!o) return false;
  if (o.paidAt) return o.sessionId === sessionId;
  const next = { ...o, paidAt: new Date(nowMs).toISOString(), sessionId };
  if (!writeHold(k, next)) return false;
  committed.set(k, next);
  return true;
}

/** Drop a hold: once its order is stored on Swarm, or when it is erased or refunded. */
export function releaseHeldOrder(root: string): boolean {
  ensureLoaded();
  const k = key(root);
  prepared.delete(k);
  if (!committed.has(k)) return true;
  if (!deleteHold(k)) return false;
  committed.delete(k);
  return true;
}

/** Paid orders still waiting to be stored, oldest first. */
export function paidUnstored(): Array<{ root: string } & HeldOrder> {
  ensureLoaded();
  return [...committed]
    .filter(([, o]) => o.paidAt)
    .map(([root, o]) => ({ root, ...o }))
    .sort((a, b) => a.paidAt!.localeCompare(b.paidAt!));
}

/** Delete holds past HOLD_TTL_MS that were never paid. Returns how many went. */
export function sweepExpired(nowMs: number = Date.now()): number {
  ensureLoaded();
  for (const [k, o] of prepared) if (nowMs - Date.parse(o.heldAt) > HOLD_TTL_MS) prepared.delete(k);
  let n = 0;
  for (const [k, o] of committed) {
    if (!o.paidAt && nowMs - Date.parse(o.heldAt) > HOLD_TTL_MS && deleteHold(k)) {
      committed.delete(k);
      n++;
    }
  }
  return n;
}

export function heldOrdersHealth(nowMs: number = Date.now()) {
  ensureLoaded();
  const paid = paidUnstored();
  const oldestPaidMs = paid.length ? nowMs - Date.parse(paid[0].paidAt!) : 0;
  const unreadable = dirUnreadable !== null || unreadableRefs.size > 0;
  return {
    ok: !unreadable && oldestPaidMs < 15 * 60 * 1000,
    unreadable,
    unreadableFiles: unreadableRefs.size,
    prepared: prepared.size,
    unpaid: [...committed.values()].filter((o) => !o.paidAt).length,
    paidUnstored: paid.length,
    oldestPaidUnstoredMinutes: Math.round(oldestPaidMs / 60000),
  };
}

/** Test seam only. */
export function _setHoldCapsForTests(unpaid: number, preparedCap: number): void {
  MAX_UNPAID_HOLDS = unpaid;
  MAX_PREPARED_HOLDS = preparedCap;
}

/** Test seam only: forget memory and reload from disk on next use. */
export function _resetHeldOrdersForTests(): void {
  prepared.clear();
  committed.clear();
  unreadableRefs.clear();
  dirUnreadable = null;
  loaded = false;
}
