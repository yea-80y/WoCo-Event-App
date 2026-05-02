import { Hono } from "hono";
import { Topic } from "@ethersphere/bee-js";
import { requireAuth } from "../middleware/auth.js";
import {
  readFeedPage,
  writeFeedPage,
  encodeJsonFeed,
  decodeJsonFeed,
} from "../lib/swarm/feeds.js";
import {
  siteConfigTopic,
  siteEventsIndexTopic,
  SITE_SCHEMA_VERSION,
} from "@woco/shared";
import type { Site, SiteEventsIndex, SiteEventEntry } from "@woco/shared";

const sitesRouter = new Hono();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readSiteConfig(siteId: string): Promise<Site | null> {
  const topic = Topic.fromString(siteConfigTopic(siteId));
  const page = await readFeedPage(topic);
  if (!page) return null;
  return decodeJsonFeed<Site>(page);
}

// ---------------------------------------------------------------------------
// POST /api/sites — publish site config + events index atomically
// Creates or updates. Server always stamps ownerAddress = authenticated address.
// ---------------------------------------------------------------------------

sitesRouter.post("/", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();

  try {
    const body = await c.req.json() as { site?: Site; events?: SiteEventEntry[] };
    if (!body?.site?.siteId) {
      return c.json({ ok: false, error: "Invalid site data" }, 400);
    }

    const { site, events = [] } = body;

    // If an existing site is published, only the owner may overwrite it.
    const existing = await readSiteConfig(site.siteId);
    if (existing && existing.ownerAddress.toLowerCase() !== parentAddress) {
      return c.json({ ok: false, error: "Not the site owner" }, 403);
    }

    const now = Date.now();
    const siteToWrite: Site = {
      ...site,
      ownerAddress: parentAddress,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    // Write both feeds concurrently
    const configTopic = Topic.fromString(siteConfigTopic(site.siteId));
    const eventsTopic = Topic.fromString(siteEventsIndexTopic(site.siteId));

    const eventsIndex: SiteEventsIndex = {
      siteId: site.siteId,
      schemaVersion: SITE_SCHEMA_VERSION,
      events,
      updatedAt: now,
    };

    await Promise.all([
      writeFeedPage(configTopic, encodeJsonFeed(siteToWrite)),
      writeFeedPage(eventsTopic, encodeJsonFeed(eventsIndex)),
    ]);

    return c.json({ ok: true, data: { siteId: site.siteId } });
  } catch (err) {
    console.error("[sites/publish]", err);
    return c.json({
      ok: false,
      error: err instanceof Error ? err.message : "Publish failed",
    }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /api/sites/:id — read site config (public)
// ---------------------------------------------------------------------------

sitesRouter.get("/:id", async (c) => {
  const siteId = c.req.param("id");
  try {
    const site = await readSiteConfig(siteId);
    if (!site) return c.json({ ok: false, error: "Site not found" }, 404);
    return c.json({ ok: true, data: site });
  } catch {
    return c.json({ ok: false, error: "Failed to read site" }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /api/sites/:id/events — read events index (public)
// ---------------------------------------------------------------------------

sitesRouter.get("/:id/events", async (c) => {
  const siteId = c.req.param("id");
  try {
    const topic = Topic.fromString(siteEventsIndexTopic(siteId));
    const page = await readFeedPage(topic);

    if (!page) {
      // Site exists but no events written yet — return empty index
      return c.json({
        ok: true,
        data: { siteId, events: [], updatedAt: 0, schemaVersion: SITE_SCHEMA_VERSION },
      });
    }

    const index = decodeJsonFeed<SiteEventsIndex>(page);
    if (!index) return c.json({ ok: false, error: "Corrupt events index" }, 500);
    return c.json({ ok: true, data: index });
  } catch {
    return c.json({ ok: false, error: "Failed to read events index" }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /api/sites/:id/events — add a single event to the index (auth)
// ---------------------------------------------------------------------------

sitesRouter.post("/:id/events", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const siteId = c.req.param("id");

  try {
    const site = await readSiteConfig(siteId);
    if (!site) return c.json({ ok: false, error: "Site not found" }, 404);
    if (site.ownerAddress.toLowerCase() !== parentAddress) {
      return c.json({ ok: false, error: "Not the site owner" }, 403);
    }

    const body = await c.req.json() as { eventId?: string; featured?: boolean };
    if (!body.eventId) return c.json({ ok: false, error: "eventId required" }, 400);

    const topic = Topic.fromString(siteEventsIndexTopic(siteId));
    const page = await readFeedPage(topic);
    const index: SiteEventsIndex = page
      ? (decodeJsonFeed<SiteEventsIndex>(page) ?? { siteId, schemaVersion: SITE_SCHEMA_VERSION, events: [], updatedAt: 0 })
      : { siteId, schemaVersion: SITE_SCHEMA_VERSION, events: [], updatedAt: 0 };

    if (!index.events.find((e) => e.eventId === body.eventId)) {
      index.events.push({
        eventId: body.eventId!,
        featured: body.featured ?? false,
        addedAt: Date.now(),
      });
    }
    index.updatedAt = Date.now();

    await writeFeedPage(topic, encodeJsonFeed(index));
    return c.json({ ok: true, data: index });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Failed to add event" }, 500);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/sites/:id/events/:eventId — remove event from index (auth)
// ---------------------------------------------------------------------------

sitesRouter.delete("/:id/events/:eventId", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const siteId = c.req.param("id");
  const eventId = c.req.param("eventId");

  try {
    const site = await readSiteConfig(siteId);
    if (!site) return c.json({ ok: false, error: "Site not found" }, 404);
    if (site.ownerAddress.toLowerCase() !== parentAddress) {
      return c.json({ ok: false, error: "Not the site owner" }, 403);
    }

    const topic = Topic.fromString(siteEventsIndexTopic(siteId));
    const page = await readFeedPage(topic);
    if (!page) return c.json({ ok: true });

    const index = decodeJsonFeed<SiteEventsIndex>(page);
    if (!index) return c.json({ ok: false, error: "Corrupt events index" }, 500);

    index.events = index.events.filter((e) => e.eventId !== eventId);
    index.updatedAt = Date.now();

    await writeFeedPage(topic, encodeJsonFeed(index));
    return c.json({ ok: true, data: index });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Failed to remove event" }, 500);
  }
});

export { sitesRouter };
