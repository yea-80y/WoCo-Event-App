import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { getEvent } from "../lib/event/service.js";
import {
  registerDomain,
  verifyDomain,
  getDomainsForEvent,
  getDomainsForSite,
  getDomainsForOwner,
  removeDomain,
  resolveDomain,
  CNAME_TARGET,
} from "../lib/domains/service.js";

const domains = new Hono<AppEnv>();

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const BLOCKED = ["woco-net.com", "woco.eth.limo", "localhost"];

function validateHostname(hostname: string): string | null {
  const h = hostname.toLowerCase().trim();
  if (!HOSTNAME_RE.test(h)) return "Invalid hostname format";
  if (BLOCKED.some((b) => h === b || h.endsWith(`.${b}`))) return "Cannot register this hostname";
  return null;
}

/**
 * POST /api/domains — register a custom domain for an event site or multi-page site
 * Body: { hostname, contentHash, feedManifestHash, eventId? } | { hostname, contentHash, feedManifestHash, siteId? }
 * Auth required. For siteId path, ownership = authenticated address (no event lookup).
 */
domains.post("/", requireAuth, async (c) => {
  const parentAddress = c.get("parentAddress");
  const body = c.get("body") as Record<string, unknown>;

  try {
    const hostname = body.hostname as string;
    const contentHash = body.contentHash as string;
    const feedManifestHash = (body.feedManifestHash as string) ?? "";
    const eventId = body.eventId as string | undefined;
    const siteId = body.siteId as string | undefined;

    if (!hostname || !contentHash) {
      return c.json({ ok: false, error: "hostname and contentHash are required" }, 400);
    }
    if (!eventId && !siteId) {
      return c.json({ ok: false, error: "eventId or siteId is required" }, 400);
    }

    const hostnameErr = validateHostname(hostname);
    if (hostnameErr) return c.json({ ok: false, error: hostnameErr }, 400);

    let target: { eventId: string } | { siteId: string };

    if (siteId) {
      target = { siteId };
    } else {
      // Event path: verify event exists and caller is creator
      const event = await getEvent(eventId!);
      if (!event) return c.json({ ok: false, error: "Event not found" }, 404);
      if (event.creatorAddress.toLowerCase() !== parentAddress.toLowerCase()) {
        return c.json({ ok: false, error: "Only the event organiser can register domains" }, 403);
      }
      target = { eventId: eventId! };
    }

    const entry = await registerDomain(
      hostname,
      target,
      feedManifestHash,
      contentHash,
      parentAddress,
    );

    return c.json({
      ok: true,
      data: {
        ...entry,
        cnameTarget: CNAME_TARGET,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Registration failed";
    return c.json({ ok: false, error: msg }, 500);
  }
});

/**
 * POST /api/domains/verify — check DNS for a registered domain
 * Body: { hostname }
 */
domains.post("/verify", requireAuth, async (c) => {
  const body = c.get("body") as Record<string, unknown>;
  const hostname = body.hostname as string;

  if (!hostname) {
    return c.json({ ok: false, error: "hostname is required" }, 400);
  }

  const result = await verifyDomain(hostname);
  return c.json({ ok: true, data: result });
});

/**
 * POST /api/domains/mine — list all domains for the authenticated user
 */
domains.post("/mine", requireAuth, async (c) => {
  const parentAddress = c.get("parentAddress");
  const entries = await getDomainsForOwner(parentAddress);
  return c.json({ ok: true, data: entries });
});

/**
 * GET /api/domains/event/:eventId — list domains for a specific event (public)
 */
domains.get("/event/:eventId", async (c) => {
  const eventId = c.req.param("eventId");
  const entries = await getDomainsForEvent(eventId);
  return c.json({ ok: true, data: entries });
});

/**
 * GET /api/domains/site/:siteId — list domains for a specific site (public)
 */
domains.get("/site/:siteId", async (c) => {
  const siteId = c.req.param("siteId");
  const entries = await getDomainsForSite(siteId);
  return c.json({ ok: true, data: entries });
});

/**
 * GET /api/domains/resolve/:hostname — resolve domain to Swarm content hash
 * Public — used by the Cloudflare Worker edge proxy
 */
domains.get("/resolve/:hostname", async (c) => {
  const hostname = c.req.param("hostname");
  const result = await resolveDomain(hostname);
  if (!result) {
    return c.json({ ok: false, error: "Domain not found or not verified" }, 404);
  }
  return c.json({ ok: true, data: result });
});

/**
 * POST /api/domains/remove — remove a custom domain
 * Body: { hostname }
 */
domains.post("/remove", requireAuth, async (c) => {
  const parentAddress = c.get("parentAddress");
  const body = c.get("body") as Record<string, unknown>;
  const hostname = body.hostname as string;

  if (!hostname) {
    return c.json({ ok: false, error: "hostname is required" }, 400);
  }

  const removed = await removeDomain(hostname, parentAddress);
  if (!removed) {
    return c.json({ ok: false, error: "Domain not found or not owned by you" }, 404);
  }
  return c.json({ ok: true });
});

export { domains };
