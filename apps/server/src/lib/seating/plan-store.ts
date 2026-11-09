/**
 * Seating plans on Swarm (docs/SEATING.md). A plan is immutable content, named by
 * a series' manifest by Swarm ref AND by keccak256 of its exact bytes; the digest is
 * what every read here checks, so a plan is trusted for what it hashes to, never for
 * where it came from (our bee or Etherna).
 */

import {
  MAX_SEAT_PLAN_BYTES,
  canonicalSeatPlan,
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

/** A plan whose canonical bytes exceed MAX_SEAT_PLAN_BYTES: every reader would refuse it. */
export class SeatPlanTooLargeError extends Error {
  constructor(bytes: number) {
    super(`seat plan is ${bytes} bytes, over the ${MAX_SEAT_PLAN_BYTES}-byte cap`);
    this.name = "SeatPlanTooLargeError";
  }
}

/**
 * Store a validated plan: its canonical bytes on the event's batch, ONE copy (owner
 * 2026-10-21: no permanent double-stamping of Etherna-routed content). For an Etherna
 * event a buyer's map may need a few minutes before our gateway serves it; the server's
 * own reads ask Etherna too. Whitelisted before returning: an unwhitelisted chunk reads
 * as absent to a buyer's map. Refused over the read cap, so nothing is stored that a
 * reader would later refuse.
 */
export async function storeSeatPlan(plan: SeatPlan, selection: BatchSelection, parent: string): Promise<StoredSeatPlan> {
  const canonical = canonicalSeatPlan(plan);
  const bytes = encodeSeatPlan(canonical);
  if (bytes.length > MAX_SEAT_PLAN_BYTES) throw new SeatPlanTooLargeError(bytes.length);
  const digest = seatPlanDigest(bytes);
  // With the Etherna failover (#912): `parent` is whose batch it moves back to.
  const ref = (await uploadToBytes(bytes, selection, { failover: { parent } })).toLowerCase().replace(/^0x/, "");
  await whitelistHashes([ref]);
  remember(digest, canonical);
  return { ref, digest, seats: canonical.seats.length };
}

// Immutable by digest, so a hit never goes stale. Bounded: a big plan is megabytes.
const MEMO_MAX = 32;
const memo = new Map<string, SeatPlan>();

function remember(digest: string, plan: SeatPlan): void {
  memo.delete(digest);
  memo.set(digest, plan);
  while (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value as string);
}

/** A plan already read and checked against `digest` in this process, or null. */
export function cachedSeatPlan(digest: string): SeatPlan | null {
  return memo.get(digest.toLowerCase()) ?? null;
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
