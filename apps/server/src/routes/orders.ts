import { Hono } from "hono";
import type { ClaimersFeed, OrderEntry, SealedBox } from "@woco/shared";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { getEvent } from "../lib/event/service.js";
import { readFeedPage, decodeJsonFeed } from "../lib/swarm/feeds.js";
import { downloadFromBytes } from "../lib/swarm/bytes.js";
import { topicClaimers } from "../lib/swarm/topics.js";

const orders = new Hono<AppEnv>();

// GET /api/events/:id/orders — authenticated, organizer-only
orders.get("/:id/orders", requireAuth, async (c) => {
  const eventId = c.req.param("id");
  const parentAddress = c.get("parentAddress");

  try {
    // 1. Load event and verify ownership
    const event = await getEvent(eventId);
    if (!event) {
      return c.json({ ok: false, error: "Event not found" }, 404);
    }

    if (event.creatorAddress.toLowerCase() !== parentAddress.toLowerCase()) {
      return c.json({ ok: false, error: "Only the event organizer can view orders" }, 403);
    }

    // 2. Collect encrypted orders from claimers feeds
    const orderEntries: OrderEntry[] = [];

    for (const series of event.series) {
      const page = await readFeedPage(topicClaimers(series.seriesId));
      if (!page) continue;

      const feed = decodeJsonFeed<ClaimersFeed>(page);
      if (!feed?.claimers) continue;

      for (const claimer of feed.claimers) {
        if (!claimer.orderRef) continue;

        try {
          const json = await downloadFromBytes(claimer.orderRef);
          const sealedBox = JSON.parse(json) as SealedBox;

          orderEntries.push({
            seriesId: series.seriesId,
            seriesName: series.name,
            edition: claimer.edition,
            claimerAddress: claimer.claimerAddress,
            claimedAt: claimer.claimedAt,
            encryptedOrder: sealedBox,
          });
        } catch (err) {
          console.error(`[orders] Failed to download order ref ${claimer.orderRef}:`, err);
        }
      }
    }

    return c.json({
      ok: true,
      data: {
        eventId,
        eventTitle: event.title,
        orders: orderEntries,
      },
    });
  } catch (err) {
    console.error("[api] getOrders error:", err);
    const message = err instanceof Error ? err.message : "Failed to get orders";
    return c.json({ ok: false, error: message }, 500);
  }
});

export { orders };
