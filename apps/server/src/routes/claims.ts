import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { getEvent } from "../lib/event/service.js";
import { resolveSiteEventSigner } from "../lib/site/service.js";
import { getOnChainEvent, getActiveChainId } from "../lib/chain/event-contract.js";
import { heldFor } from "../lib/event/reservation-store.js";

// The v1 claim rail lived here: POST /claim allocated an edition by scanning
// the Swarm editions feed and writing the claims feed. Deleted 2026-08-08 —
// f951652 had already retired the editions feed, so the route could not mint
// for anything created since. The WoCoEventV2 contract is the only ticket
// ledger; purchases go through Stripe checkout → webhook → batchClaimFor.
// Consequence, accepted: there is no free-ticket path until a v2 mint path
// exists (freeEventsAllowed is false, so nothing live changes).

const claims = new Hono<AppEnv>();

// GET /api/events/:eventId/series/:seriesId/claim-status - check availability
claims.get("/:eventId/series/:seriesId/claim-status", async (c) => {
  const eventId = c.req.param("eventId");
  const seriesId = c.req.param("seriesId");
  // Site carrier — lets a client-signed, not-WoCo-listed event resolve so the
  // UI can read its availability. siteId is only a pointer; trust comes from
  // the server-written site index, never from this request value.
  const siteId = c.req.query("siteId");

  try {
    const siteSigner = siteId ? await resolveSiteEventSigner(siteId, eventId) : null;
    const event = await getEvent(eventId, siteSigner ?? undefined).catch(() => null);
    if (!event) return c.json({ ok: false, error: "Event not found" }, 404);
    const series = event.series.find((s) => s.seriesId === seriesId);
    if (!series) return c.json({ ok: false, error: "Series not found" }, 404);
    if (!series.onChainEventId) {
      // Registration never completed — nothing can be minted, so there is no
      // availability to report. Same refusal create-checkout gives.
      return c.json({ ok: false, error: "Tickets for this event are not currently on sale" }, 409);
    }

    const chainId = getActiveChainId();
    const onChainData = await getOnChainEvent(series.onChainEventId, chainId);
    const totalSupply = onChainData ? Number(onChainData.totalSupply) : series.totalSupply;
    const claimed = onChainData ? Number(onChainData.nextSlot) : 0;
    const physicalAvailable = Math.max(0, totalSupply - claimed);
    const held = heldFor(eventId, seriesId);
    return c.json({
      ok: true,
      data: {
        seriesId,
        totalSupply,
        claimed,
        // available is physical remaining. /reserve subtracts held seats
        // atomically when allocating a checkout hold.
        available: physicalAvailable,
        held,
      },
    });
  } catch (err) {
    console.error("[api] claim-status error:", err);
    const message = err instanceof Error ? err.message : "Failed to get claim status";
    return c.json({ ok: false, error: message }, 500);
  }
});

export { claims };
