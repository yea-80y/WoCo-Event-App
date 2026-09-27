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

/** Why checkout must not take a card right now, or null. */
export function attendeeCheckoutRefusal(): string | null {
  return attendeeStoreRefusal(attendeeStamperAddress());
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

/** Test seam only. */
export function _resetAttendeeStamperForTests(): void {
  stamper = undefined;
}
