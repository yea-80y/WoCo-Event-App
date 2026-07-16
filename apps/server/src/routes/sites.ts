import { Hono } from "hono";
import { Topic, Reference } from "@ethersphere/bee-js";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { requireAuth } from "../middleware/auth.js";
import { getEvent, getCreatorEvents } from "../lib/event/service.js";
import { getCreatorSites, upsertCreatorSite, resolveSiteConfig } from "../lib/site/service.js";
import { updateDomainsForSite } from "../lib/domains/service.js";
import {
  readFeedPage,
  writeFeedPage,
  encodeJsonFeed,
  decodeJsonFeed,
} from "../lib/swarm/feeds.js";
import {
  getBee,
  getPlatformSigner,
  getPlatformOwner,
  BEE_URL,
  POSTAGE_BATCH_ID,
} from "../config/swarm.js";
import { batchForDeploy, BatchPurchaseRequired, StripeVerificationRequired, type BatchSelection } from "../lib/etherna/batch-router.js";
import { isVerifiedOrganiser } from "../lib/stripe/verification.js";
import { recordUpload, getFreeHostedBytes } from "../lib/swarm/storage-ledger.js";

/** Per-owner byte cap for free-hosted (shared platform batch) website deploys.
 *  Quota counts each site's LATEST deploy only (republish supersedes — see
 *  storage-ledger.ts), so 100MB ≈ 10 live sites at the ~8-10MB tar size. */
const FREE_HOSTING_QUOTA_BYTES = Number(process.env.FREE_HOSTING_QUOTA_BYTES) || 100 * 1024 * 1024;
import { getEthernaBee, uploadCollectionToEtherna, registerEthernaOffer, writeEthernaFeedUpdate, prepareEthernaFeedUpdate } from "../lib/etherna/upload.js";
import {
  siteConfigTopic,
  sitePagesTopicFn,
  siteEventsIndexTopic,
  multisiteFeedTopic,
  SITE_SCHEMA_VERSION,
} from "@woco/shared";
import type { Site, SitePointer, SiteEventsIndex, SiteEventEntry, SiteDirectoryEntry, ContactFormSection, EventFeed, EventDirectoryEntry, Hex0x } from "@woco/shared";
import { getResend, getFromAddress } from "../lib/email/client.js";
import { uploadToBytes } from "../lib/swarm/bytes.js";
import { whitelistHashes } from "../lib/swarm/whitelist.js";
import { getLabelOwner, updateSubEnsContenthash } from "../lib/chain/sub-ens-contract.js";
import { BEE_CALL_TIMEOUT_MS, BEE_COLLECTION_TIMEOUT_MS, withTimeout } from "../lib/swarm/upload-queue.js";

const sitesRouter = new Hono();

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_MULTISITE_PATH = resolve(__dirname, "../../../../apps/web/dist-multisite");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Config read for routes — follows the client-owned pointer (see service.ts). */
async function readSiteConfig(siteId: string): Promise<Site | null> {
  return (await resolveSiteConfig(siteId))?.site ?? null;
}

/**
 * Phase B: stamp each site event entry with its organiser's content-feed-signer
 * address (the money-path discovery carrier). This index is read on the
 * claim/payment path, so the signer MUST come from a server-trusted source — a
 * client-supplied `entry.creatorFeedSigner` is IGNORED and stripped (otherwise a
 * site owner could publish a site referencing someone else's eventId with a forged
 * signer and poison that event's price/recipient read — the 93ea980 class of bug).
 *
 * Trusted sources, in order (all server-written, never the request body):
 *  1. the OWNER's own creator directory (`getCreatorEvents`) — keyed by the
 *     authenticated creator; covers the owner's UNLISTED (skipAutoList) events,
 *     which is the whole point (a site is the carrier for not-WoCo-listed events);
 *  2. the GLOBAL event directory via `getEvent` — covers a featured event owned by
 *     ANOTHER creator that is publicly listed (its signer is server-stamped there);
 *  3. the prior value already in the server-written index (`priorSigners`) — carries
 *     a known-good signer forward across a transient source read failure so a
 *     re-publish never wipes a carrier (and never resurrects a client value).
 *
 * Legacy platform-signed events resolve to no signer and stay uncarried (legacy
 * read path). This also makes a site keep reading a client-owned event after the
 * organiser UNLISTS it (the global-directory carrier disappears; source 1 persists).
 *
 * @param ownerAddress  the AUTHENTICATED site owner (c.get("parentAddress")).
 * @param priorSigners  eventId → signer from the existing server-written index.
 */
async function stampEventSigners(
  events: SiteEventEntry[],
  ownerAddress: string,
  priorSigners?: Map<string, Hex0x>,
): Promise<SiteEventEntry[]> {
  // One cached read (5-min memo) of the owner's directory — covers the common case
  // (a site features the owner's own events) with zero per-event Swarm reads.
  const ownerDir = await getCreatorEvents(ownerAddress).catch(() => [] as EventDirectoryEntry[]);
  const ownerSigner = new Map<string, Hex0x>();
  for (const e of ownerDir) if (e.creatorFeedSigner) ownerSigner.set(e.eventId, e.creatorFeedSigner);

  return Promise.all(
    events.map(async (entry) => {
      // Resolve the trusted signer; the client entry value is never consulted.
      let signer: Hex0x | undefined = ownerSigner.get(entry.eventId);
      if (!signer) {
        // Foreign (non-owner) event: trust only the global-directory carrier.
        try {
          signer = (await getEvent(entry.eventId))?.creatorFeedSigner;
        } catch {
          /* transient — fall through to the prior server-written value */
        }
      }
      if (!signer) signer = priorSigners?.get(entry.eventId);

      // Strip any client-supplied signer; only a server-trusted value may carry.
      const { creatorFeedSigner: _ignored, ...rest } = entry;
      return signer ? { ...rest, creatorFeedSigner: signer } : rest;
    }),
  );
}

/**
 * Batch routing for a site's PLATFORM-WRITTEN feed pages (pointer, legacy
 * config/pages, events index). They follow the site's home gateway so the
 * feeds live and die with the site content they anchor (#48) — a WoCo-stamped
 * pointer to an Etherna-hosted site would expire independently of it.
 * deployType "event" = the UNGATED cold-write rules (user batch if live, else
 * the shared Etherna platform batch): a 4KB feed page must never trip the
 * purchase or verification gate. Any failure falls back to the WoCo batch —
 * feed routing is an optimisation of postage lifetime, never publish-blocking.
 */
function siteFeedDest(ownerAddress: string, gatewayUrl: string | undefined): BatchSelection | undefined {
  if (!gatewayUrl) return undefined;
  try {
    const sel = batchForDeploy({ ownerAddress, gatewayUrl, deployType: "event" });
    return sel.target === "etherna" ? sel : undefined;
  } catch (e) {
    console.warn("[sites] feed batch routing failed — WoCo batch fallback:", (e as Error).message);
    return undefined;
  }
}

/** Resolve the site's home gateway from the owner's directory entry (the
 *  deployedUrl carries the gateway host) — for endpoints that rewrite site
 *  feeds without a client gateway signal (add/remove event). */
async function siteFeedDestFromDirectory(ownerAddress: string, siteId: string): Promise<BatchSelection | undefined> {
  try {
    const sites = await getCreatorSites(ownerAddress);
    return siteFeedDest(ownerAddress, sites.find((s) => s.siteId === siteId)?.deployedUrl);
  } catch {
    return undefined;
  }
}

function spawnPromise(cmd: string, args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code === 0) res();
      else rej(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 300)}`));
    });
    proc.on("error", rej);
  });
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildContactHtml(name: string, email: string, message: string, siteName: string): string {
  return `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;max-width:600px;margin:40px auto;padding:0 20px;color:#111">
<h2 style="margin:0 0 1.5rem">New enquiry — ${escHtml(siteName)}</h2>
<table style="border-collapse:collapse;width:100%">
<tr><td style="padding:8px 0;color:#666;width:80px;vertical-align:top">Name</td><td style="padding:8px 0;font-weight:600">${escHtml(name)}</td></tr>
<tr><td style="padding:8px 0;color:#666;vertical-align:top">Email</td><td style="padding:8px 0"><a href="mailto:${escHtml(email)}">${escHtml(email)}</a></td></tr>
<tr><td style="padding:8px 0;color:#666;vertical-align:top">Message</td><td style="padding:8px 0;white-space:pre-wrap">${escHtml(message)}</td></tr>
</table>
<p style="color:#999;font-size:0.8rem;margin:2rem 0 0">Sent via WoCo contact form</p>
</body></html>`;
}

// Rate limiter: ip → timestamps (contact form)
const contactRateMap = new Map<string, number[]>();
const CONTACT_RATE_LIMIT = 3;
const CONTACT_RATE_WINDOW = 15 * 60_000;

// ---------------------------------------------------------------------------
// POST /api/sites/upload-image — upload an image to Swarm (auth required)
// Returns the content hash for use in logoSwarmRef / gallery refs.
// ---------------------------------------------------------------------------

sitesRouter.post("/upload-image", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  try {
    const body = await c.req.json() as { image?: string; gatewayUrl?: string };
    if (!body.image || typeof body.image !== "string") {
      return c.json({ ok: false, error: "Missing image data" }, 400);
    }

    const raw = body.image.includes(",") ? body.image.split(",")[1] : body.image;
    const bytes = Uint8Array.from(atob(raw), (ch) => ch.charCodeAt(0));

    if (bytes.length > 4 * 1024 * 1024) {
      return c.json({ ok: false, error: "Image too large (max 4MB)" }, 400);
    }

    // Same routing + gates as the site deploy itself: user batch when live,
    // free-hosting platform-batch fallback (Stripe-verified, quota-metered)
    // otherwise. Site images are site bytes — letting them bypass the quota
    // would leave the deploy gate meterable around.
    let selection;
    try {
      selection = batchForDeploy({
        ownerAddress: parentAddress,
        gatewayUrl: body.gatewayUrl ?? "",
        deployType: "website",
        freeHostingEligible: await isVerifiedOrganiser(parentAddress),
      });
    } catch (err) {
      if (err instanceof BatchPurchaseRequired) {
        return c.json({ ok: false, error: err.message, code: "BATCH_PURCHASE_REQUIRED" }, 402);
      }
      if (err instanceof StripeVerificationRequired) {
        return c.json({ ok: false, error: err.message, code: "STRIPE_VERIFICATION_REQUIRED" }, 403);
      }
      throw err;
    }

    if (selection.freeHosted) {
      const used = getFreeHostedBytes(parentAddress);
      if (used + bytes.length > FREE_HOSTING_QUOTA_BYTES) {
        return c.json({
          ok: false,
          error: "Free hosting quota exceeded — purchase your own storage batch to continue.",
          code: "FREE_HOSTING_QUOTA_EXCEEDED",
        }, 413);
      }
    }

    const imageRef = await uploadToBytes(bytes, selection);
    recordUpload(parentAddress, {
      ref: imageRef,
      bytes: bytes.length,
      kind: "site-image",
      batchId: selection.batchId,
      target: selection.target,
      ...(selection.freeHosted ? { freeHosted: true } : {}),
    });
    return c.json({ ok: true, data: { imageRef } });
  } catch (err) {
    console.error("[sites/upload-image]", err);
    return c.json({ ok: false, error: "Upload failed" }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /api/sites — publish site config + events index atomically
// Creates or updates. Server always stamps ownerAddress = authenticated address.
// ---------------------------------------------------------------------------

sitesRouter.post("/", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();

  try {
    const body = await c.req.json() as { site?: Site; events?: SiteEventEntry[]; siteFeedSigner?: string; gatewayUrl?: string };
    if (!body?.site?.siteId) {
      return c.json({ ok: false, error: "Invalid site data" }, 400);
    }
    if (body.gatewayUrl !== undefined && typeof body.gatewayUrl !== "string") {
      return c.json({ ok: false, error: "Invalid gatewayUrl" }, 400);
    }

    const { site, events = [] } = body;
    const feedDest = siteFeedDest(parentAddress, body.gatewayUrl);

    // Client-owned publish: the full Site already lives in the owner's SOC at
    // siteConfigTopic(siteId) (the client signs + uploads it BEFORE this call);
    // the platform feed gets only a SitePointer. The signer address is the
    // authenticated user's own claim about their own site — it can only resolve
    // the SOC namespace of that signer at THIS siteId, so it cannot be aimed at
    // another user's content (see SitePointer doc).
    const siteFeedSigner = body.siteFeedSigner?.toLowerCase();
    if (siteFeedSigner && !/^0x[0-9a-f]{40}$/.test(siteFeedSigner)) {
      return c.json({ ok: false, error: "Invalid siteFeedSigner" }, 400);
    }

    // If an existing site is published, only the owner may overwrite it.
    const existing = await resolveSiteConfig(site.siteId);
    if (existing && existing.site.ownerAddress.toLowerCase() !== parentAddress) {
      return c.json({ ok: false, error: "Not the site owner" }, 403);
    }

    const now = Date.now();

    const configTopic = Topic.fromString(siteConfigTopic(site.siteId));
    const pagesTopic  = Topic.fromString(sitePagesTopicFn(site.siteId));
    const eventsTopic = Topic.fromString(siteEventsIndexTopic(site.siteId));

    // Prior server-written signers (trusted) — carried forward if a source read
    // transiently fails so a re-publish never wipes a known carrier.
    const priorPage = await readFeedPage(eventsTopic).catch(() => null);
    const priorIndex = priorPage ? decodeJsonFeed<SiteEventsIndex>(priorPage) : null;
    const priorSigners = new Map<string, Hex0x>();
    for (const e of priorIndex?.events ?? []) if (e.creatorFeedSigner) priorSigners.set(e.eventId, e.creatorFeedSigner);

    // The events index STAYS platform-signed regardless of config ownership: it
    // carries per-event creatorFeedSigner values consumed on the claim/payment
    // path, so it must remain a server-written trust carrier (93ea980 class).
    const eventsIndex: SiteEventsIndex = {
      siteId: site.siteId,
      schemaVersion: SITE_SCHEMA_VERSION,
      events: await stampEventSigners(events, parentAddress, priorSigners),
      updatedAt: now,
    };

    if (siteFeedSigner) {
      const pointer: SitePointer = {
        _woco_site_ptr: 1,
        ownerAddress: parentAddress,
        siteFeedSigner: siteFeedSigner as Hex0x,
        updatedAt: now,
      };
      await Promise.all([
        writeFeedPage(configTopic, encodeJsonFeed(pointer), { dest: feedDest }),
        writeFeedPage(eventsTopic, encodeJsonFeed(eventsIndex), { dest: feedDest }),
      ]);
    } else {
      // Legacy platform-written path (client without a feed signer). Config
      // (without pages) + pages split across two feeds to stay under 4096 bytes.
      const siteToWrite: Site = {
        ...site,
        ownerAddress: parentAddress,
        createdAt: existing?.site.createdAt ?? now,
        updatedAt: now,
      };
      const { pages, ...siteShell } = siteToWrite;
      await Promise.all([
        writeFeedPage(configTopic, encodeJsonFeed(siteShell), { dest: feedDest }),
        writeFeedPage(pagesTopic,  encodeJsonFeed({ pages }), { dest: feedDest }),
        writeFeedPage(eventsTopic, encodeJsonFeed(eventsIndex), { dest: feedDest }),
      ]);
    }

    // Upsert into creator's site directory (fire-and-forget — non-fatal).
    upsertCreatorSite(parentAddress, {
      siteId: site.siteId,
      brandName: site.theme?.brandName || 'Untitled site',
      logoSwarmRef: site.theme?.logoSwarmRef,
      accentColor: site.theme?.palette?.accent ?? '#6366f1',
      publishedAt: now,
      ...(siteFeedSigner ? { siteFeedSigner: siteFeedSigner as Hex0x } : {}),
    } satisfies SiteDirectoryEntry).catch((e) =>
      console.warn("[sites/publish] creator directory upsert failed:", e)
    );

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
// GET /api/sites/mine — list creator's sites from Swarm directory (auth)
// Must be registered before /:id to avoid "mine" being treated as a siteId.
// ---------------------------------------------------------------------------

sitesRouter.get("/mine", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  try {
    const sites = await getCreatorSites(parentAddress);
    c.header("Cache-Control", "private, no-cache");
    return c.json({ ok: true, data: sites });
  } catch {
    return c.json({ ok: false, error: "Failed to read site directory" }, 500);
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
// Server-side cache for events-full — avoids hitting Swarm on every visitor request.
// TTL 5 min: fast for repeat visitors, stale-within-acceptable-window for organiser updates.
const _siteEventsFull = new Map<string, { data: { index: SiteEventsIndex; events: EventFeed[] }; expiresAt: number }>();
const SITE_EVENTS_FULL_TTL_MS = 5 * 60_000;

// GET /api/sites/:id/events-full — events index + full event details in one call (public)
// Reduces N+1 client round trips to a single request. Server fans out to Swarm in parallel.
// ---------------------------------------------------------------------------

sitesRouter.get("/:id/events-full", async (c) => {
  const siteId = c.req.param("id");
  try {
    const now = Date.now();
    const cached = _siteEventsFull.get(siteId);
    if (cached && cached.expiresAt > now) {
      c.header("Cache-Control", "public, max-age=300, stale-while-revalidate=86400");
      return c.json({ ok: true, data: cached.data });
    }

    const topic = Topic.fromString(siteEventsIndexTopic(siteId));
    const page = await readFeedPage(topic);

    const emptyIndex: SiteEventsIndex = { siteId, events: [], updatedAt: 0, schemaVersion: SITE_SCHEMA_VERSION };

    if (!page) {
      return c.json({ ok: true, data: { index: emptyIndex, events: [] } });
    }

    const index = decodeJsonFeed<SiteEventsIndex>(page);
    if (!index) return c.json({ ok: false, error: "Corrupt events index" }, 500);

    // Phase B: pass the carried content-feed signer so a CLIENT-OWNED event
    // resolves even when it's no longer in the global directory (e.g. unlisted).
    // Trusted carrier: this index was server-written + owner-gated.
    const results = await Promise.allSettled(
      index.events.map((entry) => getEvent(entry.eventId, entry.creatorFeedSigner))
    );

    const events: EventFeed[] = results
      .filter((r): r is PromiseFulfilledResult<EventFeed | null> => r.status === "fulfilled" && r.value !== null)
      .map((r) => r.value!);

    const data = { index, events };
    _siteEventsFull.set(siteId, { data, expiresAt: now + SITE_EVENTS_FULL_TTL_MS });
    c.header("Cache-Control", "public, max-age=300, stale-while-revalidate=86400");
    return c.json({ ok: true, data });
  } catch {
    return c.json({ ok: false, error: "Failed to read site events" }, 500);
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
      const priorSigners = new Map<string, Hex0x>();
      for (const e of index.events) if (e.creatorFeedSigner) priorSigners.set(e.eventId, e.creatorFeedSigner);
      const [entry] = await stampEventSigners([{
        eventId: body.eventId!,
        featured: body.featured ?? false,
        addedAt: Date.now(),
      }], parentAddress, priorSigners);
      index.events.push(entry);
    }
    index.updatedAt = Date.now();

    await writeFeedPage(topic, encodeJsonFeed(index), {
      dest: await siteFeedDestFromDirectory(parentAddress, siteId),
    });
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

    await writeFeedPage(topic, encodeJsonFeed(index), {
      dest: await siteFeedDestFromDirectory(parentAddress, siteId),
    });
    return c.json({ ok: true, data: index });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Failed to remove event" }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /api/sites/:id/contact — forward contact form submission (public)
// ---------------------------------------------------------------------------

sitesRouter.post("/:id/contact", async (c) => {
  const siteId = c.req.param("id");
  const ip = c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  const now = Date.now();
  const hits = (contactRateMap.get(ip) ?? []).filter((t) => now - t < CONTACT_RATE_WINDOW);
  if (hits.length >= CONTACT_RATE_LIMIT) {
    return c.json({ ok: false, error: "Too many requests. Please wait before trying again." }, 429);
  }

  try {
    const body = await c.req.json() as { name?: string; email?: string; message?: string };
    const name = body.name?.trim() ?? "";
    const email = body.email?.trim() ?? "";
    const message = body.message?.trim() ?? "";

    if (!name || !email || !message) {
      return c.json({ ok: false, error: "name, email and message are required" }, 400);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return c.json({ ok: false, error: "Invalid email address" }, 400);
    }

    const site = await readSiteConfig(siteId);
    if (!site) return c.json({ ok: false, error: "Site not found" }, 404);

    const contactSection = site.pages
      .flatMap((p) => p.sections)
      .find((s): s is ContactFormSection => s.type === "contactForm");
    if (!contactSection?.emailTo) {
      return c.json({ ok: false, error: "No contact email configured for this site" }, 404);
    }

    // Record hit only after validation passes
    contactRateMap.set(ip, [...hits, now]);

    const resend = getResend();
    const siteName = site.theme.brandName || siteId;
    await resend.emails.send({
      from: `"WoCo Contact Form" <${getFromAddress()}>`,
      to: [contactSection.emailTo],
      replyTo: [email],
      subject: `New enquiry from ${name} — ${siteName}`,
      html: buildContactHtml(name, email, message, siteName),
    });

    return c.json({ ok: true });
  } catch (err) {
    console.error("[sites/contact]", err);
    return c.json({ ok: false, error: "Failed to send. Please try again." }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /api/sites/:id/deploy — BZZ collection upload (auth, owner only)
// ---------------------------------------------------------------------------

sitesRouter.post("/:id/deploy", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const siteId = c.req.param("id");

  let tmpDir: string | null = null;
  let tarPath: string | null = null;

  try {
    const body = await c.req.json() as { apiUrl: string; gatewayUrl?: string; wocoAppUrl?: string; site?: Site; clientFeed?: boolean };
    const { apiUrl, gatewayUrl = "https://gateway.woco-net.com", wocoAppUrl = "https://woco.eth.limo" } = body;
    if (!apiUrl) return c.json({ ok: false, error: "apiUrl required" }, 400);

    if (!existsSync(DIST_MULTISITE_PATH)) {
      return c.json({
        ok: false,
        error: "Site template not on server. Run `npm run build:web` then rsync apps/web/dist-multisite/ to server.",
      }, 503);
    }

    // Prefer the site config sent by the client — avoids a Swarm re-read immediately
    // after publishSite (deferred writes can have a brief propagation window).
    // Fall back to Swarm read for direct API calls. Always stamp ownerAddress server-side.
    // Either way, an EXISTING siteId may only be deployed by its owner — without
    // this gate the body.site fast path would let any authenticated user overwrite
    // another site's woco-multisite feed and re-point its custom domains.
    const published = await resolveSiteConfig(siteId);
    if (published && published.site.ownerAddress.toLowerCase() !== parentAddress) {
      return c.json({ ok: false, error: "Not the site owner" }, 403);
    }
    let site: Site;
    if (body.site && body.site.siteId === siteId) {
      site = { ...body.site, ownerAddress: parentAddress };
    } else {
      if (!published) return c.json({ ok: false, error: "Site not found — publish first" }, 404);
      site = published.site;
    }

    let selection;
    try {
      selection = batchForDeploy({
        ownerAddress: parentAddress,
        gatewayUrl,
        deployType: "website",
        freeHostingEligible: await isVerifiedOrganiser(parentAddress),
      });
    } catch (err) {
      if (err instanceof BatchPurchaseRequired) {
        return c.json({ ok: false, error: err.message, code: "BATCH_PURCHASE_REQUIRED" }, 402);
      }
      if (err instanceof StripeVerificationRequired) {
        return c.json({ ok: false, error: err.message, code: "STRIPE_VERIFICATION_REQUIRED" }, 403);
      }
      throw err;
    }
    const { batchId, target } = selection;
    const signer = getPlatformSigner();
    const owner = getPlatformOwner();
    const bee = target === "etherna" ? getEthernaBee() : getBee();

    // Inject runtime config into the HTML template
    const htmlPath = join(DIST_MULTISITE_PATH, "multi-site.html");
    const html = await fs.readFile(htmlPath, "utf-8");
    // Event images are uploaded to WoCo Bee at event-creation time and are not
    // re-uploaded during site deploy. Inject contentGatewayUrl so the runtime
    // always fetches event images from WoCo Bee regardless of site host.
    const config: Record<string, unknown> = { site, gatewayUrl, apiUrl, wocoAppUrl };
    if (target === "etherna") config.contentGatewayUrl = "https://gateway.woco-net.com";
    const configScript = `<script>window.SITE_CONFIG=${JSON.stringify(config)};</script>`;
    const injectedHtml = html.replace("</head>", `  ${configScript}\n  </head>`);

    const ts = Date.now();
    tmpDir = `/tmp/woco-multisite-${ts}`;
    tarPath = `/tmp/woco-multisite-${ts}.tar`;

    // Build PWA manifest from site theme
    const manifest = {
      name: site.theme.brandName,
      short_name: site.theme.brandName,
      start_url: "./multi-site.html",
      display: "standalone",
      background_color: site.theme.palette.bg,
      theme_color: site.theme.palette.accent,
      icons: [
        { src: "./icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "./icon-512.png", sizes: "512x512", type: "image/png" },
      ],
    };

    // Build SEO + PWA head tags
    const desc = site.theme.siteDescription?.trim() ?? '';
    const brandNameEsc = escHtml(site.theme.brandName?.trim() || 'WoCo Site');
    const descEsc = escHtml(desc);
    const logoRef = site.theme.logoSwarmRef;
    // Organiser logo when set; WoCo brand image (always bundled in the collection) otherwise.
    const thumbnailUrl = logoRef && !/^0+$/.test(logoRef)
      ? `${gatewayUrl}/bytes/${logoRef}`
      : './logo.png';

    const headLines = [
      `  <link rel="manifest" href="./manifest.json">`,
      thumbnailUrl ? `  <link rel="icon" href="${thumbnailUrl}">` : '',
      `  <meta name="theme-color" content="${site.theme.palette.accent}">`,
      desc ? `  <meta name="description" content="${descEsc}">` : '',
      `  <meta property="og:type" content="website">`,
      `  <meta property="og:title" content="${brandNameEsc}">`,
      desc ? `  <meta property="og:description" content="${descEsc}">` : '',
      thumbnailUrl ? `  <meta property="og:image" content="${thumbnailUrl}">` : '',
      `  <meta name="twitter:card" content="${thumbnailUrl ? 'summary_large_image' : 'summary'}">`,
      `  <meta name="twitter:title" content="${brandNameEsc}">`,
      desc ? `  <meta name="twitter:description" content="${descEsc}">` : '',
      thumbnailUrl ? `  <meta name="twitter:image" content="${thumbnailUrl}">` : '',
    ].filter(Boolean).join('\n');

    const injectedWithPwa = injectedHtml.replace("</head>", `${headLines}\n  </head>`);

    await fs.cp(DIST_MULTISITE_PATH, tmpDir, { recursive: true });
    await fs.writeFile(join(tmpDir, "multi-site.html"), injectedWithPwa, "utf-8");
    await fs.writeFile(join(tmpDir, "manifest.json"), JSON.stringify(manifest), "utf-8");

    // Copy embed bundle so ./woco-embed.js resolves within the collection
    const embedSrc = resolve(__dirname, "../../../../packages/embed/dist/woco-embed.js");
    if (existsSync(embedSrc)) {
      await fs.copyFile(embedSrc, join(tmpDir, "woco-embed.js"));
    }

    await spawnPromise("tar", ["-cf", tarPath, "-C", tmpDir, "."]);
    const tarData = await fs.readFile(tarPath);

    // Free-hosted deploys share the platform batch, so cap what each owner can
    // put on it. Checked against the storage ledger BEFORE spending postage.
    // This site's own current deploy is excluded — the new tar supersedes it.
    if (selection.freeHosted) {
      const used = getFreeHostedBytes(parentAddress, { excludeSite: siteId });
      if (used + tarData.length > FREE_HOSTING_QUOTA_BYTES) {
        const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
        return c.json({
          ok: false,
          error: `Free hosting quota exceeded: ${mb(used)}MB used + ${mb(tarData.length)}MB deploy > ${mb(FREE_HOSTING_QUOTA_BYTES)}MB limit. Purchase your own storage batch to continue.`,
          code: "FREE_HOSTING_QUOTA_EXCEEDED",
        }, 413);
      }
    }

    let contentHash: string;
    if (target === "etherna") {
      contentHash = await uploadCollectionToEtherna({
        batchId,
        tarData,
        indexDocument: "multi-site.html",
      });
      await registerEthernaOffer(contentHash);
    } else {
      const uploadResp = await fetch(`${BEE_URL}/bzz`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-tar",
          "Swarm-Postage-Batch-Id": batchId,
          "Swarm-Index-Document": "multi-site.html",
          "Swarm-Error-Document": "multi-site.html",
          "Swarm-Collection": "true",
        },
        // @ts-ignore — Node 18 fetch doesn't expose duplex in type defs
        duplex: "half",
        body: tarData,
        signal: AbortSignal.timeout(BEE_COLLECTION_TIMEOUT_MS),
      });

      if (!uploadResp.ok) {
        const text = await uploadResp.text().catch(() => "");
        throw new Error(`Swarm upload failed ${uploadResp.status}: ${text.slice(0, 300)}`);
      }

      ({ reference: contentHash } = await uploadResp.json() as { reference: string });
    }

    // Every deploy lands in the storage ledger regardless of batch: it is both
    // the quota meter and the per-owner migration manifest (re-stamp walks it).
    recordUpload(parentAddress, {
      ref: contentHash,
      bytes: tarData.length,
      kind: "site-deploy",
      batchId,
      target,
      note: siteId,
      ...(selection.freeHosted ? { freeHosted: true } : {}),
    });

    // Per-site feed so an ENS name / custom domain can point at it
    const topicString = multisiteFeedTopic(siteId);
    const topic = Topic.fromString(topicString);
    let feedManifestHash = "";
    // Client-owned pointer feed (set when the CLIENT will sign the update).
    let multisiteFeed: { nextIndex: number; rootChunkPayloadB64: string } | null = null;

    // The pointer feed is CLIENT-OWNED when the site config is (siteFeedSigner
    // resolved from the server-written pointer — never the request) AND the
    // frontend declared it will sign the update (`clientFeed`; an old bundle
    // that can't sign must keep the platform-signed feed, else the new manifest
    // would point at a feed with no updates). Both targets: Etherna is the
    // production path, so client ownership must hold there first of all.
    const feedOwnerSigner = body.clientFeed ? published?.siteFeedSigner : undefined;

    if (feedOwnerSigner && target === "etherna") {
      // Same steps as the platform-signed Etherna write, minus signing — the
      // client signs the update SOC and pushes it via /api/swarm/soc (which
      // routes to the same Etherna user batch).
      const prep = await prepareEthernaFeedUpdate({
        topic,
        contentHash,
        batchId,
        ownerHex: feedOwnerSigner.replace(/^0x/, ""),
      });
      feedManifestHash = prep.feedManifestHash;
      multisiteFeed = {
        nextIndex: Number(prep.nextIndex),
        rootChunkPayloadB64: Buffer.from(prep.chunkBytes.subarray(8)).toString("base64"),
      };
    } else if (feedOwnerSigner) {
      try {
        const mRef = await withTimeout(
          bee.createFeedManifest(batchId, topic, feedOwnerSigner),
          BEE_CALL_TIMEOUT_MS,
          "multisite feed manifest (client-owned)",
        );
        feedManifestHash = mRef.toString();
      } catch {
        // Non-fatal — /bzz/{contentHash}/ still works; domains fall back next deploy.
      }
      // Hand the update material back for the client to sign: the collection
      // root chunk's data (span stripped — a chunk's data is ≤4096 B, matching
      // bee-js uploadPayload's wrapped-chunk form) + the feed's next index.
      const chunkRes = await fetch(`${BEE_URL}/chunks/${contentHash}`, {
        signal: AbortSignal.timeout(BEE_CALL_TIMEOUT_MS),
      });
      if (chunkRes.ok) {
        const chunkBytes = new Uint8Array(await chunkRes.arrayBuffer());
        let nextIndex = 0;
        try {
          const latest = await withTimeout(
            bee.makeFeedReader(topic, feedOwnerSigner).download(),
            BEE_CALL_TIMEOUT_MS,
            "multisite feed index",
          );
          if (latest.feedIndexNext) nextIndex = Number(BigInt(`0x${latest.feedIndexNext.toHex()}`));
        } catch {
          // No update yet (fresh feed) — index 0.
        }
        multisiteFeed = {
          nextIndex,
          rootChunkPayloadB64: Buffer.from(chunkBytes.subarray(8)).toString("base64"),
        };
      } else {
        console.warn(`[sites/deploy] root chunk fetch ${chunkRes.status} — client feed update skipped`);
      }
    } else if (target === "etherna") {
      // Etherna's Beehive only resolves feeds written with inline SOC (uploadPayload).
      // writeEthernaFeedUpdate bypasses bee-js auth issues and uses raw HTTP with
      // the correct inline-chunk SOC format (confirmed by etherna-soc-legacy-probe.ts).
      feedManifestHash = await writeEthernaFeedUpdate({
        topic,
        contentHash,
        batchId,
        signer,
        ownerHex: owner.toHex(),
      });
    } else {
      // WoCo Bee — inline SOC write; fall back to uploadReference if root chunk
      // exceeds 4096B (unlikely for a site manifest but handled defensively).
      try {
        const mRef = await withTimeout(
          bee.createFeedManifest(batchId, topic, owner),
          BEE_CALL_TIMEOUT_MS,
          "multisite feed manifest",
        );
        feedManifestHash = mRef.toString();
      } catch {
        // Non-fatal
      }
      const writer = bee.makeFeedWriter(topic, signer);
      try {
        await whitelistHashes([contentHash]).catch(() => {});
        const chunkRes = await fetch(`${BEE_URL}/chunks/${contentHash}`, {
          signal: AbortSignal.timeout(BEE_CALL_TIMEOUT_MS),
        });
        if (!chunkRes.ok) throw new Error(`fetch root chunk ${chunkRes.status}`);
        const chunkBytes = new Uint8Array(await chunkRes.arrayBuffer());
        const payload = chunkBytes.subarray(8);
        if (payload.length > 4096) {
          console.warn(`[sites/deploy] root chunk ${payload.length}B > 4096 — falling back to legacy SOC write`);
          await withTimeout(
            writer.uploadReference(batchId, new Reference(contentHash)),
            BEE_CALL_TIMEOUT_MS,
            "multisite feed write (legacy)",
          );
        } else {
          await withTimeout(
            writer.uploadPayload(batchId, payload),
            BEE_CALL_TIMEOUT_MS,
            "multisite feed write (inline)",
          );
        }
      } catch (err) {
        console.warn(`[sites/deploy] inline SOC write failed (${(err as Error).message}) — falling back to legacy`);
        await withTimeout(
          writer.uploadReference(batchId, new Reference(contentHash)),
          BEE_CALL_TIMEOUT_MS,
          "multisite feed write (legacy fallback)",
        );
      }
    }

    // Etherna gates anonymous reads behind an OFFER. The content chunk is offered at
    // upload and each feed UPDATE SOC is offered by its writer; the FEED MANIFEST
    // must be offered too or the ENS/domain link `/bzz/{feedManifestHash}/` returns
    // 402 for anonymous readers. Non-fatal (a missing offer only affects anon reads).
    // NOTE: whether anonymous /bzz feed-dereference fully resolves after offering the
    // manifest + update SOC still needs a live post-deploy probe on Beehive
    // (see etherna-soc-legacy-probe.ts); if it 402s, the link format must fall back
    // to `/bzz/{contentHash}/` with the feed hash reserved for ENS contenthash only.
    if (target === "etherna" && feedManifestHash) {
      void registerEthernaOffer(feedManifestHash).catch((e) =>
        console.warn("[sites/deploy] etherna feed-manifest offer failed (non-fatal):", e));
    }

    // Collect all image refs from the site so they're accessible via the gateway.
    const imageRefs: string[] = [];
    if (site.theme.logoSwarmRef && !/^0+$/.test(site.theme.logoSwarmRef)) imageRefs.push(site.theme.logoSwarmRef);
    for (const page of site.pages ?? []) {
      for (const sec of page.sections ?? []) {
        if (sec.type === 'hero' && sec.bgImageRef && !/^0+$/.test(sec.bgImageRef)) imageRefs.push(sec.bgImageRef);
        if (sec.type === 'gallery') {
          for (const img of sec.images ?? []) {
            if (img.ref && !/^0+$/.test(img.ref)) imageRefs.push(img.ref);
          }
        }
        if (sec.type === 'image' && sec.ref && !/^0+$/.test(sec.ref)) imageRefs.push(sec.ref);
      }
    }

    // Whitelist BZZ hash, feed manifest, and all image refs on the gateway.
    // Fire-and-forget — whitelist failure must not block the deploy response.
    const hashesToWhitelist = [contentHash, feedManifestHash, ...imageRefs].filter(Boolean);
    void whitelistHashes(hashesToWhitelist).catch((e) =>
      console.warn("[sites/deploy] whitelist call failed:", e),
    );

    const siteUrl = `${gatewayUrl}/bzz/${contentHash}/`;

    // Auto-update sub-ENS contenthash if the site has a claimed label (fire-and-forget).
    if (site.subEnsLabel) {
      const label = site.subEnsLabel;
      (async () => {
        try {
          const owner = await getLabelOwner(label);
          if (owner && owner === parentAddress.toLowerCase()) {
            await updateSubEnsContenthash(label, contentHash);
            console.log(`[sites/deploy] sub-ens ${label}.woco.eth → ${contentHash.slice(0, 10)}…`);
          }
        } catch (e) {
          console.warn("[sites/deploy] sub-ens contenthash update failed:", e);
        }
      })();
    }

    // Auto-update any custom domains registered for this site (fire-and-forget).
    updateDomainsForSite(siteId, contentHash, feedManifestHash).catch((e) =>
      console.warn("[sites/deploy] domain auto-update failed:", e)
    );

    // Update creator directory with feedHash + deployedUrl (fire-and-forget).
    upsertCreatorSite(parentAddress, {
      siteId,
      brandName: site.theme?.brandName || 'Untitled site',
      logoSwarmRef: site.theme?.logoSwarmRef,
      accentColor: site.theme?.palette?.accent ?? '#6366f1',
      feedHash: feedManifestHash || undefined,
      deployedUrl: siteUrl,
      publishedAt: Date.now(),
    } satisfies SiteDirectoryEntry).catch((e) =>
      console.warn("[sites/deploy] creator directory upsert failed:", e)
    );

    return c.json({
      ok: true,
      data: {
        contentHash,
        feedManifestHash,
        siteUrl,
        // Present only when the pointer feed is client-owned: the caller signs
        // the sequence-feed update SOC (beeFeedUpdateIdentifier) with this.
        ...(multisiteFeed ? { multisiteFeed } : {}),
      },
    });

  } catch (e) {
    console.error("[sites/deploy]", e);
    return c.json({ ok: false, error: e instanceof Error ? e.message : "Deploy failed" }, 500);
  } finally {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    if (tarPath) await fs.unlink(tarPath).catch(() => {});
  }
});

export { sitesRouter };
