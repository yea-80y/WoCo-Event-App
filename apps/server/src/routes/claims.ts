import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { cancellationGate } from "../lib/event/cancellations.js";
import { getEvent } from "../lib/event/service.js";
import { resolveSiteEventSigner } from "../lib/site/service.js";
import { getOnChainEventAt } from "../lib/chain/event-contract.js";
import { registrationContractFor } from "../lib/event/onchain-registry.js";
import { heldFor } from "../lib/event/reservation-store.js";
import { eventKeys } from "../lib/keyring/event-keys.js";
import { organiserNoticeRead } from "../lib/legal/notice-gate.js";
import { noticeMarketingMode, type MarketingMode } from "@woco/shared";

// The v1 claim rail lived here: POST /claim allocated an edition by scanning
// the Swarm editions feed and writing the claims feed. Deleted 2026-08-08 —
// f951652 had already retired the editions feed, so the route could not mint
// for anything created since. The WoCoEventV2 contract is the only ticket
// ledger; purchases go through Stripe checkout → webhook → batchClaimFor.
// Consequence, accepted: there is no free-ticket path until a v2 mint path
// exists (freeEventsAllowed is false, so nothing live changes).

const claims = new Hono<AppEnv>();

/**
 * The marketing control this event's checkout shows (2026-10-14): the mode the
 * organiser's CONFIRMED notice sets, read under the same keys and cache as the
 * sale gate. Omitted when there is no confirmed notice to read - nothing sells
 * then - and never fails the availability answer. create-checkout re-checks it.
 */
async function marketingFor(eventId: string): Promise<{ marketingMode: MarketingMode; marketingOrganiser: string } | null> {
  try {
    const keys = await eventKeys(eventId);
    if (keys.kind !== "ring" && keys.kind !== "record") return null;
    const r = await organiserNoticeRead(keys.creator, keys.feedSigner);
    if (r.status !== "found") return null;
    return { marketingMode: noticeMarketingMode(r.notice), marketingOrganiser: r.notice.organiserName };
  } catch {
    return null;
  }
}

// GET /api/events/:eventId/series/:seriesId/claim-status - check availability
claims.get("/:eventId/series/:seriesId/claim-status", async (c) => {
  const eventId = c.req.param("eventId");
  const seriesId = c.req.param("seriesId");
  // Site carrier — lets a client-signed, not-WoCo-listed event resolve so the
  // UI can read its availability. siteId is only a pointer; trust comes from
  // the server-written site index, never from this request value.
  const siteId = c.req.query("siteId");
  // Beside the event and chain reads, so a cold notice read costs no extra round trip.
  const marketing = marketingFor(eventId);

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

    // On the contract the registration lives on (#563), not today's env contract.
    const contract = registrationContractFor(eventId, seriesId);
    const onChainData = contract ? await getOnChainEventAt(contract, series.onChainEventId) : null;
    const totalSupply = onChainData ? Number(onChainData.totalSupply) : series.totalSupply;
    const claimed = onChainData ? Number(onChainData.nextSlot) : 0;
    const physicalAvailable = Math.max(0, totalSupply - claimed);
    const held = heldFor(eventId, seriesId);
    // #644: a cancelled event reads as nothing available, so every buy button
    // already published — including bundles baked into organiser sites before
    // this field existed — shows "sold out"; new ones read `cancelled`.
    const cancelled = cancellationGate(eventId) === "cancelled";
    return c.json({
      ok: true,
      data: {
        seriesId,
        totalSupply,
        claimed,
        // available is physical remaining. /reserve subtracts held seats
        // atomically when allocating a checkout hold.
        available: cancelled ? 0 : physicalAvailable,
        held,
        ...(cancelled ? { cancelled: true } : {}),
        ...((await marketing) ?? {}),
      },
    });
  } catch (err) {
    console.error("[api] claim-status error:", err);
    const message = err instanceof Error ? err.message : "Failed to get claim status";
    return c.json({ ok: false, error: message }, 500);
  }
});

export { claims };
