/**
 * Is this series seated, and is everything it says about seating consistent?
 * Decided by the series' MANIFEST (`editionTemplate.seatPlan`), which the organiser's
 * issuing key signed and the ledger's `manifestRef` commits - never by the feed.
 * Create and registration both ask, so a series cannot be created one way and
 * registered the other.
 */

import { FEATURES, type ManifestV2Body, type PaymentConfig } from "@woco/shared";
import {
  seatPlanTemplateOf,
  seriesSeatingRefusal,
  type SeatPlan,
  type SeatPlanTemplate,
} from "@woco/shared/seating/index";
import { loadSeatPlan, SeatPlanUnavailableError } from "./plan-store.js";

export type SeatedSeriesVerdict =
  | { kind: "general" }
  | { kind: "seated"; plan: SeatPlan; template: SeatPlanTemplate }
  | { kind: "refused"; status: 400 | 503; error: string };

export interface SeatedSeriesDeps {
  loadSeatPlan: typeof loadSeatPlan;
  /** Defaults to `FEATURES.seatedEventsAllowed`, read at call time. */
  seatedAllowed?: boolean;
}

const defaultDeps: SeatedSeriesDeps = { loadSeatPlan };

const refused = (status: 400 | 503, error: string): SeatedSeriesVerdict => ({ kind: "refused", status, error });

export async function checkSeatedSeries(
  s: {
    totalSupply: number;
    manifestBody: Pick<ManifestV2Body, "totalSupply" | "editionTemplate">;
    seating?: unknown;
    payment?: PaymentConfig;
  },
  deps: SeatedSeriesDeps = defaultDeps,
): Promise<SeatedSeriesVerdict> {
  const t = seatPlanTemplateOf(s.manifestBody);
  if (t === "invalid") return refused(400, "These tickets name a seating plan incorrectly");
  if (t === null) {
    return s.seating === undefined ? { kind: "general" } : refused(400, "Seat prices were sent without a seating plan");
  }
  if (!(deps.seatedAllowed ?? FEATURES.seatedEventsAllowed)) return refused(400, "Allocated seating is not available yet");
  if (t.seats !== s.totalSupply) return refused(400, "The number of tickets must be the number of seats on the plan");
  if (!s.payment?.stripeEnabled) return refused(400, "Seats sell by card: turn card payments on");

  let plan: SeatPlan | null;
  try {
    plan = await deps.loadSeatPlan(t.ref, t.digest);
  } catch (err) {
    if (err instanceof SeatPlanUnavailableError) return refused(503, "The seating plan could not be read. Try again in a moment.");
    throw err;
  }
  if (!plan) return refused(400, "The seating plan does not match the one these tickets name");
  // parseSeatPlan has checked the plan whole; the template's count is the manifest's supply.
  if (plan.seats.length !== t.seats) return refused(400, "The seating plan's seat count does not match these tickets");
  const priceProblem = seriesSeatingRefusal(s.seating, plan, s.payment);
  if (priceProblem) return refused(400, `Seat prices: ${priceProblem}`);
  return { kind: "seated", plan, template: t };
}
