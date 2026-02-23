import { Hono } from "hono";
import type { SealedBox } from "@woco/shared";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { getEvent } from "../lib/event/service.js";
import { getPendingClaimsFeed, approvePendingClaim, rejectPendingClaim } from "../lib/event/claim-service.js";
import { downloadFromBytes } from "../lib/swarm/bytes.js";

const approvals = new Hono<AppEnv>();

// Per-series queue — reuse the same pattern as claims.ts to serialise approve/reject ops
const approvalQueues = new Map<string, Promise<void>>();

function queueSeriesApproval<T>(seriesId: string, fn: () => Promise<T>): Promise<T> {
  const prev = (approvalQueues.get(seriesId) ?? Promise.resolve()) as Promise<void>;
  const current = prev.then(() => fn());
  approvalQueues.set(seriesId, current.then(() => {}, () => {}));
  return current;
}

// ---------------------------------------------------------------------------
// GET /api/events/:eventId/pending-claims
// Returns all pending claim entries across all series (organizer only)
// ---------------------------------------------------------------------------

approvals.get("/:eventId/pending-claims", requireAuth, async (c) => {
  const eventId = c.req.param("eventId");
  const parentAddress = c.get("parentAddress");

  try {
    const event = await getEvent(eventId);
    if (!event) return c.json({ ok: false, error: "Event not found" }, 404);

    if (event.creatorAddress.toLowerCase() !== parentAddress.toLowerCase()) {
      return c.json({ ok: false, error: "Only the event organizer can view pending claims" }, 403);
    }

    const result: Array<{
      pendingId: string;
      seriesId: string;
      seriesName: string;
      claimerKey: string;
      requestedAt: string;
      encryptedOrder?: SealedBox;
    }> = [];

    for (const series of event.series) {
      const feed = await getPendingClaimsFeed(series.seriesId);
      if (!feed?.pending.length) continue;

      // Only return pending entries (not already decided)
      const pendingEntries = feed.pending.filter((e) => e.status === "pending");

      for (const entry of pendingEntries) {
        let encryptedOrder: SealedBox | undefined;
        if (entry.orderRef) {
          try {
            const json = await downloadFromBytes(entry.orderRef);
            encryptedOrder = JSON.parse(json) as SealedBox;
          } catch (err) {
            console.error(`[approvals] Failed to download order ref ${entry.orderRef}:`, err);
          }
        }

        result.push({
          pendingId: entry.pendingId,
          seriesId: series.seriesId,
          seriesName: series.name,
          claimerKey: entry.claimerKey,
          requestedAt: entry.requestedAt,
          ...(encryptedOrder ? { encryptedOrder } : {}),
        });
      }
    }

    return c.json({ ok: true, data: { eventId, pendingClaims: result } });
  } catch (err) {
    console.error("[api] getPendingClaims error:", err);
    const message = err instanceof Error ? err.message : "Failed to get pending claims";
    return c.json({ ok: false, error: message }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /api/events/:eventId/series/:seriesId/pending-claims/:pendingId/approve
// ---------------------------------------------------------------------------

approvals.post("/:eventId/series/:seriesId/pending-claims/:pendingId/approve", requireAuth, async (c) => {
  const eventId = c.req.param("eventId");
  const seriesId = c.req.param("seriesId");
  const pendingId = c.req.param("pendingId");
  const parentAddress = c.get("parentAddress");

  try {
    const event = await getEvent(eventId);
    if (!event) return c.json({ ok: false, error: "Event not found" }, 404);

    if (event.creatorAddress.toLowerCase() !== parentAddress.toLowerCase()) {
      return c.json({ ok: false, error: "Only the event organizer can approve claims" }, 403);
    }

    await queueSeriesApproval(seriesId, () => approvePendingClaim(seriesId, pendingId));
    return c.json({ ok: true });
  } catch (err) {
    console.error("[api] approvePendingClaim error:", err);
    const message = err instanceof Error ? err.message : "Failed to approve claim";
    const status = message === "Pending claim not found" ? 404 : 500;
    return c.json({ ok: false, error: message }, status);
  }
});

// ---------------------------------------------------------------------------
// POST /api/events/:eventId/series/:seriesId/pending-claims/:pendingId/reject
// Body: { reason?: string }
// ---------------------------------------------------------------------------

approvals.post("/:eventId/series/:seriesId/pending-claims/:pendingId/reject", requireAuth, async (c) => {
  const eventId = c.req.param("eventId");
  const seriesId = c.req.param("seriesId");
  const pendingId = c.req.param("pendingId");
  const parentAddress = c.get("parentAddress");
  const body = c.get("body") as Record<string, unknown>;
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : undefined;

  try {
    const event = await getEvent(eventId);
    if (!event) return c.json({ ok: false, error: "Event not found" }, 404);

    if (event.creatorAddress.toLowerCase() !== parentAddress.toLowerCase()) {
      return c.json({ ok: false, error: "Only the event organizer can reject claims" }, 403);
    }

    await queueSeriesApproval(seriesId, () => rejectPendingClaim(seriesId, pendingId, reason));
    return c.json({ ok: true });
  } catch (err) {
    console.error("[api] rejectPendingClaim error:", err);
    const message = err instanceof Error ? err.message : "Failed to reject claim";
    const status = message === "Pending claim not found" ? 404 : 500;
    return c.json({ ok: false, error: message }, status);
  }
});

export { approvals };
