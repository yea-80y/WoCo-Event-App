/**
 * Allocated seating (docs/SEATING.md).
 *
 * POST /api/seating/plans  { plan, gatewayUrl? } -> { ref, digest, seats }
 *
 * Stores the plan an event is about to publish with. The organiser's browser froze
 * it (`woco.seatplan.v1`); the server checks it whole (including that its seat list
 * is what its items derive), stores the canonical bytes on the event's batch and
 * answers with what the series' manifest must name. The browser recomputes the
 * digest itself and refuses an answer that differs, so this route stores the plan
 * but cannot change it. Nothing about an event is decided here: create and
 * registration re-read the plan by the manifest's ref and digest.
 */

import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { FEATURES } from "@woco/shared";
import { MAX_SEAT_PLAN_BYTES, validateSeatPlan } from "@woco/shared/seating/index";
import { SlidingWindowLimiter } from "../lib/http/rate-limit.js";
import { jsonBodyLimit } from "../lib/http/body-limit.js";
import { batchForDeploy, PlatformBatchUnavailable } from "../lib/etherna/batch-router.js";
import { routeSave } from "../lib/etherna/failover.js";
import { refuseUnlessVerifiedOrganiser } from "../lib/stripe/verification.js";
import { SeatPlanTooLargeError, storeSeatPlan } from "../lib/seating/plan-store.js";

export const seatingRoutes = new Hono<AppEnv>();

/** A plan plus the JSON around it. */
const PLAN_BODY_MAX_BYTES = MAX_SEAT_PLAN_BYTES + 64 * 1024;

// Publishing stores one plan, a retry or an edit another: a few an hour is generous.
const PLAN_UPLOADS = new SlidingWindowLimiter([
  { limit: 10, windowMs: 60 * 60_000 },
  { limit: 40, windowMs: 24 * 60 * 60_000 },
]);

seatingRoutes.post("/plans", jsonBodyLimit(PLAN_BODY_MAX_BYTES), requireAuth, async (c) => {
  if (!FEATURES.seatedEventsAllowed) {
    return c.json({ ok: false, error: "Allocated seating is not available yet" }, 403);
  }
  const parent = (c.get("parentAddress") as string).toLowerCase();
  // Cheapest first: the per-account limit before a live Stripe check, both before
  // validating a plan of up to 12 MiB.
  if (!PLAN_UPLOADS.allow(parent)) {
    return c.json({ ok: false, error: "Too many seating plans saved in a short time. Try again later." }, 429);
  }
  // Storage on the platform's batch: the same organisers who may sell tickets.
  const refusal = await refuseUnlessVerifiedOrganiser(parent, "Connect and verify Stripe before publishing a seated event.");
  if (refusal) return c.json(refusal, 403);

  const body = c.get("body") as { plan?: unknown; gatewayUrl?: unknown } | undefined;
  if (!body || typeof body !== "object") return c.json({ ok: false, error: "Invalid body" }, 400);
  if (body.gatewayUrl !== undefined && typeof body.gatewayUrl !== "string") {
    return c.json({ ok: false, error: "Invalid gatewayUrl" }, 400);
  }
  if (!validateSeatPlan(body.plan)) {
    return c.json({ ok: false, error: "This seating plan is not valid" }, 400);
  }

  try {
    const gatewayUrl = typeof body.gatewayUrl === "string" ? body.gatewayUrl : "";
    const selection = routeSave(() => batchForDeploy({ ownerAddress: parent, gatewayUrl, deployType: "event" }));
    const stored = await storeSeatPlan(body.plan, selection, parent);
    return c.json({ ok: true, data: stored });
  } catch (err) {
    if (err instanceof SeatPlanTooLargeError) return c.json({ ok: false, error: "This seating plan is too large to store" }, 413);
    if (err instanceof PlatformBatchUnavailable) return c.json({ ok: false, error: err.message, code: err.code }, 503);
    console.error("[seating] plan store failed:", err);
    return c.json({ ok: false, error: "Could not save the seating plan. Try again." }, 502);
  }
});
