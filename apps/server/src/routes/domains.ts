import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { getEvent } from "../lib/event/service.js";
import {
  registerDomain,
  verifyDomain,
  getDomainsForEvent,
  getDomainsForOwner,
  removeDomain,
  resolveDomain,
  CNAME_TARGET,
} from "../lib/domains/service.js";

const domains = new Hono<AppEnv>();

/**
 * POST /api/domains — register a custom domain for an event site
 * Body: { hostname, eventId, feedManifestHash, contentHash }
 * Auth: must be event creator
 */
domains.post("/", requireAuth, async (c) => {
  const parentAddress = c.get("parentAddress");
  const body = c.get("body") as Record<string, unknown>;

  try {
    const hostname = body.hostname as string;
    const eventId = body.eventId as string;
    const feedManifestHash = body.feedManifestHash as string;
    const contentHash = body.contentHash as string;

    if (!hostname || !eventId || !contentHash) {
      return c.json({ ok: false, error: "hostname, eventId, and contentHash are required" }, 400);
    }

    // Validate hostname format (no protocol, no path, no port)
    const hostnameRegex = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
    if (!hostnameRegex.test(hostname.toLowerCase())) {
      return c.json({ ok: false, error: "Invalid hostname format" }, 400);
    }

    // Block registering woco-net.com subdomains or common domains
    const blocked = ["woco-net.com", "woco.eth.limo", "localhost"];
    if (blocked.some((b) => hostname.toLowerCase() === b || hostname.toLowerCase().endsWith(`.${b}`))) {
      return c.json({ ok: false, error: "Cannot register this hostname" }, 400);
    }

    // Verify event exists and caller is the creator
    const event = await getEvent(eventId);
    if (!event) {
      return c.json({ ok: false, error: "Event not found" }, 404);
    }
    if (event.creatorAddress.toLowerCase() !== parentAddress.toLowerCase()) {
      return c.json({ ok: false, error: "Only the event organiser can register domains" }, 403);
    }

    const entry = await registerDomain(
      hostname,
      eventId,
      feedManifestHash || "",
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
 * Auth: must be the domain owner
 */
domains.post("/verify", requireAuth, async (c) => {
  const parentAddress = c.get("parentAddress");
  const body = c.get("body") as Record<string, unknown>;
  const hostname = body.hostname as string;

  if (!hostname) {
    return c.json({ ok: false, error: "hostname is required" }, 400);
  }

  const result = await verifyDomain(hostname);
  return c.json({ ok: true, data: result });
});

/**
 * GET /api/domains/mine — list all domains for the authenticated user
 */
domains.post("/mine", requireAuth, async (c) => {
  const parentAddress = c.get("parentAddress");
  const entries = await getDomainsForOwner(parentAddress);
  return c.json({ ok: true, data: entries });
});

/**
 * GET /api/domains/event/:eventId — list domains for a specific event
 * Public endpoint (no auth) so the Worker can look up domains
 */
domains.get("/event/:eventId", async (c) => {
  const eventId = c.req.param("eventId");
  const entries = await getDomainsForEvent(eventId);
  return c.json({ ok: true, data: entries });
});

/**
 * GET /api/domains/resolve/:hostname — resolve domain to Swarm content hash
 * Public endpoint — used by the Cloudflare Worker edge proxy
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
 * DELETE /api/domains — remove a custom domain
 * Body: { hostname }
 * Auth: must be the domain owner
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
