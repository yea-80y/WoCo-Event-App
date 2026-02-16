import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { getUserCollection, getClaimedTicketDetail } from "../lib/event/claim-service.js";

const collection = new Hono<AppEnv>();

// GET /api/collection/me — user's ticket collection (authenticated)
collection.get("/me", requireAuth, async (c) => {
  const address = c.get("parentAddress").toLowerCase();

  try {
    const coll = await getUserCollection(address);
    return c.json({ ok: true, data: coll ?? { v: 1, entries: [], updatedAt: "" } });
  } catch (err) {
    console.error("[api] getUserCollection error:", err);
    const message = err instanceof Error ? err.message : "Failed to get collection";
    return c.json({ ok: false, error: message }, 500);
  }
});

// GET /api/collection/me/ticket/:ref — full claimed ticket detail (authenticated)
collection.get("/me/ticket/:ref", requireAuth, async (c) => {
  const ref = c.req.param("ref");

  try {
    const ticket = await getClaimedTicketDetail(ref);
    if (!ticket) {
      return c.json({ ok: false, error: "Ticket not found" }, 404);
    }
    return c.json({ ok: true, data: ticket });
  } catch (err) {
    console.error("[api] getClaimedTicketDetail error:", err);
    const message = err instanceof Error ? err.message : "Failed to get ticket detail";
    return c.json({ ok: false, error: message }, 500);
  }
});

export { collection };
