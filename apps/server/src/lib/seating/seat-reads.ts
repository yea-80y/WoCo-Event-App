/**
 * The two reads a seat hold needs (docs/SEATING.md "Selling a seat"):
 *  - the plan the series was REGISTERED with: located through the series manifest's
 *    `seatPlan.ref`, trusted only for the digest the registration pinned (decision 4),
 *    so a re-signed feed pointing elsewhere reads as "plan changed", never as a plan;
 *  - one Multicall3 batch of the ledger (`seatBatch`): the event's views, the seats'
 *    words and their nonces, all at one block.
 */

import { validateSignedManifestV2 } from "@woco/shared";
import { multicall } from "@woco/shared/chain/multicall";
import { seatBatch, type SeatBatchRead } from "@woco/shared/seating/chain";
import { seatPlanTemplateOf, type SeatPlan } from "@woco/shared/seating/index";
import { getChainRpcUrl, type EventContractTarget } from "../chain/event-contract.js";
import { downloadFromBytes } from "../swarm/bytes.js";
import { cachedSeatPlan, loadSeatPlan, SeatPlanUnavailableError } from "./plan-store.js";

export type PinnedPlan =
  | { ok: true; plan: SeatPlan }
  | { ok: false; status: 409 | 503; error: string };

export const PLAN_CHANGED = "This seating plan has changed. Reload the page to see the current one.";
const PLAN_UNREADABLE = "The seating plan could not be read. Try again in a moment.";

/** The manifest is read only when the plan is not already in memory (plan-store's memo). */
export async function pinnedSeatPlan(
  swarmManifestRef: string | undefined,
  planDigest: string,
  deps: { download: (ref: string) => Promise<string>; loadSeatPlan: typeof loadSeatPlan } = { download: downloadFromBytes, loadSeatPlan },
): Promise<PinnedPlan> {
  const digest = planDigest.toLowerCase();
  const hit = cachedSeatPlan(digest);
  if (hit) return { ok: true, plan: hit };
  if (!swarmManifestRef) return { ok: false, status: 409, error: PLAN_CHANGED };
  let raw: string;
  try {
    raw = await deps.download(swarmManifestRef);
  } catch {
    return { ok: false, status: 503, error: PLAN_UNREADABLE };
  }
  let blob: unknown;
  try {
    blob = JSON.parse(raw);
  } catch {
    return { ok: false, status: 409, error: PLAN_CHANGED };
  }
  const m = (blob as { signedManifest?: unknown } | null)?.signedManifest;
  if (!validateSignedManifestV2(m)) return { ok: false, status: 409, error: PLAN_CHANGED };
  const t = seatPlanTemplateOf(m.body);
  if (!t || t === "invalid" || t.digest.toLowerCase() !== digest) return { ok: false, status: 409, error: PLAN_CHANGED };
  try {
    const plan = await deps.loadSeatPlan(t.ref, digest);
    return plan ? { ok: true, plan } : { ok: false, status: 409, error: PLAN_CHANGED };
  } catch (err) {
    if (err instanceof SeatPlanUnavailableError) return { ok: false, status: 503, error: PLAN_UNREADABLE };
    throw err;
  }
}

/** One read of the ledger for these seats: event views, their words, their nonces. */
export async function readSeatChain(
  contract: Pick<EventContractTarget, "address" | "chainId">,
  onChainEventId: string,
  seats: readonly number[],
  doFetch: typeof fetch = fetch,
): Promise<SeatBatchRead> {
  const words = [...new Set(seats.map((k) => k >> 8))];
  const batch = seatBatch(contract.address, onChainEventId, { event: true, words, nonceSeats: seats });
  return batch.decode(await multicall(getChainRpcUrl(contract.chainId), batch.calls, batch.expect, doFetch));
}
