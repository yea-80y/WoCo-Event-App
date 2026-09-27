/**
 * Store an attendee order blob on the attendee batch, stamped by our own key (#546).
 *
 * Replaces `uploadToBytes` for order blobs, and ONLY for them. The reference it
 * returns is the same `/bytes` root bee would compute (vector-tested), so every
 * reader, the on-chain orderRef and the order-ref token are unchanged.
 *
 * There is deliberately no fallback to the platform batch. A blob stamped there
 * can never be erased on its own, while the Privacy Policy says attendee
 * records can. If this refuses, checkout must refuse before the card is charged
 * (see `attendeeStoreRefusal`), because the fulfilment fallback seal comes here
 * too.
 */

import { BatchId, type EnvelopeWithBatchId } from "@ethersphere/bee-js";
import type { Hex64 } from "@woco/shared";
import { FEED_PRIVATE_KEY, getBee, normalizePk } from "../../config/swarm.js";
import { MAX_ORDER_BOX_JSON } from "../stripe/order-ref.js";
import { isTransientSwarmError } from "../swarm/bytes.js";
import { BEE_CALL_TIMEOUT_MS, beeUploadSem, withTimeout } from "../swarm/upload-queue.js";
import {
  AttendeeStoreUnavailableError,
  allocateOrder,
  attendeeStoreRefusal,
  markOrderStored,
  type OrderKind,
} from "./ledger.js";
import { decodeTimestampNs, signStamp, splitPayload, stamperKeyFromHex, type StamperKey } from "./stamp.js";
import { getHeldOrder, paidUnstored, releaseHeldOrder } from "./held-orders.js";
import { isOrderErased } from "./ledger.js";

/**
 * Owns the attendee batch: every stamp on it is signed with this key, and so is
 * every burn. Separate from FEED_PRIVATE_KEY on purpose: whoever holds it can
 * evict any attendee blob and fill the batch, and that should not come with the
 * key that owns every platform feed. Read on first use: `ATTENDEE_STAMPER_PRIVATE_KEY`.
 */
let stamper: StamperKey | null | undefined;

export function getAttendeeStamper(): StamperKey | null {
  if (stamper !== undefined) return stamper;
  const raw = process.env.ATTENDEE_STAMPER_PRIVATE_KEY || "";
  if (!raw) return (stamper = null);
  const key = normalizePk(raw, "ATTENDEE_STAMPER_PRIVATE_KEY");
  if (FEED_PRIVATE_KEY && normalizePk(FEED_PRIVATE_KEY).toLowerCase() === key.toLowerCase()) {
    throw new Error("ATTENDEE_STAMPER_PRIVATE_KEY must not be the same key as FEED_PRIVATE_KEY");
  }
  return (stamper = stamperKeyFromHex(key));
}

export function attendeeStamperAddress(): string | null {
  return getAttendeeStamper()?.addressHex ?? null;
}

/**
 * Why checkout must not take a card right now, or null. A malformed or reused
 * stamper key refuses sales here instead of throwing into the route: card
 * sales stop, loudly, and nothing else on the platform does.
 */
export function attendeeCheckoutRefusal(): string | null {
  let address: string | null;
  try {
    address = attendeeStamperAddress();
  } catch (err) {
    return `stamper key misconfigured: ${(err as Error).message}`;
  }
  return attendeeStoreRefusal(address);
}

/** Upload one pre-stamped chunk; returns the address bee computed, hex. */
export type ChunkUploader = (envelope: EnvelopeWithBatchId, body: Uint8Array) => Promise<string>;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const liveChunkUploader: ChunkUploader = async (envelope, body) => {
  let delay = 500;
  for (let attempt = 0; ; attempt++) {
    try {
      const release = await beeUploadSem.acquire();
      try {
        const result = await withTimeout(
          getBee().uploadChunk(envelope, body, { deferred: true }),
          BEE_CALL_TIMEOUT_MS,
          "attendee chunk upload",
        );
        return result.reference.toHex();
      } finally {
        release();
      }
    } catch (err) {
      if (isTransientSwarmError(err) && attempt < 4) {
        await wait(delay);
        delay = Math.min(delay * 2, 5000);
        continue;
      }
      throw err;
    }
  }
};

export interface StoreAttendeeDeps {
  stamper: () => StamperKey | null;
  upload: ChunkUploader;
}

const liveDeps: StoreAttendeeDeps = { stamper: getAttendeeStamper, upload: liveChunkUploader };

/**
 * Split, allocate (persisted), sign and upload one order blob. Throws on any
 * failure; the caller decides what a failure means on its path.
 */
export async function storeAttendeePayload(
  data: string | Uint8Array,
  meta: { kind: OrderKind; eventId?: string; seriesId?: string },
  deps: StoreAttendeeDeps = liveDeps,
): Promise<Hex64> {
  const payload = typeof data === "string" ? new TextEncoder().encode(data) : data;
  if (payload.length === 0) throw new Error("refusing to store an empty order blob");
  if (payload.length > MAX_ORDER_BOX_JSON) throw new Error(`order blob exceeds ${MAX_ORDER_BOX_JSON} bytes`);

  const key = deps.stamper();
  if (!key) throw new AttendeeStoreUnavailableError("no stamper key configured");
  const refusal = attendeeStoreRefusal(key.addressHex);
  if (refusal) throw new AttendeeStoreUnavailableError(refusal);

  const { root, chunks } = await splitPayload(payload);
  const { root: rootHex, record } = allocateOrder(root, chunks.map((c) => c.address), meta);
  if (record.state === "stored") return rootHex as Hex64;

  const bodies = new Map(chunks.map((c) => [Buffer.from(c.address).toString("hex"), c.body]));
  const batchId = new BatchId(record.batchId);
  for (const slot of record.chunks) {
    const body = bodies.get(slot.address);
    if (!body) throw new Error(`order ${rootHex}: no chunk body for ${slot.address}`);
    const envelope = signStamp(key, batchId, Buffer.from(slot.address, "hex"), slot.slot, decodeTimestampNs(Buffer.from(slot.ts, "hex")));
    const reference = (await deps.upload(envelope, body)).toLowerCase().replace(/^0x/, "");
    if (reference !== slot.address) {
      throw new Error(`order ${rootHex}: bee computed ${reference} for chunk ${slot.address}`);
    }
  }

  try {
    markOrderStored(rootHex);
  } catch (err) {
    // Every chunk landed; `allocated` is the conservative state (burnable,
    // never reissued), so the order still stands.
    console.error(`[attendee-batch] order ${rootHex} uploaded but not marked stored:`, (err as Error).message);
  }
  return rootHex as Hex64;
}

/**
 * The reference an order box WILL have once stored: its `/bytes` root,
 * computed locally with no upload. Paid-only storage (#546) hands this out at
 * prepare-order and checkout, and fulfilment stores the bytes after payment.
 */
export async function orderRefOf(json: string): Promise<Hex64> {
  const { root } = await splitPayload(new TextEncoder().encode(json));
  return Buffer.from(root).toString("hex") as Hex64;
}

/**
 * Store a paid, held order on the attendee batch, then drop the hold. Throws
 * when nothing is held or the store fails; the hold then stays for the retry
 * worker. Idempotent: the ledger returns an already-stored order unchanged.
 */
export async function storeHeldOrder(root: string, deps: StoreAttendeeDeps = liveDeps): Promise<Hex64> {
  const ref = root.toLowerCase().replace(/^0x/, "");
  if (isOrderErased(ref)) throw new Error(`order ${ref} was erased; not storing it`);
  const held = getHeldOrder(ref);
  if (!held) throw new Error(`no held order ${ref}`);
  storesInFlight.add(ref);
  try {
    const stored = await storeAttendeePayload(
      held.json,
      { kind: "checkout", ...(held.eventId ? { eventId: held.eventId } : {}), ...(held.seriesId ? { seriesId: held.seriesId } : {}) },
      deps,
    );
    if (stored !== ref) throw new Error(`held order ${ref} hashes to ${stored}; not releasing it`);
    if (!releaseHeldOrder(ref)) console.error(`[attendee-batch] order ${ref} stored but its hold could not be released`);
    return stored;
  } finally {
    storesInFlight.delete(ref);
  }
}

/** Held orders being stored right now. An erasure must wait for the store to
 *  finish (then burn it) rather than delete the hold underneath it. */
const storesInFlight = new Set<string>();

export function isStoreInFlight(root: string): boolean {
  return storesInFlight.has(root.toLowerCase().replace(/^0x/, ""));
}

/** Store paid orders whose store at fulfilment failed (bee down, bucket full). */
export async function retryPaidHeldOrders(limit = 20, deps: StoreAttendeeDeps = liveDeps): Promise<{ stored: number; failed: number }> {
  let stored = 0;
  let failed = 0;
  for (const order of paidUnstored().slice(0, limit)) {
    try {
      await storeHeldOrder(order.root, deps);
      stored++;
    } catch (err) {
      failed++;
      console.warn(`[attendee-batch] paid order ${order.root} still not stored:`, (err as Error).message);
    }
  }
  return { stored, failed };
}

/** Test seam only. */
export function _resetAttendeeStamperForTests(): void {
  stamper = undefined;
}
