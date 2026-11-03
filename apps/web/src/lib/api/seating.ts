/**
 * Allocated seating API (docs/SEATING.md). The plan is stored by our server, but its
 * identity is ours: the digest is computed here from the exact bytes, and an answer
 * naming any other digest or seat count is refused before anything is signed.
 */

import { encodeSeatPlan, seatPlanDigest, type SeatPlan } from "@woco/shared/seating/plan";
import type { SeatPlanTemplate } from "@woco/shared/seating/template";
import { authPost } from "./client.js";
import { refusalText } from "./errors.js";

/** Store a frozen plan before publishing; returns what the series' manifest names. */
export async function uploadSeatPlan(plan: SeatPlan, gatewayUrl?: string): Promise<SeatPlanTemplate> {
  const digest = seatPlanDigest(encodeSeatPlan(plan));
  const resp = (await authPost<unknown>("/api/seating/plans", { plan, ...(gatewayUrl ? { gatewayUrl } : {}) })) as {
    ok: boolean;
    error?: string;
    data?: { ref?: unknown; digest?: unknown; seats?: unknown };
  };
  if (!resp.ok || !resp.data) throw new Error(refusalText(resp, "please try again"));
  const { ref, digest: got, seats } = resp.data;
  if (got !== digest || seats !== plan.seats.length || typeof ref !== "string" || !/^[0-9a-f]{64}$/.test(ref)) {
    throw new Error("The server stored a different seating plan from yours - not publishing it.");
  }
  return { ref, digest, seats: plan.seats.length };
}
