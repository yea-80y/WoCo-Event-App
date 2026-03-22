import { Hono } from "hono";
import { streamText } from "hono/streaming";
import type { Hex0x, CreateEventRequest, EventDirectoryEntry } from "@woco/shared";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { createEvent, getEvent, listEvents, getCreatorEvents, addEventToDirectory, removeEventFromDirectory } from "../lib/event/service.js";
const events = new Hono<AppEnv>();

// GET /api/events - public listing (served from in-memory cache, backed by Swarm directory)
events.get("/", async (c) => {
  try {
    const swarmEntries = await listEvents();
    return c.json({ ok: true, data: swarmEntries });
  } catch (err) {
    console.error("[api] listEvents error:", err);
    return c.json({ ok: false, error: "Failed to list events" }, 500);
  }
});

// GET /api/events/mine — authenticated, returns caller's events from creator index
// Also merges in any global-directory events not yet in the creator index (old events
// predating the per-creator index). Unlisted events still appear because the creator
// index is never trimmed by the unlist operation — only the global directory is.
// Must be registered BEFORE /:id to prevent "mine" being treated as an eventId.
events.get("/mine", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  try {
    const [creatorEntries, allEntries] = await Promise.all([
      getCreatorEvents(parentAddress),
      listEvents(),
    ]);

    // Merge: creator index is the primary source (never affected by unlist).
    // Global directory fills in old events that predate the creator index.
    const seen = new Set(creatorEntries.map((e) => e.eventId));
    const merged = [...creatorEntries];
    for (const e of allEntries) {
      if (e.creatorAddress.toLowerCase() === parentAddress && !seen.has(e.eventId)) {
        merged.push(e);
      }
    }

    return c.json({ ok: true, data: merged });
  } catch (err) {
    console.error("[api] getCreatorEvents error:", err);
    return c.json({ ok: false, error: "Failed to list events" }, 500);
  }
});

// GET /api/events/:id - public detail
events.get("/:id", async (c) => {
  const eventId = c.req.param("id");
  try {
    const event = await getEvent(eventId);
    if (!event) return c.json({ ok: false, error: "Event not found" }, 404);
    return c.json({ ok: true, data: event });
  } catch (err) {
    console.error("[api] getEvent error:", err);
    return c.json({ ok: false, error: "Failed to get event" }, 500);
  }
});

// POST /api/events - authenticated, creates event + tickets on Swarm
// Streams NDJSON progress events, final line is the result
events.post("/", requireAuth, async (c) => {
  const body = c.get("body") as unknown as CreateEventRequest & {
    session: string;
    delegation: unknown;
  };

  const parentAddress = c.get("parentAddress") as string;

  // Validate required fields
  const { event: ev, series, signedTickets, image, creatorPodKey, encryptionKey, orderFields, claimMode, skipAutoList } = body;
  if (!ev?.title || !ev?.startDate || !ev?.endDate) {
    return c.json({ ok: false, error: "Missing event title or dates" }, 400);
  }
  if (!series?.length) {
    return c.json({ ok: false, error: "At least one ticket series required" }, 400);
  }
  if (!signedTickets || !creatorPodKey) {
    return c.json({ ok: false, error: "Missing signed tickets or creator key" }, 400);
  }
  if (!image) {
    return c.json({ ok: false, error: "Missing event image" }, 400);
  }

  // Decode base64 image
  let imageData: Uint8Array;
  try {
    const raw = image.includes(",") ? image.split(",")[1] : image;
    imageData = Uint8Array.from(atob(raw), (ch) => ch.charCodeAt(0));
  } catch {
    return c.json({ ok: false, error: "Invalid image data" }, 400);
  }

  // Flatten signedTickets to serialized strings
  const serializedTickets: Record<string, string[]> = {};
  for (const [seriesId, tickets] of Object.entries(signedTickets)) {
    serializedTickets[seriesId] = tickets.map((t) => JSON.stringify(t));
  }

  const eventId = crypto.randomUUID();

  return streamText(c, async (stream) => {
    try {
      const result = await createEvent({
        eventId,
        title: ev.title,
        description: ev.description || "",
        startDate: ev.startDate,
        endDate: ev.endDate,
        location: ev.location || "",
        creatorAddress: parentAddress.toLowerCase() as Hex0x,
        creatorPodKey,
        imageData,
        series: series.map((s) => ({
          seriesId: s.seriesId,
          name: s.name,
          description: s.description || "",
          totalSupply: s.totalSupply,
          approvalRequired: !!(s as { approvalRequired?: boolean }).approvalRequired,
          ...((s as { wave?: string }).wave ? { wave: (s as { wave?: string }).wave } : {}),
          ...((s as { saleStart?: string }).saleStart ? { saleStart: (s as { saleStart?: string }).saleStart } : {}),
          ...((s as { saleEnd?: string }).saleEnd ? { saleEnd: (s as { saleEnd?: string }).saleEnd } : {}),
          ...((s as { paymentRedirectUrl?: string }).paymentRedirectUrl ? { paymentRedirectUrl: (s as { paymentRedirectUrl?: string }).paymentRedirectUrl } : {}),
        })),
        signedTickets: serializedTickets,
        encryptionKey: encryptionKey as string | undefined,
        orderFields: orderFields as import("@woco/shared").OrderField[] | undefined,
        claimMode: claimMode as import("@woco/shared").ClaimMode | undefined,
        skipAutoList: !!(skipAutoList as boolean | undefined),
        onProgress: (p) => {
          stream.writeln(JSON.stringify(p));
        },
      });

      stream.writeln(JSON.stringify({
        type: "done",
        ok: true,
        data: { eventId: result.eventId },
      }));
    } catch (err) {
      console.error("[api] createEvent error:", err);
      const message = err instanceof Error ? err.message : "Failed to create event";
      stream.writeln(JSON.stringify({ type: "error", ok: false, error: message }));
    }
  });
});

// POST /api/events/discover — authenticated
// Fetches events from an external server, filters by caller address,
// cross-references WoCo directory to show listed/unlisted status.
// Does NOT add anything to the directory — that's an explicit action via /list.
events.post("/discover", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const body = c.get("body") as { sourceApiUrl?: string; session?: string; delegation?: unknown };

  const rawUrl = (body.sourceApiUrl ?? "").trim().replace(/\/$/, "");
  if (!rawUrl) return c.json({ ok: false, error: "sourceApiUrl is required" }, 400);

  const apiBase = rawUrl.startsWith("http") ? rawUrl : "https://" + rawUrl;

  // Try to fetch all creator events (including unlisted) by forwarding session auth.
  // Falls back to the public directory if the external server doesn't accept the delegation.
  let remoteEntries: import("@woco/shared").EventDirectoryEntry[];

  // authPost sends session/delegation in the JSON body, not headers.
  // For forwarding to the source server's GET /api/events/mine we need them as headers.
  const sessionAddress = body.session ?? "";
  const sessionDelegation = body.delegation
    ? Buffer.from(JSON.stringify(body.delegation)).toString("base64")
    : "";

  let usedMine = false;
  if (sessionAddress && sessionDelegation) {
    try {
      const resp = await fetch(`${apiBase}/api/events/mine`, {
        headers: {
          "X-Session-Address": sessionAddress,
          "X-Session-Delegation": sessionDelegation,
        },
        signal: AbortSignal.timeout(10000),
      });
      if (resp.ok) {
        const json = await resp.json() as { ok: boolean; data?: import("@woco/shared").EventDirectoryEntry[] };
        if (json.ok && json.data) {
          remoteEntries = json.data;
          usedMine = true;
        }
      }
    } catch { /* fall through to public directory */ }
  }

  if (!usedMine) {
    try {
      const resp = await fetch(`${apiBase}/api/events`, { signal: AbortSignal.timeout(15000) });
      if (!resp.ok) return c.json({ ok: false, error: `Source server returned HTTP ${resp.status}` }, 400);
      const json = await resp.json() as { ok: boolean; data?: import("@woco/shared").EventDirectoryEntry[]; error?: string };
      if (!json.ok) return c.json({ ok: false, error: json.error || "Failed to list events from source" }, 400);
      remoteEntries = json.data ?? [];
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      return c.json({ ok: false, error: `Could not reach source server: ${msg}` }, 400);
    }
  }

  // Filter to caller's events only (when using public directory fallback)
  const mine = usedMine
    ? remoteEntries!
    : remoteEntries!.filter((e) => e.creatorAddress.toLowerCase() === parentAddress);

  // Cross-reference WoCo directory for listed status
  const wocoEntries = await listEvents();
  const listedIds = new Set(wocoEntries.map((e) => e.eventId));

  const data = mine.map((e) => ({
    ...e,
    listed: listedIds.has(e.eventId),
    sourceApiUrl: apiBase,
  }));

  return c.json({ ok: true, data });
});

// POST /api/events/:id/list — authenticated
// Fetches the event from sourceApiUrl (or WoCo's own server), verifies creator,
// and adds to WoCo directory. No-op if already listed.
events.post("/:id/list", requireAuth, async (c) => {
  const eventId = c.req.param("id");
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const body = c.get("body") as { sourceApiUrl?: string };

  let eventFeed: import("@woco/shared").EventFeed | null = null;

  if (body.sourceApiUrl) {
    const apiBase = body.sourceApiUrl.trim().replace(/\/$/, "");
    try {
      const resp = await fetch(`${apiBase}/api/events/${eventId}`, { signal: AbortSignal.timeout(15000) });
      if (!resp.ok) return c.json({ ok: false, error: `Source server returned HTTP ${resp.status}` }, 400);
      const json = await resp.json() as { ok: boolean; data?: import("@woco/shared").EventFeed; error?: string };
      if (!json.ok || !json.data) return c.json({ ok: false, error: json.error || "Event not found on source server" }, 404);
      eventFeed = json.data;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      return c.json({ ok: false, error: `Could not reach source server: ${msg}` }, 400);
    }
  } else {
    eventFeed = await getEvent(eventId);
  }

  if (!eventFeed) return c.json({ ok: false, error: "Event not found" }, 404);
  if (eventFeed.creatorAddress.toLowerCase() !== parentAddress) {
    return c.json({ ok: false, error: "You are not the creator of this event" }, 403);
  }

  try {
    await addEventToDirectory({
      eventId: eventFeed.eventId,
      title: eventFeed.title,
      imageHash: eventFeed.imageHash,
      startDate: eventFeed.startDate,
      location: eventFeed.location || "",
      creatorAddress: eventFeed.creatorAddress,
      seriesCount: eventFeed.series.length,
      totalTickets: eventFeed.series.reduce((sum, s) => sum + s.totalSupply, 0),
      createdAt: eventFeed.createdAt,
      ...(body.sourceApiUrl ? { apiUrl: body.sourceApiUrl.trim().replace(/\/$/, "") } : {}),
    });

  } catch (err) {
    console.error("[api] list event error:", err);
    return c.json({ ok: false, error: "Failed to add event to directory" }, 500);
  }

  return c.json({ ok: true, eventId });
});

// POST /api/events/:id/unlist — authenticated
// Removes the event from WoCo directory. Verifies the caller is the creator
// by checking the WoCo directory entry or fetching from sourceApiUrl.
events.post("/:id/unlist", requireAuth, async (c) => {
  const eventId = c.req.param("id");
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const body = c.get("body") as { sourceApiUrl?: string };

  // Verify creator — check directory first, then optional sourceApiUrl
  const wocoEntries = await listEvents();
  const dirEntry = wocoEntries.find((e) => e.eventId === eventId);

  if (dirEntry) {
    if (dirEntry.creatorAddress.toLowerCase() !== parentAddress) {
      return c.json({ ok: false, error: "You are not the creator of this event" }, 403);
    }
  } else if (body.sourceApiUrl) {
    // Event may not be in directory yet — verify via source
    const apiBase = body.sourceApiUrl.trim().replace(/\/$/, "");
    try {
      const resp = await fetch(`${apiBase}/api/events/${eventId}`, { signal: AbortSignal.timeout(15000) });
      const json = await resp.json() as { ok: boolean; data?: import("@woco/shared").EventFeed };
      if (!json.ok || !json.data) return c.json({ ok: false, error: "Event not found" }, 404);
      if (json.data.creatorAddress.toLowerCase() !== parentAddress) {
        return c.json({ ok: false, error: "You are not the creator of this event" }, 403);
      }
    } catch {
      return c.json({ ok: false, error: "Could not verify event creator" }, 400);
    }
  } else {
    // Event not in directory and no source to check — nothing to unlist
    return c.json({ ok: true, eventId, message: "Event was not listed" });
  }

  try {
    await removeEventFromDirectory(eventId);

  } catch (err) {
    console.error("[api] unlist event error:", err);
    return c.json({ ok: false, error: "Failed to remove event from directory" }, 500);
  }

  return c.json({ ok: true, eventId });
});

export { events };
