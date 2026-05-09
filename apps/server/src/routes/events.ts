import { Hono } from "hono";
import { streamText } from "hono/streaming";
import type { Hex0x, CreateEventV2Request, EventDirectoryEntry } from "@woco/shared";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { createEventV2, confirmSeriesOnChain, getEvent, listEvents, getCreatorEvents, addEventToDirectory, removeEventFromDirectory, isOrganiserTrusted } from "../lib/event/service.js";
import { getOrganiserNonce, getOnChainEvent, getActiveChainId, getWoCoEventAddress } from "../lib/chain/event-contract.js";
import { downloadFromBytes } from "../lib/swarm/bytes.js";
import type { SeriesManifestBlob } from "@woco/shared";
import { manifestDigest, bytesToHex0x } from "@woco/shared";
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

// GET /api/events/organiser-nonce/:address — active chain nonce for the given address
// Must be registered before /:id to avoid "organiser-nonce" matching as an eventId.
events.get("/organiser-nonce/:address", async (c) => {
  const address = c.req.param("address").toLowerCase();
  const chainId = getActiveChainId();
  try {
    const nonce = await getOrganiserNonce(address, chainId);
    return c.json({
      ok: true,
      data: {
        address,
        nonce: nonce.toString(),
        chainId,
        contractAddress: getWoCoEventAddress(chainId),
      },
    });
  } catch (err) {
    console.error("[api] getOrganiserNonce error:", err);
    return c.json({ ok: false, error: "Failed to read organiser nonce" }, 500);
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
    // Deduplicate creatorEntries first (feed can have the same slot written twice).
    const seen = new Set<string>();
    const merged = creatorEntries.filter(e => { if (seen.has(e.eventId)) return false; seen.add(e.eventId); return true; });
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

// POST /api/events — authenticated, creates event + manifests on Swarm (v2)
// Streams NDJSON progress events; final line is the result.
events.post("/", requireAuth, async (c) => {
  const body = c.get("body") as unknown as CreateEventV2Request;
  const parentAddress = c.get("parentAddress") as string;

  const { event: ev, series, image, creatorPodKey, encryptionKey, orderFields, claimMode, skipAutoList } = body;

  if (!ev?.title || !ev?.startDate || !ev?.endDate) {
    return c.json({ ok: false, error: "Missing event title or dates" }, 400);
  }
  if (!series?.length) {
    return c.json({ ok: false, error: "At least one ticket series required" }, 400);
  }
  if (!creatorPodKey || !image) {
    return c.json({ ok: false, error: "Missing creatorPodKey or image" }, 400);
  }
  for (const s of series) {
    if (!s.signedManifest || !s.podBodies?.length) {
      return c.json({ ok: false, error: `Series ${s.seriesId}: missing signedManifest or podBodies` }, 400);
    }
  }

  let imageData: Uint8Array;
  try {
    const raw = image.includes(",") ? image.split(",")[1] : image;
    imageData = Uint8Array.from(atob(raw), (ch) => ch.charCodeAt(0));
  } catch {
    return c.json({ ok: false, error: "Invalid image data" }, 400);
  }

  const eventId = crypto.randomUUID();

  // Escrow enforcement: untrusted organisers must use escrow for paid series.
  const hasPaidSeries = series.some((s) => s.payment);
  if (hasPaidSeries) {
    const trusted = await isOrganiserTrusted(parentAddress);
    if (!trusted) {
      for (const s of series) {
        if (s.payment) s.payment.escrow = true;
      }
    }
  }

  return streamText(c, async (stream) => {
    try {
      const result = await createEventV2({
        eventId,
        title: ev.title,
        description: ev.description || "",
        startDate: ev.startDate,
        endDate: ev.endDate,
        location: ev.location || "",
        creatorAddress: parentAddress.toLowerCase() as Hex0x,
        creatorPodKey,
        imageData,
        series,
        encryptionKey,
        orderFields,
        claimMode,
        skipAutoList: !!skipAutoList,
        onProgress: (p) => stream.writeln(JSON.stringify(p)),
      });

      stream.writeln(JSON.stringify({ type: "done", ok: true, data: { eventId: result.eventId } }));
    } catch (err) {
      console.error("[api] createEventV2 error:", err);
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
  const body = c.get("body") as { sourceApiUrl?: string };

  const rawUrl = (body.sourceApiUrl ?? "").trim().replace(/\/$/, "");
  if (!rawUrl) return c.json({ ok: false, error: "sourceApiUrl is required" }, 400);

  const apiBase = rawUrl.startsWith("http") ? rawUrl : "https://" + rawUrl;

  // Cross-server delegation forwarding is no longer supported (auth v2 signs each
  // request against a specific method+path+body, so an incoming sig can't be
  // replayed against a different server). Discover now always uses the public
  // directory — external unlisted events won't appear until the caller lists them.
  let remoteEntries: import("@woco/shared").EventDirectoryEntry[];
  const usedMine = false;

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

// POST /api/events/:id/confirm-chain — verify on-chain registration and update event feed
// Called by the organiser after their registerEvent tx is confirmed.
events.post("/:id/confirm-chain", requireAuth, async (c) => {
  const eventId = c.req.param("id");
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const body = c.get("body") as { seriesId: string; onChainEventId: string; chainId: number };

  const { seriesId, onChainEventId, chainId } = body;
  if (!seriesId || !onChainEventId || !chainId) {
    return c.json({ ok: false, error: "Missing seriesId, onChainEventId, or chainId" }, 400);
  }

  // Load event from Swarm
  const feed = await getEvent(eventId);
  if (!feed) return c.json({ ok: false, error: "Event not found" }, 404);

  const seriesSummary = feed.series.find((s) => s.seriesId === seriesId);
  if (!seriesSummary) return c.json({ ok: false, error: "Series not found" }, 404);
  if (!seriesSummary.swarmManifestRef) {
    return c.json({ ok: false, error: "Series has no manifest (not a v2 event)" }, 400);
  }

  // Fetch manifest blob from Swarm to get the manifest digest
  let blob: SeriesManifestBlob;
  try {
    const raw = await downloadFromBytes(seriesSummary.swarmManifestRef);
    blob = JSON.parse(raw) as SeriesManifestBlob;
  } catch {
    return c.json({ ok: false, error: "Failed to fetch manifest from Swarm" }, 500);
  }

  // Recompute digest from the manifest body we already validated at creation
  const digestBytes = manifestDigest(blob.signedManifest.body);
  const localDigest = bytesToHex0x(digestBytes).toLowerCase();

  // Read on-chain state
  let onChain: Awaited<ReturnType<typeof getOnChainEvent>>;
  try {
    onChain = await getOnChainEvent(onChainEventId, chainId);
  } catch (err) {
    console.error("[api] confirm-chain getOnChainEvent error:", err);
    return c.json({ ok: false, error: "Failed to read on-chain state" }, 500);
  }

  if (!onChain) return c.json({ ok: false, error: "Event not found on chain" }, 404);
  if (onChain.organiser !== parentAddress) {
    return c.json({ ok: false, error: "On-chain organiser does not match caller" }, 403);
  }
  if (onChain.manifestRef.toLowerCase() !== localDigest) {
    return c.json({ ok: false, error: "On-chain manifestRef does not match local manifest" }, 400);
  }

  // Update event feed with on-chain eventId
  try {
    await confirmSeriesOnChain(eventId, seriesId, onChainEventId);
  } catch (err) {
    console.error("[api] confirm-chain update error:", err);
    return c.json({ ok: false, error: "Failed to update event feed" }, 500);
  }

  return c.json({ ok: true, eventId, seriesId, onChainEventId });
});

export { events };
