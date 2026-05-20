import { Hono } from "hono";
import { Topic, Reference } from "@ethersphere/bee-js";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { requireAuth } from "../middleware/auth.js";
import { getEvent } from "../lib/event/service.js";
import { getCreatorSites, upsertCreatorSite } from "../lib/site/service.js";
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
  PROXY_URL,
  UPLOAD_SECRET,
  POSTAGE_BATCH_ID,
} from "../config/swarm.js";
import { batchForDeploy, BatchPurchaseRequired } from "../lib/etherna/batch-router.js";
import { getEthernaBee, uploadCollectionToEtherna, registerEthernaOffer, writeEthernaFeedUpdate } from "../lib/etherna/upload.js";
import { ensureEthernaToken, getCachedEthernaToken } from "../lib/etherna/auth.js";
import { getUserBatch } from "../lib/etherna/batches.js";
import {
  siteConfigTopic,
  sitePagesTopicFn,
  siteEventsIndexTopic,
  SITE_SCHEMA_VERSION,
} from "@woco/shared";
import type { Site, Page, SiteEventsIndex, SiteEventEntry, SiteDirectoryEntry, ContactFormSection, EventFeed } from "@woco/shared";
import { getResend, getFromAddress } from "../lib/email/client.js";
import { uploadToBytes } from "../lib/swarm/bytes.js";

const sitesRouter = new Hono();

const __dirname = dirname(fileURLToPath(import.meta.url));
const ETHERNA_GW = process.env.ETHERNA_GATEWAY_URL || "https://gateway.etherna.io";

function isEthernaUrl(url: string): boolean {
  try { return new URL(url).host.endsWith(new URL(ETHERNA_GW).host); } catch { return false; }
}
const DIST_MULTISITE_PATH = resolve(__dirname, "../../../../apps/web/dist-multisite");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readSiteConfig(siteId: string): Promise<Site | null> {
  const configTopic = Topic.fromString(siteConfigTopic(siteId));
  const pagesTopic = Topic.fromString(sitePagesTopicFn(siteId));
  const [configPage, pagesPage] = await Promise.all([
    readFeedPage(configTopic),
    readFeedPage(pagesTopic),
  ]);
  if (!configPage) return null;
  const site = decodeJsonFeed<Site>(configPage);
  if (!site) return null;
  // Pages may be in their own feed (split to stay under 4096 bytes)
  if (pagesPage) {
    const pagesData = decodeJsonFeed<{ pages: Page[] }>(pagesPage);
    if (pagesData?.pages) site.pages = pagesData.pages;
  }
  return site;
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

    if (isEthernaUrl(body.gatewayUrl ?? "")) {
      const userBatch = getUserBatch(parentAddress);
      if (!userBatch) {
        return c.json({ ok: false, error: "No Etherna batch — purchase one first (click Publish)", code: "BATCH_PURCHASE_REQUIRED" }, 402);
      }
      await ensureEthernaToken();
      const token = getCachedEthernaToken();
      const resp = await fetch(`${ETHERNA_GW}/bytes`, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "Swarm-Postage-Batch-Id": userBatch.batchId,
          Authorization: `Bearer ${token}`,
        },
        // @ts-ignore — Node 18 fetch duplex
        duplex: "half",
        body: bytes,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`Etherna /bytes upload ${resp.status}: ${text.slice(0, 200)}`);
      }
      const { reference } = await resp.json() as { reference: string };
      await registerEthernaOffer(reference);
      return c.json({ ok: true, data: { imageRef: reference } });
    }

    const imageRef = await uploadToBytes(bytes);
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

    // Write config (without pages) + pages + events to separate feeds concurrently.
    // Pages are split into woco/site/pages/{siteId} so the config feed stays under
    // the 4096-byte Swarm chunk limit even for content-rich sites.
    const configTopic = Topic.fromString(siteConfigTopic(site.siteId));
    const pagesTopic  = Topic.fromString(sitePagesTopicFn(site.siteId));
    const eventsTopic = Topic.fromString(siteEventsIndexTopic(site.siteId));

    const { pages, ...siteShell } = siteToWrite;

    const eventsIndex: SiteEventsIndex = {
      siteId: site.siteId,
      schemaVersion: SITE_SCHEMA_VERSION,
      events,
      updatedAt: now,
    };

    await Promise.all([
      writeFeedPage(configTopic, encodeJsonFeed(siteShell)),
      writeFeedPage(pagesTopic,  encodeJsonFeed({ pages })),
      writeFeedPage(eventsTopic, encodeJsonFeed(eventsIndex)),
    ]);

    // Upsert into creator's site directory (fire-and-forget — non-fatal).
    upsertCreatorSite(parentAddress, {
      siteId: site.siteId,
      brandName: site.theme?.brandName || 'Untitled site',
      logoSwarmRef: site.theme?.logoSwarmRef,
      accentColor: site.theme?.palette?.accent ?? '#6366f1',
      publishedAt: now,
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

    const results = await Promise.allSettled(
      index.events.map((entry) => getEvent(entry.eventId))
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
    const body = await c.req.json() as { apiUrl: string; gatewayUrl?: string; wocoAppUrl?: string; site?: Site };
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
    let site: Site;
    if (body.site && body.site.siteId === siteId) {
      site = { ...body.site, ownerAddress: parentAddress };
    } else {
      const fromSwarm = await readSiteConfig(siteId);
      if (!fromSwarm) return c.json({ ok: false, error: "Site not found — publish first" }, 404);
      if (fromSwarm.ownerAddress.toLowerCase() !== parentAddress) {
        return c.json({ ok: false, error: "Not the site owner" }, 403);
      }
      site = fromSwarm;
    }

    let selection;
    try {
      selection = batchForDeploy({
        ownerAddress: parentAddress,
        gatewayUrl,
        deployType: "website",
      });
    } catch (err) {
      if (err instanceof BatchPurchaseRequired) {
        return c.json({ ok: false, error: err.message, code: "BATCH_PURCHASE_REQUIRED" }, 402);
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
      });

      if (!uploadResp.ok) {
        const text = await uploadResp.text().catch(() => "");
        throw new Error(`Swarm upload failed ${uploadResp.status}: ${text.slice(0, 300)}`);
      }

      ({ reference: contentHash } = await uploadResp.json() as { reference: string });
    }

    // Per-site feed so an ENS name can point at it
    const topic = Topic.fromString(`woco-multisite-${siteId}`);
    let feedManifestHash = "";

    if (target === "etherna") {
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
        const mRef = await bee.createFeedManifest(batchId, topic, owner);
        feedManifestHash = mRef.toString();
      } catch {
        // Non-fatal
      }
      const writer = bee.makeFeedWriter(topic, signer);
      try {
        await fetch(`${PROXY_URL}/admin/whitelist`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-upload-secret": UPLOAD_SECRET },
          body: JSON.stringify({ hashes: [contentHash] }),
        });
        const chunkRes = await fetch(`${BEE_URL}/chunks/${contentHash}`);
        if (!chunkRes.ok) throw new Error(`fetch root chunk ${chunkRes.status}`);
        const chunkBytes = new Uint8Array(await chunkRes.arrayBuffer());
        const payload = chunkBytes.subarray(8);
        if (payload.length > 4096) {
          console.warn(`[sites/deploy] root chunk ${payload.length}B > 4096 — falling back to legacy SOC write`);
          await writer.uploadReference(batchId, new Reference(contentHash));
        } else {
          await writer.uploadPayload(batchId, payload);
        }
      } catch (err) {
        console.warn(`[sites/deploy] inline SOC write failed (${(err as Error).message}) — falling back to legacy`);
        await writer.uploadReference(batchId, new Reference(contentHash));
      }
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
    fetch(`${PROXY_URL}/admin/whitelist`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-upload-secret": UPLOAD_SECRET },
      body: JSON.stringify({ hashes: hashesToWhitelist }),
    }).catch((e) => console.warn("[sites/deploy] whitelist call failed:", e));

    const siteUrl = `${gatewayUrl}/bzz/${contentHash}/`;

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
