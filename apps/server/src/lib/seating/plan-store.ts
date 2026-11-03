/**
 * Seating plans on Swarm (docs/SEATING.md). A plan is immutable content, named by
 * a series' manifest by Swarm ref AND by keccak256 of its exact bytes; the digest is
 * what every read here checks, so a plan is trusted for what it hashes to, never for
 * where it came from (our bee or Etherna).
 */

import {
  encodeSeatPlan,
  parseSeatPlan,
  seatPlanDigest,
  type SeatPlan,
} from "@woco/shared/seating/index";
import { downloadFromBytes, uploadToBytes } from "../swarm/bytes.js";
import { whitelistHashes } from "../swarm/whitelist.js";
import type { BatchSelection } from "../etherna/batch-router.js";

export interface StoredSeatPlan {
  ref: string;
  digest: string;
  seats: number;
}

/**
 * Store a validated plan: its canonical bytes on the event's batch, and on the WoCo
 * batch as well when that is Etherna (browsers read it through our gateway, and a
 * chunk stamped only on Etherna reaches our bee minutes later). Whitelisted before
 * returning: an unwhitelisted chunk reads as absent to a buyer's map.
 */
export async function storeSeatPlan(plan: SeatPlan, selection: BatchSelection): Promise<StoredSeatPlan> {
  const bytes = encodeSeatPlan(plan);
  const digest = seatPlanDigest(bytes);
  const refs = await Promise.all([
    uploadToBytes(bytes, selection),
    ...(selection.target === "etherna" ? [uploadToBytes(bytes)] : []),
  ]);
  const ref = refs[0].toLowerCase().replace(/^0x/, "");
  if (refs.some((r) => r.toLowerCase().replace(/^0x/, "") !== ref)) {
    throw new Error("seat plan upload: the two batches returned different references");
  }
  await whitelistHashes([ref]);
  remember(digest, plan);
  return { ref, digest, seats: plan.seats.length };
}

// Immutable by digest, so a hit never goes stale. Bounded: a big plan is megabytes.
const MEMO_MAX = 32;
const memo = new Map<string, SeatPlan>();

function remember(digest: string, plan: SeatPlan): void {
  memo.delete(digest);
  memo.set(digest, plan);
  while (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value as string);
}

/** Thrown when a plan cannot be read. Distinct from a plan that reads but is wrong (null). */
export class SeatPlanUnavailableError extends Error {
  constructor(ref: string, cause: unknown) {
    super(`seat plan ${ref.slice(0, 12)}… could not be read`);
    this.name = "SeatPlanUnavailableError";
    this.cause = cause;
  }
}

/**
 * The plan at `ref`, only if its bytes hash to `digest` and it is a valid plan; null
 * when what is there is not that plan. Throws `SeatPlanUnavailableError` when it
 * cannot be read at all - a caller on the money path refuses either way.
 */
export async function loadSeatPlan(
  ref: string,
  digest: string,
  download: (ref: string) => Promise<string> = downloadFromBytes,
): Promise<SeatPlan | null> {
  const key = digest.toLowerCase();
  const hit = memo.get(key);
  if (hit) return hit;
  let text: string;
  try {
    text = await download(ref);
  } catch (err) {
    throw new SeatPlanUnavailableError(ref, err);
  }
  // The plan is UTF-8 JSON: re-encoding valid UTF-8 is lossless, and anything else
  // fails the digest.
  const plan = parseSeatPlan(new TextEncoder().encode(text), key);
  if (plan) remember(key, plan);
  return plan;
}
