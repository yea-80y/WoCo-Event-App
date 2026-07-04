import { Hono, type Context } from "hono";
import { streamText } from "hono/streaming";
import type { Hex0x, CreateEventV2Request, UpdateEventMetaRequest, EventDirectoryEntry } from "@woco/shared";
import { FEATURES, BUYER_FEE_FLOOR_PCT } from "@woco/shared";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { createEventV2, confirmSeriesOnChain, getEvent, getEventForDisplay, readEventFeedSoc, listEvents, getCreatorEvents, addEventToDirectory, removeEventFromDirectory, isOrganiserTrusted, updateEventMetadata, deleteEventIfNoOrders, DeleteBlockedError, type EventMetaUpdates } from "../lib/event/service.js";
import { getOrganiserNonce, getOnChainEvent, getActiveChainId, getWoCoEventAddress } from "../lib/chain/event-contract.js";
import { registerEventOnChain } from "../lib/chain/sponsor-wallet.js";
import { downloadFromBytes, uploadToBytes } from "../lib/swarm/bytes.js";
import { whitelistHashes } from "../lib/swarm/whitelist.js";
import { batchForDeploy } from "../lib/etherna/batch-router.js";
import type { SeriesManifestBlob } from "@woco/shared";
import { manifestDigest, bytesToHex0x } from "@woco/shared";
import { deleteStripeAccount, getStripeAccount, setStripeAccount } from "../lib/stripe/accounts.js";
import { getStripe } from "../lib/stripe/client.js";
import { sanitisePublicApiUrl } from "../lib/url/public-api-url.js";
const events = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Public read rate limiter — 200 req/min per IP.
// Preview mode fires one request per event (up to ~20 concurrent); deployed
// sites use the bundled events-full endpoint so this budget is ample.
// ---------------------------------------------------------------------------
const readRateMap = new Map<string, number[]>();
const READ_RATE_LIMIT  = 200;
const READ_RATE_WINDOW = 60_000;

function clientIp(c: Context<AppEnv>): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("cf-connecting-ip") ||
    "unknown"
  );
}

function checkReadRate(ip: string): boolean {
  const now = Date.now();
  const recent = (readRateMap.get(ip) ?? []).filter((t) => now - t < READ_RATE_WINDOW);
  if (recent.length >= READ_RATE_LIMIT) return false;
  recent.push(now);
  readRateMap.set(ip, recent);
  return true;
}

/** True when an event has definitively ended. Uses endDate if present and valid, falls back to startDate. */
function isPastEntry(e: EventDirectoryEntry, now: number): boolean {
  const raw = (e.endDate && e.endDate.length > 0) ? e.endDate : e.startDate;
  const ts = new Date(raw).getTime();
  return !isNaN(ts) && ts < now;
}

// GET /api/events - public listing (served from in-memory cache, backed by Swarm directory)
// ?filter=upcoming (default) | past | all
events.get("/", async (c) => {
  if (!checkReadRate(clientIp(c))) return c.json({ ok: false, error: "Rate limit exceeded" }, 429);
  try {
    const all = await listEvents();
    const filter = c.req.query("filter") ?? "all";
    const now = Date.now();
    const data = filter === "all" ? all : all.filter((e) => isPastEntry(e, now) === (filter === "past"));
    return c.json({ ok: true, data });
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

// GET /api/events/mine — authenticated, returns caller's events from creator index.
// Unlisted events still appear because the creator index is never trimmed by
// the unlist operation — only the global directory is.
// Must be registered BEFORE /:id to prevent "mine" being treated as an eventId.
events.get("/mine", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  try {
    const creatorEntries = await getCreatorEvents(parentAddress);
    const seen = new Set<string>();
    const merged = creatorEntries.filter(e => { if (seen.has(e.eventId)) return false; seen.add(e.eventId); return true; });

    const filter = c.req.query("filter") ?? "all";
    const now = Date.now();
    const data = filter === "all" ? merged : merged.filter((e) => isPastEntry(e, now) === (filter === "past"));

    return c.json({ ok: true, data });
  } catch (err) {
    console.error("[api] getCreatorEvents error:", err);
    return c.json({ ok: false, error: "Failed to list events" }, 500);
  }
});

// GET /api/events/:id - public detail
events.get("/:id", async (c) => {
  if (!checkReadRate(clientIp(c))) return c.json({ ok: false, error: "Rate limit exceeded" }, 429);
  const eventId = c.req.param("id");
  // Phase B carrier: the caller may pass the organiser's content-feed-signer
  // (?signer=) when it navigated from a directory/site entry that already has it —
  // resolves skipAutoList events that aren't in the global directory.
  const signerHint = c.req.query("signer");
  const validHint = signerHint && /^0x[0-9a-fA-F]{40}$/.test(signerHint) ? signerHint.toLowerCase() : undefined;
  try {
    // Client-supplied signer ⇒ display-only, non-caching read (never poisons the
    // money-path cache). Trusted resolution (directory) still takes precedence.
    const event = await getEventForDisplay(eventId, validHint);
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

  const { event: ev, series, image, creatorPodKey, encryptionKey, orderFields, claimMode, skipAutoList, creatorFeedSigner, gatewayUrl } = body;

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
    // Defence-in-depth — mirror FEATURES gates so an old client (or direct API
    // hit) can't bypass the UI and ship a free event. A paid series must set a
    // price and enable at least one payment rail; Stripe is no longer mandatory
    // (crypto-only events are allowed — see docs/EVENT_CREATION_ANTI_ABUSE.md).
    if (!FEATURES.freeEventsAllowed) {
      if (!s.payment || !s.payment.price || parseFloat(s.payment.price) <= 0) {
        return c.json({ ok: false, error: `Series ${s.seriesId}: free events are not allowed — set a price` }, 400);
      }
      if (!s.payment.stripeEnabled && !s.payment.cryptoEnabled) {
        return c.json({ ok: false, error: `Series ${s.seriesId}: enable a payment method (card or crypto)` }, 400);
      }
    }
    if (!FEATURES.cryptoPaymentsAllowed && s.payment?.cryptoEnabled) {
      return c.json({ ok: false, error: `Series ${s.seriesId}: crypto payments are not allowed` }, 400);
    }
    if (s.payment?.feePassedToCustomer && typeof s.payment.buyerFeePercent === "number"
        && s.payment.buyerFeePercent < BUYER_FEE_FLOOR_PCT) {
      return c.json({ ok: false, error: `Series ${s.seriesId}: buyer fee must be ≥ ${BUYER_FEE_FLOOR_PCT}%` }, 400);
    }
  }

  // Stripe verification gate: live-check charges_enabled directly from Stripe
  // so a stale local cache can never let an unverified account publish.
  const hasStripeSeries = series.some((s) => s.payment?.stripeEnabled);
  if (hasStripeSeries) {
    const stripeRecord = getStripeAccount(parentAddress.toLowerCase());
    if (!stripeRecord) {
      return c.json({
        ok: false,
        error: "Complete Stripe account setup before publishing paid events. Go to Dashboard → Payments to connect Stripe.",
      }, 403);
    }
    try {
      const s = getStripe();
      const account = await s.accounts.retrieve(stripeRecord.stripeAccountId);
      if (!account.charges_enabled) {
        // Keep local cache in sync
        if (stripeRecord.onboardingComplete) {
          setStripeAccount(parentAddress.toLowerCase(), stripeRecord.stripeAccountId, false);
        }
        return c.json({
          ok: false,
          error: "Your Stripe account is not yet verified. Complete identity verification in Dashboard → Payments.",
        }, 403);
      }
      // Sync cache if it was behind
      if (!stripeRecord.onboardingComplete) {
        setStripeAccount(parentAddress.toLowerCase(), stripeRecord.stripeAccountId, true);
      }
    } catch (err: any) {
      if (err?.statusCode === 404 || err?.code === "resource_missing") {
        deleteStripeAccount(parentAddress.toLowerCase());
        return c.json({
          ok: false,
          error: "Complete Stripe account setup before publishing paid events. Go to Dashboard → Payments to connect Stripe.",
        }, 403);
      }
      console.error("[stripe-gate] Failed to verify account:", err);
      return c.json({ ok: false, error: "Could not verify Stripe account status. Please try again." }, 503);
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

  // Phase B: the client-owned content-feed signer (the user's, derived from their
  // root login secret). Optional — absent ⇒ legacy platform-signed event feed.
  // Normalised to lowercase 0x; only a well-formed address is accepted (a bad
  // value would just make the SOC unresolvable, but reject early for clarity).
  let feedSigner: Hex0x | undefined;
  if (creatorFeedSigner) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(creatorFeedSigner)) {
      return c.json({ ok: false, error: "Invalid creatorFeedSigner address" }, 400);
    }
    feedSigner = creatorFeedSigner.toLowerCase() as Hex0x;
  }

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
        ...(ev.tagline ? { tagline: ev.tagline } : {}),
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
        ...(feedSigner ? { creatorFeedSigner: feedSigner } : {}),
        ...(typeof gatewayUrl === "string" ? { gatewayUrl } : {}),
        onProgress: (p) => stream.writeln(JSON.stringify(p)),
      });

      // Client-signed events: return the assembled feed so the client signs it as
      // a SOC (the server has no key). Legacy events were already platform-written.
      stream.writeln(JSON.stringify({
        type: "done",
        ok: true,
        data: { eventId: result.eventId, ...(feedSigner ? { eventFeed: result } : {}) },
      }));
    } catch (err) {
      console.error("[api] createEventV2 error:", err);
      const message = err instanceof Error ? err.message : "Failed to create event";
      stream.writeln(JSON.stringify({ type: "error", ok: false, error: message }));
    }
  });
});

// POST /api/events/:id/update-meta — authenticated, creator-only.
// Edits event-LEVEL metadata only; series/payment data is manifest-committed and
// on-chain anchored, never editable here. Phase B (client-owned feed): the server
// patches the platform directory entries and returns the merged feed for the
// client to re-sign — it never writes the client's SOC.
const META_TEXT_LIMITS = { title: 200, tagline: 200, description: 10_000, location: 300 } as const;
const MAX_EVENT_IMAGE_BYTES = 8 * 1024 * 1024;

events.post("/:id/update-meta", requireAuth, async (c) => {
  const eventId = c.req.param("id");
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const body = c.get("body") as UpdateEventMetaRequest;

  const updates: EventMetaUpdates = {};
  for (const field of Object.keys(META_TEXT_LIMITS) as (keyof typeof META_TEXT_LIMITS)[]) {
    const v = body[field];
    if (v === undefined) continue;
    if (typeof v !== "string") return c.json({ ok: false, error: `${field} must be a string` }, 400);
    const trimmed = v.trim();
    if (trimmed.length > META_TEXT_LIMITS[field]) {
      return c.json({ ok: false, error: `${field} too long (max ${META_TEXT_LIMITS[field]} chars)` }, 400);
    }
    if (field === "title" && trimmed.length === 0) {
      return c.json({ ok: false, error: "title cannot be empty" }, 400);
    }
    updates[field] = trimmed;
  }
  for (const field of ["startDate", "endDate"] as const) {
    const v = body[field];
    if (v === undefined) continue;
    if (typeof v !== "string" || isNaN(new Date(v).getTime())) {
      return c.json({ ok: false, error: `${field} must be a valid date` }, 400);
    }
    updates[field] = v;
  }

  if (body.image !== undefined) {
    if (typeof body.image !== "string") return c.json({ ok: false, error: "image must be a string" }, 400);
    let imageData: Uint8Array;
    try {
      const raw = body.image.includes(",") ? body.image.split(",")[1] : body.image;
      imageData = Uint8Array.from(atob(raw), (ch) => ch.charCodeAt(0));
    } catch {
      return c.json({ ok: false, error: "Invalid image data" }, 400);
    }
    if (imageData.length === 0 || imageData.length > MAX_EVENT_IMAGE_BYTES) {
      return c.json({ ok: false, error: "Image must be under 8 MB" }, 400);
    }
    try {
      // Same batch routing as create — the event's batch, never a purchase trigger.
      const selection = batchForDeploy({
        ownerAddress: parentAddress,
        gatewayUrl: typeof body.gatewayUrl === "string" ? body.gatewayUrl : "",
        deployType: "event",
      });
      const imageHash = await uploadToBytes(imageData, selection);
      await whitelistHashes([imageHash]).catch((err) =>
        console.warn("[event] edit-image whitelist failed (non-critical):", err));
      updates.imageHash = imageHash;
    } catch (err) {
      console.error("[api] update-meta image upload failed:", err);
      return c.json({ ok: false, error: "Image upload failed" }, 502);
    }
  }

  if (Object.keys(updates).length === 0) {
    return c.json({ ok: false, error: "No editable fields provided" }, 400);
  }

  const signerHint = typeof body.signer === "string" && /^0x[0-9a-fA-F]{40}$/.test(body.signer)
    ? body.signer.toLowerCase()
    : undefined;

  try {
    const updated = await updateEventMetadata({ eventId, parentAddress, updates, signerHint });
    // Merged feed goes back on every path: Phase B owners re-sign their SOC with
    // it; legacy callers need it for the fresh imageHash (already platform-written).
    return c.json({ ok: true, data: { eventId, eventFeed: updated } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to update event";
    const status =
      msg === "Event not found" ? 404 :
      msg === "Not the event creator" ? 403 :
      msg === "Invalid event dates" || msg === "endDate is before startDate" ? 400 : 500;
    if (status === 500) console.error("[api] update-meta failed:", err);
    return c.json({ ok: false, error: status === 500 ? "Failed to update event" : msg }, status);
  }
});

// POST /api/events/:id/delete — authenticated, creator-only, ONLY with zero
// orders (on-chain claims + legacy claim feeds + pending approvals + live buyer
// holds — server-verified, fail-closed). Tombstones the feed and removes both
// directory entries. Phase B: the owner overwrites their SOC with the returned
// tombstoned feed, exactly like update-meta.
events.post("/:id/delete", requireAuth, async (c) => {
  const eventId = c.req.param("id");
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const body = c.get("body") as { signer?: unknown };

  const signerHint = typeof body.signer === "string" && /^0x[0-9a-fA-F]{40}$/.test(body.signer)
    ? body.signer.toLowerCase()
    : undefined;

  try {
    const tombstoned = await deleteEventIfNoOrders({ eventId, parentAddress, signerHint });
    return c.json({ ok: true, data: { eventId, eventFeed: tombstoned } });
  } catch (err) {
    if (err instanceof DeleteBlockedError) {
      return c.json({ ok: false, error: err.message, blockers: err.blockers }, 409);
    }
    const msg = err instanceof Error ? err.message : "Failed to delete event";
    const status =
      msg === "Event not found" ? 404 :
      msg === "Not the event creator" ? 403 :
      msg.startsWith("Could not verify") ? 503 : 500;
    if (status === 500) console.error("[api] delete event failed:", err);
    return c.json({ ok: false, error: status === 500 ? "Failed to delete event" : msg }, status);
  }
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
  const body = c.get("body") as { sourceApiUrl?: string; signer?: string };
  // Carrier for a client-signed event: a skipAutoList event isn't in the global
  // directory, so the server can't resolve its content-feed signer to read the
  // client SOC. The authenticated creator passes their own signer; it's used ONLY
  // to READ (display-only, non-caching) — the creatorAddress==parent check below is
  // the real gate, so a forged signer can't list someone else's event.
  const carrier = body.signer && /^0x[0-9a-fA-F]{40}$/.test(body.signer) ? body.signer.toLowerCase() : undefined;

  let eventFeed: import("@woco/shared").EventFeed | null = null;

  if (body.sourceApiUrl) {
    const apiBase = body.sourceApiUrl.trim().replace(/\/$/, "");
    const q = carrier ? `?signer=${carrier}` : "";
    try {
      const resp = await fetch(`${apiBase}/api/events/${eventId}${q}`, { signal: AbortSignal.timeout(15000) });
      if (!resp.ok) return c.json({ ok: false, error: `Source server returned HTTP ${resp.status}` }, 400);
      const json = await resp.json() as { ok: boolean; data?: import("@woco/shared").EventFeed; error?: string };
      if (!json.ok || !json.data) return c.json({ ok: false, error: json.error || "Event not found on source server" }, 404);
      eventFeed = json.data;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      return c.json({ ok: false, error: `Could not reach source server: ${msg}` }, 400);
    }
  } else {
    eventFeed = await getEventForDisplay(eventId, carrier);
  }

  if (!eventFeed) return c.json({ ok: false, error: "Event not found" }, 404);
  if (eventFeed.creatorAddress.toLowerCase() !== parentAddress) {
    return c.json({ ok: false, error: "You are not the creator of this event" }, 403);
  }

  try {
    // Substitute the server's own PUBLIC_API_BASE for any localhost / private /
    // non-https value the client supplied. Federated public URLs pass through.
    const directoryApiUrl = sanitisePublicApiUrl(body.sourceApiUrl);
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
      ...(directoryApiUrl ? { apiUrl: directoryApiUrl } : {}),
      // Carry the content-feed signer into the global directory so a later no-hint
      // getEvent (deployed site, WoCo app) can resolve the client SOC — this is what
      // makes the event PAGE load, not just the listing succeed.
      ...(eventFeed.creatorFeedSigner ? { creatorFeedSigner: eventFeed.creatorFeedSigner } : {}),
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

// POST /api/events/:id/register-on-chain — authenticated, organiser-only
// Calls registerEvent via the sponsor wallet (no EOA needed for the organiser).
// Verifies ownership, sends the tx, then writes onChainEventId back to the Swarm feed.
events.post("/:id/register-on-chain", requireAuth, async (c) => {
  const tStart = Date.now();
  const eventId = c.req.param("id");
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const body = c.get("body") as { seriesId: string; signer?: string };
  const { seriesId } = body;

  if (!seriesId) {
    return c.json({ ok: false, error: "Missing seriesId" }, 400);
  }

  // Phase B carrier: the client passes its content-feed-signer so we can read the
  // just-published client SOC without racing the fire-and-forget directory write.
  // Client-supplied ⇒ display-only, non-caching read (the ownership check below is
  // the gate; a forged signer can't poison the money-path cache).
  const signerHint = body.signer && /^0x[0-9a-fA-F]{40}$/.test(body.signer) ? body.signer.toLowerCase() : undefined;
  // The client uploads its event SOC AFTER this registration returns (see
  // PublishButton: signEventFeedSoc runs post-register), so reading that SOC here
  // hits a not-yet-existent chunk and STALLS on Bee network retrieval — the real
  // cost behind a "slow on-chain step". createEventV2 primed the money-path cache
  // moments ago (same process), so resolve from it first. The signerHint SOC read
  // (Fix B, avoids the ~32s whole-directory lookup) stays as the cold-cache fallback.
  let feed = await getEvent(eventId);
  if (!feed) feed = signerHint ? await readEventFeedSoc(eventId, signerHint) : null;
  if (!feed) feed = await getEventForDisplay(eventId, signerHint);
  if (!feed) return c.json({ ok: false, error: "Event not found" }, 404);
  if (feed.creatorAddress.toLowerCase() !== parentAddress) {
    return c.json({ ok: false, error: "Only the event creator can register on-chain" }, 403);
  }

  const series = feed.series.find((s) => s.seriesId === seriesId);
  if (!series) return c.json({ ok: false, error: "Series not found" }, 404);
  if (!series.swarmManifestRef) {
    return c.json({ ok: false, error: "Series has no manifest (not a v2 event)" }, 400);
  }
  if (series.onChainEventId) {
    return c.json({ ok: true, onChainEventId: series.onChainEventId, alreadyRegistered: true });
  }

  // The on-chain manifestRef is the manifest digest, which createEventV2 already
  // stamped into the feed as `series.manifestRef` — no need to re-download the
  // SeriesManifestBlob from Swarm just to recompute it (that was ~1.3s of feedRead).
  // The trusted feed (cache, server-built) carries it; confirm-chain re-verifies the
  // digest against the stored blob + chain separately. Fall back to the blob only if
  // a legacy feed lacks the field.
  let manifestRef = series.manifestRef as Hex0x | undefined;
  if (!manifestRef) {
    try {
      const raw = await downloadFromBytes(series.swarmManifestRef);
      const blob = JSON.parse(raw) as SeriesManifestBlob;
      const digestBytes = manifestDigest(blob.signedManifest.body);
      manifestRef = `0x${bytesToHex0x(digestBytes).replace(/^0x/, "")}` as Hex0x;
    } catch {
      return c.json({ ok: false, error: "Failed to fetch manifest from Swarm" }, 500);
    }
  }

  // V2 (USDC-escrow) register params. The live website ticket flow settles outside
  // this escrow (Stripe card, or direct-USDC verify), so priceBaseUnits=0 keeps the
  // on-chain escrow dormant; the organiser is the
  // payout recipient; dropGate is open FIFO. eventEndTs is the event's real end
  // (Unix secs) but floored at now+1h so past-dated test events still satisfy
  // the contract's `eventEndTs > block.timestamp` guard. It doubles as the
  // on-chain sales cutoff and the start of the withdraw release window.
  // Ignored on V1 chains (registerEventOnChain dispatches on contract version).
  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
  const nowSec = Math.floor(Date.now() / 1000);
  const endSec = Math.floor(new Date(feed.endDate).getTime() / 1000);
  const eventEndTs = Math.max(Number.isFinite(endSec) ? endSec : 0, nowSec + 3600);

  const tReg = Date.now();
  let onChainEventId: string;
  let txHash: string;
  try {
    ({ onChainEventId, txHash } = await registerEventOnChain(series.totalSupply, manifestRef, {
      priceBaseUnits: 0n,
      payoutRecipient: feed.creatorAddress,
      dropGate: ZERO_ADDRESS,
      eventEndTs,
    }));
  } catch (err) {
    console.error("[api] register-on-chain tx error:", err);
    const message = err instanceof Error ? err.message : "registerEvent tx failed";
    return c.json({ ok: false, error: message }, 500);
  }
  const tTx = Date.now();

  let updatedFeed: Awaited<ReturnType<typeof confirmSeriesOnChain>>;
  try {
    updatedFeed = await confirmSeriesOnChain(eventId, seriesId, onChainEventId, signerHint);
  } catch (err) {
    console.error("[api] register-on-chain confirm error:", err);
    // Feed update failed but tx is on-chain — return the eventId so client can retry confirm
    return c.json({ ok: false, error: "Tx confirmed but feed update failed — retry", onChainEventId, txHash }, 500);
  }

  console.log(
    `[api] register-on-chain timing: feedRead=${tReg - tStart}ms tx=${tTx - tReg}ms confirm=${Date.now() - tTx}ms total=${Date.now() - tStart}ms`,
  );
  return c.json({
    ok: true,
    onChainEventId,
    txHash,
    ...(feed.creatorFeedSigner ? { eventFeed: updatedFeed } : {}),
  });
});

// ── RA.co GraphQL bypass ─────────────────────────────────────────────────────
// ra.co serves a DataDome captcha to non-browser clients, so the HTML route is
// unreachable. The public GraphQL endpoint is unprotected and returns the same
// event data. Called for hostnames matching ra.co/events/{id}.
type ImportTier = { name: string; price?: string; currency?: string; saleStart?: string; saleEnd?: string; status?: string };
type ImportPreview = {
  name: string; tagline: string; description: string; imageUrl: string;
  startDate: string; endDate: string; location: string;
  price: string | null; currency: string; tiers: ImportTier[];
  organiser: string; sourceUrl: string;
};

async function fetchRaEvent(eventId: string, sourceUrl: string): Promise<{ ok: true; preview: ImportPreview } | { ok: false; error: string }> {
  const query = `query GET_EVENT_DETAIL($id: ID!) {
    event(id: $id) {
      id title startTime endTime contentUrl flyerFront date cost
      venue { name address }
      artists { name }
      promoters { name }
    }
  }`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch("https://ra.co/graphql", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://ra.co/",
        "Accept": "application/json",
      },
      body: JSON.stringify({ operationName: "GET_EVENT_DETAIL", variables: { id: eventId }, query }),
    });
    clearTimeout(timeout);
    if (!resp.ok) return { ok: false, error: `RA GraphQL failed: ${resp.status}` };
    const body = (await resp.json()) as { data?: { event?: Record<string, unknown> | null } };
    const ev = body?.data?.event;
    if (!ev) return { ok: false, error: "RA event not found" };

    const title = String(ev.title ?? "");
    const start = String(ev.startTime ?? ev.date ?? "");
    const end   = String(ev.endTime ?? "");
    // RA returns "2026-06-11T21:00:00.000" (no zone, local wall-clock) — keep as-is.
    const toLocal = (s: string) => {
      const w = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(s);
      return w ? `${w[1]}T${w[2]}` : (/^(\d{4}-\d{2}-\d{2})/.exec(s)?.[1] ?? "");
    };

    const venue = (ev.venue ?? null) as { name?: string; address?: string } | null;
    const location = [venue?.name, venue?.address].filter(Boolean).join(", ");
    const artistList = Array.isArray(ev.artists) ? (ev.artists as { name?: string }[]).map((a) => a.name).filter(Boolean) : [];
    const promoters = Array.isArray(ev.promoters) ? (ev.promoters as { name?: string }[]).map((p) => p.name).filter(Boolean) : [];

    // Cost like "£5" or "£10 - £15". Pull first numeric and currency symbol.
    let price: string | null = null;
    let currency = "";
    const cost = typeof ev.cost === "string" ? ev.cost : "";
    if (cost) {
      const pm = /([£$€])\s*(\d+(?:\.\d+)?)/.exec(cost);
      if (pm) {
        price = pm[2];
        currency = pm[1] === "£" ? "GBP" : pm[1] === "$" ? "USD" : "EUR";
      }
    }

    const tiers: ImportTier[] = price
      ? [{ name: "General Admission", price, currency }]
      : [];

    return {
      ok: true,
      preview: {
        name: title.slice(0, 200),
        tagline: artistList.length ? `Featuring ${artistList.slice(0, 5).join(", ")}` : "",
        description: "",
        imageUrl: String(ev.flyerFront ?? "").slice(0, 500),
        startDate: toLocal(start),
        endDate: toLocal(end),
        location: location.slice(0, 300),
        price,
        currency,
        tiers,
        organiser: promoters[0] ?? "",
        sourceUrl,
      },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `RA fetch failed: ${msg}` };
  }
}

// ── POST /api/events/import-url ──────────────────────────────────────────────
// Server-side fetch of a third-party event URL (Skiddle, Fatsoma, Eventbrite, RA, etc.)
// Parses OG meta tags and schema.org/Event structured data and returns structured fields.
// ra.co is captcha-blocked so we route through its public GraphQL endpoint.
// Auth required — creators only, not publicly accessible to prevent abuse.
// Must be registered BEFORE /:id.
events.post("/import-url", requireAuth, async (c) => {
  let body: { url?: string };
  try { body = await c.req.json(); } catch {
    return c.json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const rawUrl = body?.url?.trim() ?? "";
  if (!rawUrl) return c.json({ ok: false, error: "url is required" }, 400);

  // Basic SSRF protection — allow only public http/https URLs
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch {
    return c.json({ ok: false, error: "Invalid URL" }, 400);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return c.json({ ok: false, error: "Only http/https URLs allowed" }, 400);
  }
  const h = parsed.hostname.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || /^192\.168\./.test(h) || /^10\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.endsWith(".local") || h.endsWith(".internal")) {
    return c.json({ ok: false, error: "Private addresses not allowed" }, 400);
  }

  // ── ra.co special case: page is DataDome-protected, GraphQL is public ─────
  // The HTML response is a captcha challenge; bypass by querying ra.co/graphql
  // directly for the event ID encoded in the URL path.
  const raMatch = h === "ra.co" || h === "www.ra.co"
    ? /^\/events\/(\d+)/.exec(parsed.pathname)
    : null;
  if (raMatch) {
    const data = await fetchRaEvent(raMatch[1], rawUrl);
    if (data.ok) return c.json({ ok: true, data: data.preview });
    return c.json({ ok: false, error: data.error }, 422);
  }

  let html: string;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch(rawUrl, {
      signal: controller.signal,
      // Browser-like UA — some hosts (Eventbrite, Fatsoma) gate JSON-LD on this.
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-GB,en;q=0.9",
      },
    });
    clearTimeout(timeout);
    if (!resp.ok) return c.json({ ok: false, error: `Fetch failed: ${resp.status}` }, 422);
    const ct = resp.headers.get("content-type") ?? "";
    if (!ct.includes("text/html") && !ct.includes("text/plain")) {
      return c.json({ ok: false, error: "URL does not appear to be an HTML page" }, 422);
    }
    // Limit to 512 KB to avoid huge pages
    const buf = await resp.arrayBuffer();
    if (buf.byteLength > 512 * 1024) {
      html = new TextDecoder().decode(buf.slice(0, 512 * 1024));
    } else {
      html = new TextDecoder().decode(buf);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("abort") || msg.includes("Abort")) {
      return c.json({ ok: false, error: "Request timed out — the page took too long to respond" }, 422);
    }
    return c.json({ ok: false, error: `Could not fetch URL: ${msg}` }, 422);
  }

  // ── Parse helpers ────────────────────────────────────────────────────────
  function getMeta(name: string): string {
    // <meta name="..."> or <meta property="...">
    const re = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["']`, "i");
    const m = re.exec(html) ?? new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${name}["']`, "i").exec(html);
    return m ? decodeHtmlEntities(m[1].trim()) : "";
  }

  // Schema.org Event subtypes — Eventbrite uses "Festival", music sites use
  // "MusicEvent", etc. Match anything inheriting from Event.
  const EVENT_TYPES = new Set([
    "Event", "BusinessEvent", "ChildrensEvent", "ComedyEvent", "DanceEvent",
    "DeliveryEvent", "EducationEvent", "EventSeries", "ExhibitionEvent",
    "Festival", "FoodEvent", "Hackathon", "LiteraryEvent", "MusicEvent",
    "PublicationEvent", "SaleEvent", "ScreeningEvent", "SocialEvent",
    "SportsEvent", "TheaterEvent", "VisualArtsEvent",
  ]);

  function isEventType(t: unknown): boolean {
    if (typeof t === "string") return EVENT_TYPES.has(t);
    if (Array.isArray(t)) return t.some((x) => typeof x === "string" && EVENT_TYPES.has(x));
    return false;
  }

  function getSchemaEvent(): Record<string, unknown> | null {
    const ldRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let m: RegExpExecArray | null;
    while ((m = ldRe.exec(html)) !== null) {
      try {
        const raw: unknown = JSON.parse(m[1]);
        const candidates: unknown[] = [];
        if (Array.isArray(raw)) {
          candidates.push(...raw);
        } else if (raw && typeof raw === "object") {
          const obj = raw as Record<string, unknown>;
          if (obj["@graph"] && Array.isArray(obj["@graph"])) candidates.push(...(obj["@graph"] as unknown[]));
          else candidates.push(raw);
        }
        for (const node of candidates) {
          if (node && typeof node === "object" && isEventType((node as Record<string, unknown>)["@type"])) {
            return node as Record<string, unknown>;
          }
        }
      } catch { /* malformed JSON-LD — skip */ }
    }
    return null;
  }

  function decodeHtmlEntities(s: string): string {
    return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  }

  // ── Extract fields ───────────────────────────────────────────────────────
  const schema = getSchemaEvent();

  const name =
    getMeta("og:title") ||
    getMeta("twitter:title") ||
    (schema?.name as string | undefined) ||
    (() => { const m = /<title[^>]*>([^<]+)<\/title>/i.exec(html); return m ? decodeHtmlEntities(m[1].trim()) : ""; })() ||
    "";

  // Split tagline (short subtitle) from description (long body).
  // og:description is typically a one-line teaser; schema.description is the full body.
  // If only one source is present, fall through so we don't lose information.
  const ogDescription = getMeta("og:description") || getMeta("twitter:description") || getMeta("description") || "";
  const schemaDescription = (schema?.description as string | undefined) ?? "";

  let tagline = "";
  let description = "";
  if (ogDescription && schemaDescription && ogDescription.trim() !== schemaDescription.trim()) {
    tagline = ogDescription;
    description = schemaDescription;
  } else if (schemaDescription) {
    description = schemaDescription;
  } else {
    description = ogDescription;
  }

  const image =
    getMeta("og:image") ||
    getMeta("twitter:image") ||
    (() => {
      const img = (schema?.image as string | { url?: string } | undefined);
      return typeof img === "string" ? img : (img?.url ?? "");
    })() ||
    "";

  // Parse start/end date — return datetime-local format when a time is present, else date-only.
  // Avoid `new Date(...).toISOString()` because it shifts to UTC and can roll the date back/forward.
  function toLocalIso(val: unknown): string {
    if (typeof val !== "string" || !val) return "";
    const s = val.trim();
    // Date-only: YYYY-MM-DD
    const dateOnly = /^(\d{4}-\d{2}-\d{2})$/.exec(s);
    if (dateOnly) return dateOnly[1];
    // ISO with time (with or without zone): keep the wall-clock components.
    const withTime = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(s);
    if (withTime) return `${withTime[1]}T${withTime[2]}`;
    return "";
  }

  const startDate = toLocalIso(schema?.startDate);
  const endDate   = toLocalIso(schema?.endDate);

  // Location
  let location = "";
  if (schema?.location) {
    const loc = schema.location as Record<string, unknown>;
    if (typeof loc === "string") location = loc;
    else location = [loc.name, (loc.address as Record<string, unknown>)?.streetAddress, (loc.address as Record<string, unknown>)?.addressLocality].filter(Boolean).join(", ");
  }

  // ── Ticket tiers (offers[]) ──────────────────────────────────────────────
  // Skiddle / Eventbrite expose multiple tiers as `offers: Offer[]`.
  // We pass the full list through so the client can render a series-per-tier.
  function parseOffer(raw: unknown): ImportTier | null {
    if (!raw || typeof raw !== "object") return null;
    const o = raw as Record<string, unknown>;
    const t: ImportTier = {
      name: (typeof o.name === "string" && o.name)
        || (typeof o.description === "string" && o.description)
        || (typeof o.category === "string" && o.category)
        || "Ticket",
    };
    // Single Offer: `price`. AggregateOffer (Eventbrite): `lowPrice`/`highPrice`.
    const rawPrice = o.price ?? o.lowPrice;
    if (rawPrice !== undefined && rawPrice !== null) {
      const p = String(rawPrice);
      if (p && !isNaN(parseFloat(p))) t.price = p;
    }
    if (typeof o.priceCurrency === "string") t.currency = o.priceCurrency;
    const start = toLocalIso(o.availabilityStarts ?? o.validFrom);
    const end   = toLocalIso(o.availabilityEnds   ?? o.validThrough);
    if (start) t.saleStart = start;
    if (end)   t.saleEnd   = end;
    if (typeof o.availability === "string") {
      // schema.org enums: InStock, SoldOut, PreOrder, etc. Normalise to short tags.
      const a = o.availability.toLowerCase();
      if (a.includes("soldout"))  t.status = "soldout";
      else if (a.includes("preorder")) t.status = "preorder";
      else if (a.includes("instock"))  t.status = "available";
    }
    return t;
  }

  const tiers: ImportTier[] = [];
  if (schema?.offers) {
    const offerList = Array.isArray(schema.offers) ? schema.offers : [schema.offers];
    for (const o of offerList) {
      const tier = parseOffer(o);
      if (tier) tiers.push(tier);
    }
  }

  // Legacy single-price fields (kept for callers that read them)
  const price = tiers.find(t => t.price)?.price ?? null;
  const currency = tiers.find(t => t.currency)?.currency ?? "";

  // Organiser
  let organiser = "";
  if (schema?.organizer) {
    const org = schema.organizer as Record<string, unknown>;
    organiser = typeof org === "string" ? org : (org.name as string) ?? "";
  }

  const data = {
    name:        name.slice(0, 200),
    tagline:     tagline.slice(0, 200),
    description: description.slice(0, 2000),
    imageUrl:    image.slice(0, 500),
    startDate,
    endDate,
    location:    location.slice(0, 300),
    price,
    currency,
    tiers,
    organiser:   organiser.slice(0, 200),
    sourceUrl:   rawUrl,
  };

  return c.json({ ok: true, data });
});

export { events };
