/**
 * Erase one attendee order from Swarm by burning its slots (#546).
 *
 * A storer keeps one chunk per (batch, bucket, slot) and replaces it when a
 * chunk arrives with a strictly newer stamp for that slot, whatever the batch
 * type (bee `reserve.Put`, verified on #546). So each chunk of the order is
 * replaced by a BURNER stamped into its exact slot with a newer timestamp.
 * Every chunk is burned, the intermediate root included: a leftover data chunk
 * would still be fetchable by its own address.
 *
 * The burner is a single-owner chunk owned by the stamper key, with a constant
 * payload and an identifier mined so its address falls in the target bucket (a
 * stamp is only valid for the bucket of the address it carries). Mining is
 * deterministic, so each bucket has exactly one burner, re-derived rather than
 * stored; one burner in several slots is safe because storers reference-count
 * a chunk across stamps.
 *
 * What this does NOT reach, stated so nobody claims otherwise: a copy some other
 * party stored under its own stamp, and retrieval caches (our own light bee's
 * included). Readers inside WoCo are gated on the ledger instead.
 */

import { BatchId, Utils, type EnvelopeWithBatchId } from "@ethersphere/bee-js";
import { calculateCacAddress, calculateSocAddress, encodeSpan, personalSignKeccak, socSignDigest } from "@woco/shared";
import { getBytes, keccak256 } from "ethers";
import { BEE_URL } from "../../config/swarm.js";
import { BEE_CALL_TIMEOUT_MS, beeUploadSem, withTimeout } from "../swarm/upload-queue.js";
import { getBatchRecord, getOrderRecord, markChunkBurned, planChunkBurn, type OrderRecord } from "./ledger.js";
import { bucketOf, decodeTimestampNs, signStamp, type StamperKey } from "./stamp.js";
import { getAttendeeStamper } from "./writer.js";

const BURNER_PAYLOAD = new TextEncoder().encode("woco/attendee-burn/v1");
const BURNER_SPAN = encodeSpan(BURNER_PAYLOAD.length);
const BURNER_CAC = calculateCacAddress(BURNER_SPAN, BURNER_PAYLOAD);
const BURNER_ID_PREFIX = getBytes(keccak256(BURNER_PAYLOAD)).slice(0, 24);

export interface Burner {
  identifier: Uint8Array;
  owner: Uint8Array;
  address: Uint8Array;
  /** 65-byte SOC signature over (identifier, CAC address). */
  signature: Uint8Array;
  /** span || payload, the body `POST /soc` takes. */
  body: Uint8Array;
}

const burners = new Map<string, Burner>();

/**
 * The one burner SOC for (owner, bucket). The identifier is a fixed prefix plus
 * an 8-byte counter, searched from zero, so the result is deterministic. About
 * 65,536 keccaks on average: tens of milliseconds.
 */
export function burnerFor(key: StamperKey, bucket: number): Burner {
  const owner = key.address;
  const cacheKey = `${Buffer.from(owner).toString("hex")}:${bucket}`;
  const cached = burners.get(cacheKey);
  if (cached) return cached;
  const identifier = new Uint8Array(32);
  identifier.set(BURNER_ID_PREFIX, 0);
  const view = new DataView(identifier.buffer);
  for (let n = 0n; ; n++) {
    view.setBigUint64(24, n, false);
    const address = calculateSocAddress(identifier, owner);
    if (bucketOf(address) !== bucket) continue;
    const signature = personalSignKeccak(socSignDigest(identifier, BURNER_CAC), key.privateKey);
    const body = new Uint8Array(BURNER_SPAN.length + BURNER_PAYLOAD.length);
    body.set(BURNER_SPAN);
    body.set(BURNER_PAYLOAD, BURNER_SPAN.length);
    const burner = { identifier: identifier.slice(), owner, address, signature, body };
    burners.set(cacheKey, burner);
    return burner;
  }
}

/** Upload a burner with a pre-signed stamp; returns the SOC address bee computed, hex. */
export type BurnerUploader = (burner: Burner, envelope: EnvelopeWithBatchId) => Promise<string>;

export const liveBurnerUploader: BurnerUploader = async (burner, envelope) => {
  const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
  const url = `${BEE_URL}/soc/${hex(burner.owner)}/${hex(burner.identifier)}?sig=${hex(burner.signature)}`;
  const release = await beeUploadSem.acquire();
  try {
    const resp = await withTimeout(
      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "Swarm-Postage-Stamp": Utils.convertEnvelopeToMarshaledStamp(envelope).toHex(),
          // Synchronous on purpose: return only once the burner has been pushed
          // toward the neighbourhood that holds the slot.
          "Swarm-Deferred-Upload": "false",
        },
        body: Buffer.from(burner.body),
      }),
      BEE_CALL_TIMEOUT_MS,
      "attendee burn",
    );
    if (!resp.ok) throw new Error(`bee /soc ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 200)}`);
    const { reference } = (await resp.json()) as { reference: string };
    return reference.toLowerCase().replace(/^0x/, "");
  } finally {
    release();
  }
};

export interface BurnDeps {
  stamper: () => StamperKey | null;
  upload: BurnerUploader;
}

const liveDeps: BurnDeps = { stamper: getAttendeeStamper, upload: liveBurnerUploader };

/**
 * Burn every chunk of an order. Resumable: a chunk already burned is skipped,
 * and a chunk whose burn was planned but not confirmed is re-sent with the SAME
 * timestamp, so a retry never produces a stamp older than one that landed.
 */
export async function burnOrder(root: string, deps: BurnDeps = liveDeps): Promise<OrderRecord> {
  const key = deps.stamper();
  if (!key) throw new Error("no stamper key configured");
  const record = getOrderRecord(root);
  if (!record) throw new Error(`no attendee order ${root}`);
  if (record.state === "burned") return record;
  const batch = getBatchRecord(record.batchId);
  if (!batch) throw new Error(`order ${root} names an unregistered batch`);
  if (batch.owner !== key.addressHex) throw new Error("the stamper key does not own this order's batch");

  const batchId = new BatchId(record.batchId);
  let latest = record;
  for (const chunk of record.chunks) {
    // Re-read: a concurrent burn of the same order may have finished this chunk
    // while we awaited the previous upload. Read and plan are both synchronous.
    if (getOrderRecord(root)?.chunks.find((c) => c.address === chunk.address)?.burnedAt) continue;
    const burner = burnerFor(key, chunk.bucket);
    const burnTs = planChunkBurn(root, chunk.address);
    const envelope = signStamp(key, batchId, burner.address, chunk.slot, decodeTimestampNs(Buffer.from(burnTs, "hex")));
    const reference = await deps.upload(burner, envelope);
    if (reference !== Buffer.from(burner.address).toString("hex")) {
      throw new Error(`burn of ${chunk.address}: bee computed ${reference} for the burner`);
    }
    latest = markChunkBurned(root, chunk.address, burnTs);
  }
  return latest;
}

/** Test seam only. */
export function _clearBurnerCacheForTests(): void {
  burners.clear();
}
