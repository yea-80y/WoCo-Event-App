/**
 * Operator actions on the attendee batch (#546), behind `/api/ops/attendee-batch`.
 *
 * Registration reads the batch from chain (through our bee's view of every
 * postage batch) instead of trusting what the operator typed: the depth comes
 * from chain, and the batch is refused unless the stamper owns it. A batch the
 * stamper does not own would take every order write and then have each one
 * rejected by the network, after the card was charged.
 */

import { getBee } from "../../config/swarm.js";
import { registerBatch, type BatchRecord } from "./ledger.js";
import { BUCKET_DEPTH } from "./stamp.js";
import { attendeeStamperAddress } from "./writer.js";

export interface ChainBatch {
  owner: string;
  depth: number;
  bucketDepth: number;
  immutable: boolean;
  /** Seconds; bee reports -1 or 0 for a dead batch. */
  batchTTL: number;
}

export type BatchLookup = (batchId: string) => Promise<ChainBatch | null>;

export const liveBatchLookup: BatchLookup = async (batchId) => {
  const all = await getBee().getGlobalPostageBatches();
  const found = all.find((b) => b.batchID.toHex().toLowerCase() === batchId);
  if (!found) return null;
  return {
    owner: `0x${found.owner.toHex()}`.toLowerCase(),
    depth: found.depth,
    bucketDepth: found.bucketDepth,
    immutable: found.immutable,
    batchTTL: found.batchTTL,
  };
};

export async function registerAttendeeBatch(
  rawBatchId: string,
  fresh: boolean,
  lookup: BatchLookup = liveBatchLookup,
): Promise<{ batch: BatchRecord; chain: ChainBatch }> {
  const batchId = rawBatchId.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(batchId)) throw new Error("batchId must be 32 bytes of hex");
  const stamper = attendeeStamperAddress();
  if (!stamper) throw new Error("ATTENDEE_STAMPER_PRIVATE_KEY is not configured");
  const chain = await lookup(batchId);
  if (!chain) throw new Error("batch not found on chain (a new batch can take a few minutes to reach the bee)");
  if (chain.owner !== stamper) throw new Error(`batch is owned by ${chain.owner}, not the stamper ${stamper}`);
  if (chain.bucketDepth !== BUCKET_DEPTH) throw new Error(`batch bucket depth is ${chain.bucketDepth}, expected ${BUCKET_DEPTH}`);
  if (!(chain.batchTTL > 0)) throw new Error("batch has no remaining TTL");
  const batch = registerBatch(batchId, chain.depth, chain.owner, fresh);
  return { batch, chain };
}
