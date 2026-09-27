/**
 * Which slot of which attendee batch holds each chunk of each order (#546).
 *
 * This file is what makes one order erasable. A chunk is removed from Swarm by
 * stamping another chunk into the SAME (batch, bucket, slot) with a newer
 * timestamp, so the burn needs exactly what is recorded here, and nothing else
 * can supply it: the network does not index stamps by owner, and our bee never
 * sees these stamps as its own.
 *
 * WRITE-AHEAD. A slot is allocated and persisted BEFORE anything is signed or
 * uploaded. A crash after that wastes the slot; a crash before it signs
 * nothing. The one thing that must never happen is handing out an index twice:
 * a second chunk in an occupied slot with a newer stamp EVICTS the first, which
 * is a burn of a live order. Hence the rules below, all fail-closed:
 *   - allocation is synchronous and persisted with `writeJsonAtomic` before it
 *     returns, so two checkouts in this process can never read the same counter;
 *   - an order that does not fit (any of its chunks lands in a full bucket) is
 *     refused whole, with no partial allocation;
 *   - a present-but-unreadable file refuses every allocation rather than
 *     starting its counters again from zero;
 *   - a batch is only used after an explicit registration that asserts it is
 *     FRESH. A batch whose ledger was lost must never be registered again: buy
 *     a new one. Its unknown slots cannot be told apart from free ones.
 *
 * MUST survive restarts, and must be backed up. Losing it does not lose any
 * order (the chunks stay on Swarm and every reference still resolves), but it
 * loses the ability to erase them individually, for good.
 *
 * In-memory authoritative while the server runs: operators change it through
 * `/api/ops/attendee-batch/*`, never by editing the file.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../marketing/persist.js";
import { bucketOf, decodeTimestampNs, encodeTimestampNs, nextTimestampNs, slotsPerBucket } from "./stamp.js";

const DATA_DIR = join(process.cwd(), ".data");
const STORE_FILE = join(DATA_DIR, "attendee-slots.json");

export type OrderKind = "prepared" | "checkout" | "fallback";
export type OrderState = "allocated" | "stored" | "burned";

export interface ChunkSlot {
  /** Chunk address, hex, no 0x. */
  address: string;
  bucket: number;
  slot: number;
  /** The exact 8 timestamp bytes of the stamp, hex. A burn must beat these. */
  ts: string;
  /** Timestamp of a burn persisted BEFORE its upload, so a retry re-sends the
   *  identical stamp instead of a new one that could be older than the first. */
  burnTs?: string;
  burnedAt?: string;
}

export interface OrderRecord {
  batchId: string;
  kind: OrderKind;
  eventId?: string;
  seriesId?: string;
  createdAt: string;
  /** `allocated` = slots reserved, upload not confirmed (a crash, or still in flight).
   *  Treat it as possibly on the network: burnable, never reissued. */
  state: OrderState;
  /** Distinct chunk addresses of the order, data chunks first, root last. */
  chunks: ChunkSlot[];
  burnedAt?: string;
}

export interface BatchRecord {
  depth: number;
  /** Batch owner as registered, lowercase 0x address. Must be the stamper. */
  owner: string;
  /** bucket → next free slot. Only ever increases. */
  next: Record<string, number>;
  registeredAt: string;
}

interface Store {
  v: 1;
  active: string | null;
  batches: Record<string, BatchRecord>;
  orders: Record<string, OrderRecord>;
}

export class AttendeeStoreUnavailableError extends Error {
  constructor(detail: string) {
    super(`attendee storage unavailable: ${detail}`);
    this.name = "AttendeeStoreUnavailableError";
  }
}

/** Per-address, so it clears for a different order (new bytes, new buckets). */
export class AttendeeBucketFullError extends Error {
  constructor(bucket: number) {
    super(`attendee batch bucket ${bucket} is full`);
    this.name = "AttendeeBucketFullError";
  }
}

let store: Store = emptyStore();
let loaded = false;
/** Set when the file exists but cannot be read: every allocation refuses. */
let unreadable: string | null = null;

function emptyStore(): Store {
  return { v: 1, active: null, batches: {}, orders: {} };
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  if (!existsSync(STORE_FILE)) return;
  try {
    const raw = JSON.parse(readFileSync(STORE_FILE, "utf-8")) as Store;
    if (raw?.v !== 1 || typeof raw.batches !== "object" || typeof raw.orders !== "object") {
      throw new Error("unrecognised shape");
    }
    store = raw;
    console.log(
      `[attendee-batch] loaded ${Object.keys(store.orders).length} orders across ${Object.keys(store.batches).length} batches (active ${store.active ?? "none"})`,
    );
  } catch (err) {
    unreadable = (err as Error).message;
    console.error(`[attendee-batch] ${STORE_FILE} is present but unreadable (${unreadable}); refusing every allocation until it is restored`);
  }
}

/** Persist, or throw. Callers roll back their in-memory change on a throw. */
function persistOrThrow(): void {
  if (!writeJsonAtomic(STORE_FILE, store, "attendee-slots")) {
    throw new AttendeeStoreUnavailableError("ledger write failed");
  }
}

function normalizeHex(hex: string): string {
  return hex.toLowerCase().replace(/^0x/, "");
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/**
 * Register a newly bought batch. `fresh` is the operator's assertion that no
 * chunk has ever been stamped into it under a ledger we no longer have.
 */
export function registerBatch(batchId: string, depth: number, owner: string, fresh: boolean): BatchRecord {
  ensureLoaded();
  if (unreadable) throw new AttendeeStoreUnavailableError(`ledger unreadable: ${unreadable}`);
  if (!fresh) throw new Error("refusing to register a batch without the fresh assertion");
  const id = normalizeHex(batchId);
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error("batchId must be 32 bytes of hex");
  if (store.batches[id]) throw new Error(`batch ${id} is already registered`);
  slotsPerBucket(depth);
  const record: BatchRecord = { depth, owner: owner.toLowerCase(), next: {}, registeredAt: new Date().toISOString() };
  store.batches[id] = record;
  try {
    persistOrThrow();
  } catch (err) {
    delete store.batches[id];
    throw err;
  }
  return structuredClone(record);
}

/** New orders go to `batchId`. Old orders stay where they were stamped. */
export function setActiveBatch(batchId: string): void {
  ensureLoaded();
  if (unreadable) throw new AttendeeStoreUnavailableError(`ledger unreadable: ${unreadable}`);
  const id = normalizeHex(batchId);
  if (!store.batches[id]) throw new Error(`batch ${id} is not registered`);
  const previous = store.active;
  store.active = id;
  try {
    persistOrThrow();
  } catch (err) {
    store.active = previous;
    throw err;
  }
}

/**
 * Why a new order cannot be stored right now, or null if it can. Checkout asks
 * this before charging a card: every order write goes through this ledger, the
 * fulfilment fallback included, so an unavailable ledger would otherwise turn
 * every paid sale into a refund.
 */
export function attendeeStoreRefusal(expectedOwner: string | null): string | null {
  ensureLoaded();
  if (unreadable) return `ledger unreadable: ${unreadable}`;
  if (!expectedOwner) return "no stamper key configured";
  if (!store.active) return "no active attendee batch";
  const batch = store.batches[store.active];
  if (!batch) return "active batch is not registered";
  if (batch.owner !== expectedOwner.toLowerCase()) return "active batch is owned by a different key than the stamper";
  return null;
}

export interface AllocatedOrder {
  root: string;
  record: OrderRecord;
  depth: number;
}

/**
 * Reserve a slot for every chunk of one order and persist, before anything is
 * signed. Idempotent on the root: a retried upload of the same bytes gets the
 * slots it already holds (the stamps re-sign identically: RFC 6979 signatures
 * are deterministic), never a second set.
 */
export function allocateOrder(
  root: Uint8Array,
  chunkAddresses: Uint8Array[],
  meta: { kind: OrderKind; eventId?: string; seriesId?: string },
  nowMs: number = Date.now(),
): AllocatedOrder {
  ensureLoaded();
  if (unreadable) throw new AttendeeStoreUnavailableError(`ledger unreadable: ${unreadable}`);
  const rootHex = toHex(root);
  const existing = store.orders[rootHex];
  if (existing) {
    const batch = store.batches[existing.batchId];
    if (!batch) throw new AttendeeStoreUnavailableError(`order ${rootHex} names an unregistered batch`);
    if (existing.state === "burned") throw new Error(`order ${rootHex} was erased; refusing to store it again`);
    return { root: rootHex, record: structuredClone(existing), depth: batch.depth };
  }
  if (!store.active) throw new AttendeeStoreUnavailableError("no active attendee batch");
  const batchId = store.active;
  const batch = store.batches[batchId];
  if (!batch) throw new AttendeeStoreUnavailableError("active batch is not registered");
  const capacity = slotsPerBucket(batch.depth);

  const distinct: Uint8Array[] = [];
  const seen = new Set<string>();
  for (const address of chunkAddresses) {
    const hex = toHex(address);
    if (address.length !== 32) throw new Error(`chunk address must be 32 bytes, got ${address.length}`);
    if (seen.has(hex)) continue;
    seen.add(hex);
    distinct.push(address);
  }
  if (distinct.length === 0 || toHex(distinct[distinct.length - 1]) !== rootHex) {
    throw new Error("the root must be the last chunk of the order");
  }

  const ts = toHex(encodeTimestampNs(nextTimestampNs(0n, nowMs)));
  const taken = new Map<number, number>();
  const chunks: ChunkSlot[] = [];
  for (const address of distinct) {
    const bucket = bucketOf(address);
    const slot = (batch.next[bucket] ?? 0) + (taken.get(bucket) ?? 0);
    if (slot >= capacity) throw new AttendeeBucketFullError(bucket);
    taken.set(bucket, (taken.get(bucket) ?? 0) + 1);
    chunks.push({ address: toHex(address), bucket, slot, ts });
  }

  const record: OrderRecord = {
    batchId,
    kind: meta.kind,
    ...(meta.eventId ? { eventId: meta.eventId } : {}),
    ...(meta.seriesId ? { seriesId: meta.seriesId } : {}),
    createdAt: new Date(nowMs).toISOString(),
    state: "allocated",
    chunks,
  };
  const before = new Map<number, number | undefined>();
  for (const [bucket, n] of taken) {
    before.set(bucket, batch.next[bucket]);
    batch.next[bucket] = (batch.next[bucket] ?? 0) + n;
  }
  store.orders[rootHex] = record;
  try {
    persistOrThrow();
  } catch (err) {
    delete store.orders[rootHex];
    for (const [bucket, prev] of before) {
      if (prev === undefined) delete batch.next[bucket];
      else batch.next[bucket] = prev;
    }
    throw err;
  }
  return { root: rootHex, record: structuredClone(record), depth: batch.depth };
}

export function markOrderStored(root: string): void {
  ensureLoaded();
  const record = store.orders[normalizeHex(root)];
  if (!record || record.state !== "allocated") return;
  record.state = "stored";
  try {
    persistOrThrow();
  } catch (err) {
    record.state = "allocated";
    throw err;
  }
}

/**
 * Persist the timestamp a chunk's burn will carry, before the burn is uploaded.
 * Returns the planned timestamp; an existing plan is returned unchanged.
 */
export function planChunkBurn(root: string, address: string, nowMs: number = Date.now()): string {
  ensureLoaded();
  if (unreadable) throw new AttendeeStoreUnavailableError(`ledger unreadable: ${unreadable}`);
  const record = store.orders[normalizeHex(root)];
  if (!record) throw new Error(`no order ${root}`);
  const chunk = record.chunks.find((c) => c.address === normalizeHex(address));
  if (!chunk) throw new Error(`order ${root} has no chunk ${address}`);
  if (chunk.burnedAt) throw new Error(`chunk ${address} is already burned`);
  if (chunk.burnTs) return chunk.burnTs;
  const burnTs = toHex(encodeTimestampNs(nextTimestampNs(decodeTimestampNs(Buffer.from(chunk.ts, "hex")), nowMs)));
  chunk.burnTs = burnTs;
  try {
    persistOrThrow();
  } catch (err) {
    delete chunk.burnTs;
    throw err;
  }
  return burnTs;
}

/** Record one burned chunk; the order is burned once every chunk is. */
export function markChunkBurned(root: string, address: string, burnTs: string, nowMs: number = Date.now()): OrderRecord {
  ensureLoaded();
  if (unreadable) throw new AttendeeStoreUnavailableError(`ledger unreadable: ${unreadable}`);
  const record = store.orders[normalizeHex(root)];
  if (!record) throw new Error(`no order ${root}`);
  const chunk = record.chunks.find((c) => c.address === normalizeHex(address));
  if (!chunk) throw new Error(`order ${root} has no chunk ${address}`);
  if (decodeTimestampNs(Buffer.from(burnTs, "hex")) <= decodeTimestampNs(Buffer.from(chunk.ts, "hex"))) {
    throw new Error("a burn must carry a newer timestamp than the stamp it replaces");
  }
  const previous = { chunkTs: chunk.ts, chunkBurnTs: chunk.burnTs, chunkBurnedAt: chunk.burnedAt, state: record.state, burnedAt: record.burnedAt };
  const at = new Date(nowMs).toISOString();
  chunk.ts = burnTs;
  delete chunk.burnTs;
  chunk.burnedAt = at;
  if (record.chunks.every((c) => c.burnedAt)) {
    record.state = "burned";
    record.burnedAt = at;
  }
  try {
    persistOrThrow();
  } catch (err) {
    chunk.ts = previous.chunkTs;
    if (previous.chunkBurnTs) chunk.burnTs = previous.chunkBurnTs;
    chunk.burnedAt = previous.chunkBurnedAt;
    record.state = previous.state;
    record.burnedAt = previous.burnedAt;
    throw err;
  }
  return structuredClone(record);
}

/** A copy: the store is authoritative in memory, so callers must not be able to edit it. */
export function getOrderRecord(root: string): OrderRecord | null {
  ensureLoaded();
  const record = store.orders[normalizeHex(root)];
  return record ? structuredClone(record) : null;
}

/** An erased order must never be fetched and shown again, even from our bee's cache. */
export function isOrderErased(root: string): boolean {
  return getOrderRecord(root)?.state === "burned";
}

export function getBatchRecord(batchId: string): BatchRecord | null {
  ensureLoaded();
  const record = store.batches[normalizeHex(batchId)];
  return record ? structuredClone(record) : null;
}

export interface AttendeeLedgerStatus {
  readable: boolean;
  active: string | null;
  batches: Array<{ batchId: string; depth: number; owner: string; fullestBucket: number; fullestUsed: number; capacity: number }>;
  orders: Record<OrderState, number>;
}

export function attendeeLedgerStatus(): AttendeeLedgerStatus {
  ensureLoaded();
  const orders: Record<OrderState, number> = { allocated: 0, stored: 0, burned: 0 };
  for (const record of Object.values(store.orders)) orders[record.state]++;
  const batches = Object.entries(store.batches).map(([batchId, b]) => {
    let fullestBucket = -1;
    let fullestUsed = 0;
    for (const [bucket, used] of Object.entries(b.next)) {
      if (used > fullestUsed) {
        fullestUsed = used;
        fullestBucket = Number(bucket);
      }
    }
    return { batchId, depth: b.depth, owner: b.owner, fullestBucket, fullestUsed, capacity: slotsPerBucket(b.depth) };
  });
  return { readable: unreadable === null, active: store.active, batches, orders };
}

/** Test seam only: forget memory and reload from disk on next use. */
export function _resetAttendeeLedgerForTests(): void {
  store = emptyStore();
  loaded = false;
  unreadable = null;
}
