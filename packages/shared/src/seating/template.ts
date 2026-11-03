/**
 * How a seated series' manifest names its seating plan. The manifest body is
 * signed by the organiser's issuing key and its digest is the ledger's
 * `manifestRef`, so these three values are committed on chain with it:
 *
 *   editionTemplate: { seatPlan: { ref, digest, seats } }
 *
 * `ref` is the plan blob's Swarm reference (where to fetch it), `digest` the
 * keccak256 of its exact bytes (what every reader checks after fetching, since
 * checking a Swarm ref needs the chunk tree), `seats` the plan's seat count, which
 * must equal the manifest's `totalSupply` and the registered supply.
 */

import type { ManifestV2Body } from "../edition/types.js";
import { hasExactKeys, isIntIn, isPlainRecord } from "../validate.js";
import { MAX_PLAN_SEATS } from "./layout.js";

export interface SeatPlanTemplate {
  /** Swarm reference, 64 lowercase hex, no 0x. */
  ref: string;
  /** `seatPlanDigest` of the blob: 0x + 64 lowercase hex. */
  digest: string;
  seats: number;
}

const REF_RE = /^[0-9a-f]{64}$/;
const DIGEST_RE = /^0x[0-9a-f]{64}$/;

function validTemplate(v: unknown): v is SeatPlanTemplate {
  return (
    isPlainRecord(v) &&
    hasExactKeys(v, ["ref", "digest", "seats"]) &&
    typeof v.ref === "string" && REF_RE.test(v.ref) &&
    typeof v.digest === "string" && DIGEST_RE.test(v.digest) &&
    isIntIn(v.seats, 1, MAX_PLAN_SEATS)
  );
}

/** The `editionTemplate` of a seated series' manifest. */
export function seatPlanEditionTemplate(t: SeatPlanTemplate): Record<string, unknown> {
  if (!validTemplate(t)) throw new Error("invalid seat plan template");
  return { seatPlan: { ref: t.ref, digest: t.digest, seats: t.seats } };
}

/**
 * What a manifest says about seating: null = not seated (no `seatPlan` in its
 * template), "invalid" = it names a plan, but not as exactly
 * `{ seatPlan: { ref, digest, seats } }` with `seats === totalSupply`. A reader
 * treats "invalid" as unsellable, never as general admission.
 */
export function seatPlanTemplateOf(body: Pick<ManifestV2Body, "totalSupply" | "editionTemplate">): SeatPlanTemplate | null | "invalid" {
  const t = body.editionTemplate;
  if (t === undefined || !("seatPlan" in t)) return null;
  if (!hasExactKeys(t, ["seatPlan"]) || !validTemplate(t.seatPlan)) return "invalid";
  if (t.seatPlan.seats !== body.totalSupply) return "invalid";
  return { ref: t.seatPlan.ref, digest: t.seatPlan.digest, seats: t.seatPlan.seats };
}
