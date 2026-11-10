import { AccountKeysChangedError, AccountKeysUnavailableError, assertCurrentKeys } from "../lib/keyring/event-keys.js";
import { Hono } from "hono";
import type { Context } from "hono";
import { FeedIndex, Topic, Reference } from "@ethersphere/bee-js";
import { requireAuth } from "../middleware/auth.js";
import { cancellationGate } from "../lib/event/cancellations.js";
import { getEvent, getCreatorEvents } from "../lib/event/service.js";
import { getCreatorSites, upsertCreatorSite, resolveSiteConfig, resolveSiteConfigOrNull } from "../lib/site/service.js";
import { siteRuntimeReleases } from "../lib/site/runtime-release.js";
import {
  escapeHtmlAttribute as escHtml,
  resolveDeployUrls,
  isSafeIdParam,
} from "../lib/site/deploy-config.js";
import type { SiteRuntimeStore } from "@woco/shared";
import {
  admitClientCollection,
  decodeClientCollection,
  serveRuntimeKit,
  siteRuntimeKits,
  storeForTarget,
  uploadSiteObjects,
  deployStore,
  storeFeedManifest,
  collectionRootChunk,
  type SiteRuntimeKit,
} from "../lib/site/collection-publish.js";
import { updateDomainsForSite } from "../lib/domains/service.js";
import {
  readFeedPage,
  writeFeedPage,
  encodeJsonFeed,
  decodeJsonFeed,
  resolveFeedNextIndex,
} from "../lib/swarm/feeds.js";
import {
  getBee,
  getPlatformSigner,
  getPlatformOwner,
  BEE_URL,
} from "../config/swarm.js";
import { batchForDeploy, BatchPurchaseRequired, PlatformBatchUnavailable, StripeVerificationRequired, hasLiveUserBatch, type BatchSelection } from "../lib/etherna/batch-router.js";
import { routeSave } from "../lib/etherna/failover.js";
import { isVerifiedOrganiser, refuseUnlessVerifiedOrganiser } from "../lib/stripe/verification.js";
import { recordUpload, getFreeHostedBytes } from "../lib/swarm/storage-ledger.js";

/** Per-owner byte cap for free-hosted (shared platform batch) website deploys.
 *  Quota counts each site's LATEST deploy only (republish supersedes — see
 *  storage-ledger.ts). A site links the shared runtime (#1032), so a deploy is a
 *  few KB of its own and the cap now meters the site's own objects only. */
const FREE_HOSTING_QUOTA_BYTES = Number(process.env.FREE_HOSTING_QUOTA_BYTES) || 100 * 1024 * 1024;
import { registerEthernaOffer } from "../lib/etherna/upload.js";
import { writeEthernaFeedUpdate } from "../lib/etherna/soc-send.js";
import { feedIndexUnavailableBody, isStorageBusy, storageBusyBody, STORAGE_BUSY_RETRY_AFTER_HEADER } from "../lib/swarm/storage-busy.js";
import { beginDeploy, CLIENT_POINTER_HOLD_MS, DEPLOY_IN_PROGRESS_CODE, DEPLOY_IN_PROGRESS_MESSAGE } from "../lib/site/deploy-guard.js";
import {
  siteConfigTopic,
  sitePagesTopicFn,
  siteEventsIndexTopic,
  multisiteFeedTopic,
  SITE_SCHEMA_VERSION,
  validateLabel,
} from "@woco/shared";
import type { Site, SitePointer, SiteEventsIndex, SiteEventEntry, SiteDirectoryEntry, ContactFormSection, EventFeed, EventDirectoryEntry, Hex0x } from "@woco/shared";
import { getFromAddress } from "../lib/email/client.js";
import { sendEmail } from "../lib/email/send.js";
import { uploadToBytes } from "../lib/swarm/bytes.js";
import { whitelistHashes } from "../lib/swarm/whitelist.js";
import { checkSiteSubEns, type SiteDeploySubEns } from "../lib/sub-ens/site-pointer.js";
import { recordNameTarget } from "../lib/sub-ens/name-targets.js";
import { BEE_CALL_TIMEOUT_MS, withTimeout } from "../lib/swarm/upload-queue.js";
import { clientIp } from "../lib/http/client-ip.js";
import { companyFooterHtml } from "../lib/email/company-footer.js";
import { freshWrittenEventsIndex, readEventsIndexForWrite, rememberWrittenEventsIndex, withEventsIndexLock } from "../lib/site/events-index.js";
import { SWARM_CHUNK_MAX_BYTES, readCapped } from "../lib/http/read-capped.js";

const sitesRouter = new Hono();

/** What an app from before browser-built sites sees (#1032 slice 4). */
const CLIENT_BUILD_REQUIRED_MESSAGE = "This version of the app can no longer publish websites - reload the page to update it, then publish again.";

/** The kit a deploy builds against: the held release's, for the deploy's store. */
async function liveRuntimeKit(store: SiteRuntimeStore): Promise<SiteRuntimeKit | null> {
  const release = await siteRuntimeReleases.get();
  if (!release) return null;
  return siteRuntimeKits.kit(release, "site", store).catch((e: unknown) => {
    console.warn(`[sites/deploy] site runtime kit unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  });
}
let runtimeKitFor = liveRuntimeKit;

/** Tests only — build against a kit of the test's own. */
export const __sitesDeployTestHooks = {
  setRuntimeKit(kit: ((store: SiteRuntimeStore) => Promise<SiteRuntimeKit | null>) | null): void {
    runtimeKitFor = kit ?? liveRuntimeKit;
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Config read for DISPLAY routes — follows the client-owned pointer (see
 * service.ts). Collapses "absent" and "unavailable" into null, which is right for
 * a page that renders nothing and wrong for anything deciding ownership. Every
 * ownership decision in this file (publish, deploy, event add and remove) reads
 * `resolveSiteConfig` directly for that reason.
 */
async function readSiteConfig(siteId: string): Promise<Site | null> {
  return (await resolveSiteConfigOrNull(siteId))?.site ?? null;
}

/**
 * The first save of a new site met bee's one-minute skip list on a feed nobody
 * has written (`swarm/storage-busy.ts`, #943). Typed, so the builder waits
 * `retryAfterMs` and sends the same request once more by itself.
 */
function storageBusy(c: Context) {
  c.header("Retry-After", STORAGE_BUSY_RETRY_AFTER_HEADER);
  return c.json(storageBusyBody(), 503);
}

/** An edit is refused rather than built on an index we could not read (events-index.ts). */
const EVENTS_INDEX_UNREADABLE = "Could not read this site's events right now - please try again";

/**
 * Event add/remove: only the owner of an EXISTING site may change its index. A
 * read that cannot decide is a retryable 503, not "Site not found" (#217).
 */
async function eventIndexOwnerRefusal(
  siteId: string,
  parentAddress: string,
): Promise<{ status: 403 | 404 | 503; error: string } | null> {
  const read = await resolveSiteConfig(siteId);
  if (read.status === "unavailable") {
    console.warn(`[sites/events] ownership undecidable for ${siteId}: ${read.reason}`);
    return { status: 503, error: "Could not verify site ownership right now — please try again" };
  }
  if (read.status === "absent") return { status: 404, error: "Site not found" };
  if (read.site.ownerAddress.toLowerCase() !== parentAddress) return { status: 403, error: "Not the site owner" };
  return null;
}

/** Where a deploy's pointer update goes, resolved before its upload (#943). */
type PointerPlan = { rail: "etherna" | "woco"; nextIndex: bigint };

/** The SEO + PWA head tags baked into a deployed site: now in packages/shared (#1032 slice 2). */
export { deployHeadLines } from "@woco/shared";

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
 * feed routing is an optimisation of postage lifetime, never publish-blocking —
 * EXCEPT a dead platform batch (#610). With the Etherna failover able to take the
 * pages (`routeSave`, #912) they go ahead: each is listed and stamped on WoCo, its
 * feed still resolved over both stores, and moved back. Otherwise it refuses: a
 * page on WoCo with nothing listing it would never move back, and a WoCo-only
 * index could fork the feed across the two nodes. Every write to a dest from here
 * passes `failover: { parent }` (`siteFeedWrite`).
 */
function siteFeedDest(ownerAddress: string, gatewayUrl: string | undefined): BatchSelection | undefined {
  if (!gatewayUrl) return undefined;
  try {
    const sel = routeSave(() => batchForDeploy({ ownerAddress, gatewayUrl, deployType: "event" }));
    return sel.target === "etherna" ? sel : undefined;
  } catch (e) {
    if (e instanceof PlatformBatchUnavailable) throw e;
    console.warn("[sites] feed batch routing failed — WoCo batch fallback:", (e as Error).message);
    return undefined;
  }
}

/** How a site's platform-written page is written: its dest, failing over to WoCo for the owner's batch. */
function siteFeedWrite(ownerAddress: string, dest: BatchSelection | undefined): { dest?: BatchSelection; failover?: { parent: string } } {
  return dest ? { dest, failover: { parent: ownerAddress } } : {};
}

/** Resolve the site's home gateway from the owner's directory entry (the
 *  deployedUrl carries the gateway host) — for endpoints that rewrite site
 *  feeds without a client gateway signal (add/remove event). */
async function siteFeedDestFromDirectory(ownerAddress: string, siteId: string): Promise<BatchSelection | undefined> {
  try {
    const sites = await getCreatorSites(ownerAddress);
    return siteFeedDest(ownerAddress, sites.find((s) => s.siteId === siteId)?.deployedUrl);
  } catch (e) {
    if (e instanceof PlatformBatchUnavailable) throw e;
    return undefined;
  }
}


export function buildContactHtml(name: string, email: string, message: string, siteName: string): string {
  return `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;max-width:600px;margin:40px auto;padding:0 20px;color:#111">
<h2 style="margin:0 0 1.5rem">New enquiry — ${escHtml(siteName)}</h2>
<table style="border-collapse:collapse;width:100%">
<tr><td style="padding:8px 0;color:#666;width:80px;vertical-align:top">Name</td><td style="padding:8px 0;font-weight:600">${escHtml(name)}</td></tr>
<tr><td style="padding:8px 0;color:#666;vertical-align:top">Email</td><td style="padding:8px 0"><a href="mailto:${escHtml(email)}">${escHtml(email)}</a></td></tr>
<tr><td style="padding:8px 0;color:#666;vertical-align:top">Message</td><td style="padding:8px 0;white-space:pre-wrap">${escHtml(message)}</td></tr>
</table>
<p style="color:#999;font-size:0.8rem;margin:2rem 0 0">Sent via WoCo contact form</p>
${companyFooterHtml("#999")}
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

/**
 * Website storage is for Stripe-verified organisers, or accounts paying for
 * their own Etherna batch - on EVERY gateway. The router's free-hosting check
 * covers only the Etherna fallback; a request naming the WoCo gateway (or none)
 * used to reach the WoCo batch with no check at all, a whole site bundle per
 * deploy. Checked before anything is stored (owner decision 2026-10-02).
 */
async function websiteStorageRefusal(parentAddress: string): Promise<{ ok: false; error: string; code: string } | null> {
  if (hasLiveUserBatch(parentAddress)) return null;
  return refuseUnlessVerifiedOrganiser(parentAddress, new StripeVerificationRequired().message);
}

sitesRouter.post("/upload-image", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const refusal = await websiteStorageRefusal(parentAddress);
  if (refusal) return c.json(refusal, 403);
  try {
    const body = await c.req.json() as { image?: string; gatewayUrl?: string };
    if (!body.image || typeof body.image !== "string") {
      return c.json({ ok: false, error: "Missing image data" }, 400);
    }

    const raw = body.image.includes(",") ? body.image.split(",")[1] : body.image;
    const bytes = Uint8Array.from(atob(raw), (ch) => ch.charCodeAt(0));

    if (bytes.length === 0) return c.json({ ok: false, error: "Image is empty" }, 400);
    if (bytes.length > 4 * 1024 * 1024) {
      return c.json({ ok: false, error: "Image too large (max 4MB)" }, 400);
    }

    // Same routing + gates as the site deploy itself: user batch when live,
    // free-hosting platform-batch fallback (Stripe-verified, quota-metered)
    // otherwise. Site images are site bytes — letting them bypass the quota
    // would leave the deploy gate meterable around.
    // With the Etherna failover (#912): a batch the chain refuses still takes the
    // image (stamped on WoCo, moved back), and the quota below meters the batch it
    // is meant for.
    let selection;
    try {
      const freeHostingEligible = await isVerifiedOrganiser(parentAddress);
      selection = routeSave(() =>
        batchForDeploy({ ownerAddress: parentAddress, gatewayUrl: body.gatewayUrl ?? "", deployType: "website", freeHostingEligible }),
      );
    } catch (err) {
      if (err instanceof BatchPurchaseRequired) {
        return c.json({ ok: false, error: err.message, code: "BATCH_PURCHASE_REQUIRED" }, 402);
      }
      if (err instanceof StripeVerificationRequired) {
        return c.json({ ok: false, error: err.message, code: "STRIPE_VERIFICATION_REQUIRED" }, 403);
      }
      if (err instanceof PlatformBatchUnavailable) return c.json({ ok: false, error: err.message, code: err.code }, 503);
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

    const imageRef = await uploadToBytes(bytes, selection, { failover: { parent: parentAddress } });
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
    if (err instanceof PlatformBatchUnavailable) return c.json({ ok: false, error: err.message, code: err.code }, 503);
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
  const refusal = await websiteStorageRefusal(parentAddress);
  if (refusal) return c.json(refusal, 403);

  try {
    const body = await c.req.json() as { site?: Site; events?: SiteEventEntry[]; siteFeedSigner?: string; gatewayUrl?: string };
    if (!body?.site?.siteId) {
      return c.json({ ok: false, error: "Invalid site data" }, 400);
    }
    // The SAME shape guard the read/deploy routes below now apply. Without it
    // this PR would create the asymmetry it exists to close: an id that only has
    // to be PRESENT here, but must be well-formed everywhere else, makes a
    // malformed site creatable and then permanently unreadable and undeployable
    // through every guarded route. The guard belongs at the point the id enters
    // the system, not only where it is used (#213).
    if (!isSafeIdParam(body.site.siteId)) {
      return c.json({ ok: false, error: "siteId is malformed" }, 400);
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
    // The account's CURRENT signer only (#186): a device that has not taken the keys of
    // a removal yet would point the site at a signer readers no longer follow.
    if (siteFeedSigner) {
      try {
        await assertCurrentKeys(parentAddress, siteFeedSigner, undefined);
      } catch (e) {
        if (e instanceof AccountKeysChangedError) return c.json({ ok: false, error: e.message, code: e.code }, 409);
        if (e instanceof AccountKeysUnavailableError) return c.json({ ok: false, error: e.message, code: e.code }, 503);
        throw e;
      }
    }

    // If an existing site is published, only the owner may overwrite it.
    //
    // Three answers, and only ONE of them permits the write (#181). "absent" means
    // the network found no site (the best answer a read can give: see service.ts).
    // "unavailable" means we could not find out
    // — and proceeding on that is what let a caller be stamped owner of somebody
    // else's site by retrying until a Swarm read failed.
    const existing = await resolveSiteConfig(site.siteId);
    if (existing.status === "unavailable") {
      console.warn(`[sites/publish] ownership undecidable for ${site.siteId}: ${existing.reason}`);
      if (isStorageBusy(existing.cause)) return storageBusy(c);
      return c.json({
        ok: false,
        error: "Could not verify site ownership right now — please try again",
      }, 503);
    }
    if (existing.status === "found" && existing.site.ownerAddress.toLowerCase() !== parentAddress) {
      return c.json({ ok: false, error: "Not the site owner" }, 403);
    }

    const now = Date.now();

    const configTopic = Topic.fromString(siteConfigTopic(site.siteId));
    const pagesTopic  = Topic.fromString(sitePagesTopicFn(site.siteId));
    const eventsTopic = Topic.fromString(siteEventsIndexTopic(site.siteId));

    // Prior server-written signers (trusted) — carried forward if a source read
    // transiently fails so a re-publish never wipes a known carrier.
    // Under the site's events lock (Fable on #824): an add that started before
    // this publish recorded its index would otherwise build on the older copy
    // and silently drop the published list.
    await withEventsIndexLock(site.siteId, async () => {
      // What this server just wrote beats a bee read that may not have it yet (events-index.ts).
      const priorIndex = freshWrittenEventsIndex(site.siteId)
        ?? await readFeedPage(eventsTopic).then((p) => (p ? decodeJsonFeed<SiteEventsIndex>(p) : null)).catch(() => null);
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

      // Every page is encoded before any write starts, so a page that will not
      // encode refuses the publish with nothing in flight.
      const eventsPage = encodeJsonFeed(eventsIndex);
      const configPages: Array<[Topic, Uint8Array]> = [];
      if (siteFeedSigner) {
        const pointer: SitePointer = {
          _woco_site_ptr: 1,
          ownerAddress: parentAddress,
          siteFeedSigner: siteFeedSigner as Hex0x,
          updatedAt: now,
        };
        configPages.push([configTopic, encodeJsonFeed(pointer)]);
      } else {
        // Legacy platform-written path (client without a feed signer). Config
        // (without pages) + pages split across two feeds to stay under 4096 bytes.
        const siteToWrite: Site = {
          ...site,
          ownerAddress: parentAddress,
          createdAt: existing.status === "found" ? existing.site.createdAt : now,
          updatedAt: now,
        };
        const { pages, ...siteShell } = siteToWrite;
        configPages.push([configTopic, encodeJsonFeed(siteShell)], [pagesTopic, encodeJsonFeed({ pages })]);
      }

      // All of them run to the end before the publish answers (#943). With
      // `Promise.all` the first failure answered - and released the events lock -
      // while another write was still going, and an events index that landed
      // anyway was never recorded below. One failed write fails the publish, so
      // the client's retry writes every page again: each is a whole page, never
      // a delta, so a second copy of one that landed changes nothing.
      const [eventsWrite, ...configWrites] = await Promise.allSettled([
        writeFeedPage(eventsTopic, eventsPage, siteFeedWrite(parentAddress, feedDest)),
        ...configPages.map(([topic, page]) => writeFeedPage(topic, page, siteFeedWrite(parentAddress, feedDest))),
      ]);
      if (eventsWrite.status === "fulfilled") {
        // Publish rewrote the events index — drop the events-full memo (declared
        // below; the closure resolves it at request time) so it doesn't serve stale.
        rememberWrittenEventsIndex(site.siteId, eventsIndex);
        _siteEventsFull.delete(site.siteId);
      }
      const failed = [eventsWrite, ...configWrites].filter((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed.length > 0) {
        console.warn(
          `[sites/publish] ${site.siteId}: ${failed.length} of ${configWrites.length + 1} writes failed ` +
            `(config ${configWrites.every((r) => r.status === "fulfilled") ? "written" : "not written"}, ` +
            `events index ${eventsWrite.status === "fulfilled" ? "written" : "not written"}) - refused, a retry writes all`,
        );
        // A real fault outranks "busy": busy would send the client into a pointless wait (Fable, #946 F2).
        throw (failed.find((r) => !isStorageBusy(r.reason)) ?? failed[0]).reason;
      }
    });

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
    if (err instanceof PlatformBatchUnavailable) return c.json({ ok: false, error: err.message, code: err.code }, 503);
    if (isStorageBusy(err)) {
      console.warn(`[sites/publish] storage busy: ${err.message}`);
      return storageBusy(c);
    }
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

/**
 * Refuse an id whose SHAPE is wrong, before it reaches a feed topic or the
 * deployed page's config.
 *
 * `site.ts:73` already does this for `eventId` on the reasoning that the shape
 * is a security property rather than hygiene — the charset admits no `<`, `>`,
 * quote or slash, so it holds even if an escaper downstream is ever bypassed
 * (#193). Every id-bearing route here reached `Topic.fromString`, the escaped
 * SITE_CONFIG and the owner-gated overwrite check without it. Nothing was
 * reachable today, but a guarantee that holds on one identifier and not its sibling
 * is one refactor away from not holding at all (#213).
 */
function malformedId(c: Context, name: "siteId" | "eventId") {
  return c.json({ ok: false, error: `${name} is malformed` }, 400);
}

// GET /api/sites/runtime - the latest site runtime release (#1032), for the builder.
// Registered before "/:id", or "runtime" would match as a siteId.
sitesRouter.get("/runtime", async (c) => {
  // From memory once one is held (the background refresh keeps it current); only a
  // cold process reads here.
  const release = siteRuntimeReleases.peek() ?? (await siteRuntimeReleases.get());
  if (!release) {
    const { lastError } = siteRuntimeReleases.health();
    return lastError
      ? c.json({ ok: false, error: "The site runtime release could not be read" }, 503)
      : c.json({ ok: false, error: "No site runtime release has been published yet" }, 404);
  }
  return c.json({ ok: true, data: release });
});

// GET /api/sites/runtime/kit/:store - what a browser needs to build a site on the
// current release (#1032 slice 3): the store's release root node and the template.
// Nothing here is trusted by the deploy, which rebuilds from its own copy; the
// client checks the node against the descriptor's root itself.
sitesRouter.get("/runtime/kit/:store", (c) => serveRuntimeKit(c, "site"));

sitesRouter.get("/:id", async (c) => {
  const siteId = c.req.param("id");
  if (!isSafeIdParam(siteId)) return malformedId(c, "siteId");
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
  if (!isSafeIdParam(siteId)) return malformedId(c, "siteId");
  try {
    const fresh = freshWrittenEventsIndex(siteId);
    if (fresh) return c.json({ ok: true, data: withoutCancelled({ index: fresh, events: [] }).index });

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
    return c.json({ ok: true, data: withoutCancelled({ index, events: [] }).index });
  } catch {
    return c.json({ ok: false, error: "Failed to read events index" }, 500);
  }
});

// ---------------------------------------------------------------------------
// Server-side cache for events-full — avoids hitting Swarm on every visitor request.
// TTL 5 min: fast for repeat visitors, stale-within-acceptable-window for organiser updates.
const _siteEventsFull = new Map<string, { data: { index: SiteEventsIndex; events: EventFeed[] }; expiresAt: number }>();
const SITE_EVENTS_FULL_TTL_MS = 5 * 60_000;
/** Visitors' browsers. Short, so an organiser's add shows on a reload within a
 *  minute as the builder promises; the memo above still shields Swarm. */
const SITE_EVENTS_FULL_CACHE_CONTROL = "public, max-age=30, stale-while-revalidate=60";

/**
 * A cancelled event leaves every site's listing (#644). Applied on each
 * response, cached or fresh, so a cancellation needs no cache bust here; the
 * Cloudflare edge copy can still be up to its stale-while-revalidate window
 * old, and the buy button behind it refuses regardless (claim-status).
 */
export function withoutCancelled(data: { index: SiteEventsIndex; events: EventFeed[] }) {
  const open = (eventId: string) => cancellationGate(eventId) !== "cancelled";
  return {
    index: { ...data.index, events: data.index.events.filter((e) => open(e.eventId)) },
    events: data.events.filter((e) => open(e.eventId)),
  };
}

// GET /api/sites/:id/events-full — events index + full event details in one call (public)
// Reduces N+1 client round trips to a single request. Server fans out to Swarm in parallel.
// ---------------------------------------------------------------------------

sitesRouter.get("/:id/events-full", async (c) => {
  const siteId = c.req.param("id");
  if (!isSafeIdParam(siteId)) return malformedId(c, "siteId");
  try {
    const now = Date.now();
    const cached = _siteEventsFull.get(siteId);
    if (cached && cached.expiresAt > now) {
      c.header("Cache-Control", SITE_EVENTS_FULL_CACHE_CONTROL);
      return c.json({ ok: true, data: withoutCancelled(cached.data) });
    }

    let index = freshWrittenEventsIndex(siteId);
    if (!index) {
      const page = await readFeedPage(Topic.fromString(siteEventsIndexTopic(siteId)));
      if (!page) {
        const emptyIndex: SiteEventsIndex = { siteId, events: [], updatedAt: 0, schemaVersion: SITE_SCHEMA_VERSION };
        return c.json({ ok: true, data: { index: emptyIndex, events: [] } });
      }
      index = decodeJsonFeed<SiteEventsIndex>(page);
      if (!index) return c.json({ ok: false, error: "Corrupt events index" }, 500);
    }

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
    c.header("Cache-Control", SITE_EVENTS_FULL_CACHE_CONTROL);
    return c.json({ ok: true, data: withoutCancelled(data) });
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
  if (!isSafeIdParam(siteId)) return malformedId(c, "siteId");

  try {
    const refused = await eventIndexOwnerRefusal(siteId, parentAddress);
    if (refused) return c.json({ ok: false, error: refused.error }, refused.status);

    const body = await c.req.json() as { eventId?: string; featured?: boolean };
    if (!body.eventId) return c.json({ ok: false, error: "eventId required" }, 400);
    if (cancellationGate(body.eventId) !== "open") {
      return c.json({ ok: false, error: "This event has been cancelled" }, 409);
    }

    // One edit at a time per site, each on the latest index (events-index.ts).
    const written = await withEventsIndexLock(siteId, async () => {
      const read = await readEventsIndexForWrite(siteId);
      if (read.status === "unavailable") {
        console.warn(`[sites/events] index unreadable for ${siteId}: ${read.reason}`);
        return null;
      }
      const index = read.index;
      const existingEntry = index.events.find((e) => e.eventId === body.eventId);
      if (!existingEntry) {
        const priorSigners = new Map<string, Hex0x>();
        for (const e of index.events) if (e.creatorFeedSigner) priorSigners.set(e.eventId, e.creatorFeedSigner);
        const [entry] = await stampEventSigners([{
          eventId: body.eventId!,
          featured: body.featured ?? false,
          addedAt: Date.now(),
        }], parentAddress, priorSigners);
        index.events.push(entry);
      } else if (body.featured !== undefined && existingEntry.featured !== body.featured) {
        // The idempotent add doubles as a featured-flag update for an event already
        // on the site — lets the builder persist a ★ toggle without a full republish.
        existingEntry.featured = body.featured;
      }
      index.updatedAt = Date.now();

      await writeFeedPage(
        Topic.fromString(siteEventsIndexTopic(siteId)),
        encodeJsonFeed(index),
        siteFeedWrite(parentAddress, await siteFeedDestFromDirectory(parentAddress, siteId)),
      );
      rememberWrittenEventsIndex(siteId, index);
      // A write just changed the index; drop the events-full memo so the next
      // deployed-site visitor reads the new list instead of the 5-min-stale copy.
      _siteEventsFull.delete(siteId);
      return index;
    });
    if (!written) return c.json({ ok: false, error: EVENTS_INDEX_UNREADABLE }, 503);
    return c.json({ ok: true, data: written });
  } catch (err) {
    if (err instanceof PlatformBatchUnavailable) return c.json({ ok: false, error: err.message, code: err.code }, 503);
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Failed to add event" }, 500);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/sites/:id/events/:eventId — remove event from index (auth)
// ---------------------------------------------------------------------------

sitesRouter.delete("/:id/events/:eventId", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const siteId = c.req.param("id");
  if (!isSafeIdParam(siteId)) return malformedId(c, "siteId");
  const eventId = c.req.param("eventId");
  if (!isSafeIdParam(eventId)) return malformedId(c, "eventId");

  try {
    const refused = await eventIndexOwnerRefusal(siteId, parentAddress);
    if (refused) return c.json({ ok: false, error: refused.error }, refused.status);

    const written = await withEventsIndexLock(siteId, async () => {
      const read = await readEventsIndexForWrite(siteId);
      if (read.status === "unavailable") {
        console.warn(`[sites/events] index unreadable for ${siteId}: ${read.reason}`);
        return null;
      }
      const index = read.index;
      if (!index.events.some((e) => e.eventId === eventId)) return index; // nothing to remove

      index.events = index.events.filter((e) => e.eventId !== eventId);
      index.updatedAt = Date.now();

      await writeFeedPage(
        Topic.fromString(siteEventsIndexTopic(siteId)),
        encodeJsonFeed(index),
        siteFeedWrite(parentAddress, await siteFeedDestFromDirectory(parentAddress, siteId)),
      );
      rememberWrittenEventsIndex(siteId, index);
      _siteEventsFull.delete(siteId); // see add-event handler — keep visitors fresh
      return index;
    });
    if (!written) return c.json({ ok: false, error: EVENTS_INDEX_UNREADABLE }, 503);
    return c.json({ ok: true, data: written });
  } catch (err) {
    if (err instanceof PlatformBatchUnavailable) return c.json({ ok: false, error: err.message, code: err.code }, 503);
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Failed to remove event" }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /api/sites/:id/contact — forward contact form submission (public)
// ---------------------------------------------------------------------------

sitesRouter.post("/:id/contact", async (c) => {
  const siteId = c.req.param("id");
  if (!isSafeIdParam(siteId)) return malformedId(c, "siteId");
  const ip = clientIp(c);
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

    const siteName = site.theme.brandName || siteId;
    await sendEmail({
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
  if (!isSafeIdParam(siteId)) return malformedId(c, "siteId");
  const refusal = await websiteStorageRefusal(parentAddress);
  if (refusal) return c.json(refusal, 403);

  let endDeploy: ((holdMs?: number) => void) | null = null;
  let holdAfterMs = 0;

  try {
    const body = await c.req.json() as { apiUrl: string; gatewayUrl?: string; wocoAppUrl?: string; site?: Site; clientFeed?: boolean; collection?: unknown };
    if (!body.apiUrl) return c.json({ ok: false, error: "apiUrl required" }, 400);

    // All three are free-form in the request body and all three are load-bearing
    // in the deployed page — apiUrl receives visitors' session headers, gatewayUrl
    // routes both content reads and batch payment, wocoAppUrl lands in an href.
    // Allowlisted before anything else uses them (#180).
    const resolvedUrls = resolveDeployUrls({
      apiUrl: body.apiUrl,
      gatewayUrl: body.gatewayUrl ?? "https://gateway.woco-net.com",
      wocoAppUrl: body.wocoAppUrl ?? "https://woco.eth.limo",
    });
    if (!resolvedUrls.ok) return c.json({ ok: false, error: resolvedUrls.error }, 400);
    const { apiUrl, gatewayUrl, wocoAppUrl } = resolvedUrls.urls;

    // The site is the one the client rendered (`body.site`, below; #1032 the
    // browser builds it), owner stamped server-side. An EXISTING siteId may only
    // be deployed by its owner — without this gate the body.site path would let
    // any authenticated user overwrite another site's woco-multisite feed and
    // re-point its custom domains.
    // As on publish: "unavailable" is not "unclaimed" (#181). This gate is the
    // only thing standing between the body.site fast path and a caller taking over
    // another site's woco-multisite feed, which is what the custom domains resolve
    // through — so an undecidable read must refuse rather than fall through.
    const published = await resolveSiteConfig(siteId);
    if (published.status === "unavailable") {
      console.warn(`[sites/deploy] ownership undecidable for ${siteId}: ${published.reason}`);
      if (isStorageBusy(published.cause)) return storageBusy(c);
      return c.json({
        ok: false,
        error: "Could not verify site ownership right now — please try again",
      }, 503);
    }
    if (published.status === "found" && published.site.ownerAddress.toLowerCase() !== parentAddress) {
      return c.json({ ok: false, error: "Not the site owner" }, 403);
    }

    // The pointer feed's index is resolved before the upload and held through it
    // (below): one deploy of a site at a time (deploy-guard.ts). Taken only once
    // ownership is settled, so a caller who isn't the owner can never hold it.
    endDeploy = beginDeploy(`site:${siteId}`);
    if (!endDeploy) return c.json({ ok: false, error: DEPLOY_IN_PROGRESS_MESSAGE, code: DEPLOY_IN_PROGRESS_CODE }, 409);

    // Every site is built in the browser on the shared runtime release (#1032);
    // this server only checks that build. An app from before that sends none.
    if (body.collection === undefined) {
      return c.json({ ok: false, error: CLIENT_BUILD_REQUIRED_MESSAGE, code: "CLIENT_BUILD_REQUIRED" }, 400);
    }
    const received = decodeClientCollection(body.collection);
    if (!received || !body.site || body.site.siteId !== siteId) {
      return c.json({ ok: false, error: "Malformed site collection", code: "COLLECTION_MISMATCH" }, 400);
    }
    // The label is the site's canonical address (#70) and the name checked after
    // the upload: a name, or none - as the event-page deploy requires (site.ts).
    const label: unknown = body.site.subEnsLabel;
    if (label !== undefined && (typeof label !== "string" || validateLabel(label))) {
      return c.json({ ok: false, error: "subEnsLabel is not a valid name" }, 400);
    }
    // The server stamps the owner; the browser rendered with the same stamp.
    const site: Site = { ...body.site, ownerAddress: parentAddress };

    // With the Etherna failover (#912): a batch the chain refuses still takes the
    // deploy (stamped on WoCo, moved back), and the quota below meters the batch it
    // is meant for.
    let selection;
    try {
      const freeHostingEligible = await isVerifiedOrganiser(parentAddress);
      selection = routeSave(() =>
        batchForDeploy({ ownerAddress: parentAddress, gatewayUrl, deployType: "website", freeHostingEligible }),
      );
    } catch (err) {
      if (err instanceof BatchPurchaseRequired) {
        return c.json({ ok: false, error: err.message, code: "BATCH_PURCHASE_REQUIRED" }, 402);
      }
      if (err instanceof StripeVerificationRequired) {
        return c.json({ ok: false, error: err.message, code: "STRIPE_VERIFICATION_REQUIRED" }, 403);
      }
      if (err instanceof PlatformBatchUnavailable) return c.json({ ok: false, error: err.message, code: err.code }, 503);
      throw err;
    }
    const { batchId, target } = selection;
    const signer = getPlatformSigner();
    const owner = getPlatformOwner();
    const bee = getBee();
    // Event images are uploaded to WoCo Bee at event-creation time and are not
    // re-uploaded during site deploy. Inject contentGatewayUrl so the runtime
    // always fetches event images from WoCo Bee regardless of site host.
    const renderUrls = { apiUrl, gatewayUrl, wocoAppUrl, ...(target === "etherna" ? { contentGatewayUrl: "https://gateway.woco-net.com" } : {}) };

    // The browser built the site, linking the shared runtime release; the server
    // rebuilds it from its own inputs and its own copy of the release, and stores
    // ITS build, only when the browser's is byte-identical (lib/site/collection-publish.ts).
    const kit = await runtimeKitFor(storeForTarget(target));
    if (!kit) return c.json({ ok: false, error: "The site runtime is unavailable right now", code: "RUNTIME_RELEASE_UNAVAILABLE" }, 503);
    const verdict = admitClientCollection({ kit, site, urls: renderUrls, received });
    if (!verdict.ok) {
      console.warn(`[sites/deploy] browser-built site refused for ${siteId}: ${verdict.code} (${verdict.error})`);
      return c.json({ ok: false, error: verdict.error, code: verdict.code }, 409);
    }
    const collection = verdict.collection;
    const deployBytes = collection.objects.reduce((n, o) => n + o.data.length, 0);

    // Free-hosted deploys share the platform batch, so cap what each owner can
    // put on it. Checked against the storage ledger BEFORE spending postage.
    // This site's own current deploy is excluded — the new upload supersedes it.
    if (selection.freeHosted) {
      const used = getFreeHostedBytes(parentAddress, { excludeSite: siteId });
      if (used + deployBytes > FREE_HOSTING_QUOTA_BYTES) {
        const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
        return c.json({
          ok: false,
          error: `Free hosting quota exceeded: ${mb(used)}MB used + ${mb(deployBytes)}MB deploy > ${mb(FREE_HOSTING_QUOTA_BYTES)}MB limit. Purchase your own storage batch to continue.`,
          code: "FREE_HOSTING_QUOTA_EXCEEDED",
        }, 413);
      }
    }

    // Per-site feed so an ENS name / custom domain can point at it. Its next index
    // is resolved HERE, before the upload (#943): a first deploy's feed has never
    // been written, bee skips such a chunk for a minute after a few misses, and
    // resolving after the upload failed the deploy with the whole collection
    // already up - and the retry uploaded it again. Resolved once: a second
    // resolution after the upload would read the same unwritten chunk again, and
    // the deploy guard above keeps the index ours meanwhile.
    const topicString = multisiteFeedTopic(siteId);
    const topic = Topic.fromString(topicString);

    // The pointer feed is CLIENT-OWNED when the site config is (siteFeedSigner
    // resolved from the server-written pointer — never the request) AND the
    // frontend declared it will sign the update (`clientFeed`; an old bundle
    // that can't sign must keep the platform-signed feed, else the new manifest
    // would point at a feed with no updates). Both targets: Etherna is the
    // production path, so client ownership must hold there first of all.
    const feedOwnerSigner =
      body.clientFeed && published.status === "found" ? published.siteFeedSigner : undefined;
    // Our bee's lookup as the start, then forward over every store the feed lives on
    // (`feed-index.ts`) - never Etherna's lookup, which its gateway refuses (403
    // since 2026-10-23) and an outage cannot answer (#912). During an outage the
    // relay ledger's read rule decides for Etherna, and an update sent there that
    // our bee has not seen yet refuses the deploy rather than fork the feed.
    const feedOwnerHex = (feedOwnerSigner ?? owner.toHex()).replace(/^0x/, "").toLowerCase();
    let pointer: PointerPlan;
    try {
      pointer = { rail: target === "etherna" ? "etherna" : "woco", nextIndex: await resolveFeedNextIndex(topic, feedOwnerHex, target === "etherna" ? "etherna" : "woco") };
    } catch (err) {
      if (isStorageBusy(err)) throw err;
      console.warn(`[sites/deploy] ${siteId}: pointer index undecidable, refused: ${(err as Error)?.message ?? err}`);
      return c.json(feedIndexUnavailableBody(), 503);
    }

    // Six small objects; everything else is linked from the release, which is
    // already stored (and on Etherna a site root's offer serves it, slice 0). On
    // Etherna each goes through the one save layer: with the failover on, what
    // Etherna cannot take is stamped on WoCo and moved back to this owner's batch.
    const store = deployStore(selection, { parent: parentAddress });
    const { rootLanded } = await uploadSiteObjects(store, collection);
    const contentHash = collection.root;
    // Bounded and non-fatal: the site is stored; a missing offer only delays
    // anonymous Etherna reads. A root on WoCo is offered when it moves back.
    if (target === "etherna" && rootLanded === "etherna") {
      await registerEthernaOffer(contentHash).catch((e) => console.warn("[sites/deploy] etherna root offer failed (non-fatal):", e));
    }
    // The feed's manifest, stored by us (`storeFeedManifest`): Etherna's POST /feeds
    // made the same bytes, and cannot answer in an outage.
    const ethernaManifest = target === "etherna" ? await storeFeedManifest(store, feedOwnerHex, topic.toHex()) : "";

    // Every deploy lands in the storage ledger regardless of batch: it is both
    // the quota meter and the per-owner migration manifest (re-stamp walks it).
    recordUpload(parentAddress, {
      ref: contentHash,
      bytes: deployBytes,
      kind: "site-deploy",
      batchId,
      target,
      note: siteId,
      ...(selection.freeHosted ? { freeHosted: true } : {}),
      // The site links the release: a re-stamp of the owner's site stops there.
      links: [kit.release.root],
    });

    let feedManifestHash = "";
    // Client-owned pointer feed (set when the CLIENT will sign the update).
    let multisiteFeed: { nextIndex: number; rootChunkPayloadB64: string } | null = null;

    if (feedOwnerSigner && pointer.rail === "etherna") {
      // Same steps as the platform-signed Etherna write, minus signing — the
      // client signs the update SOC and pushes it via /api/swarm/soc (which
      // routes to the same Etherna user batch, and fails over like any relay).
      // The update carries the root node the server just admitted, never a read.
      feedManifestHash = ethernaManifest;
      holdAfterMs = CLIENT_POINTER_HOLD_MS;
      multisiteFeed = {
        nextIndex: Number(pointer.nextIndex),
        rootChunkPayloadB64: Buffer.from(collection.rootNode).toString("base64"),
      };
    } else if (feedOwnerSigner && pointer.rail === "woco") {
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
      // bee-js uploadPayload's wrapped-chunk form) + the feed's next index,
      // resolved forward from the lookup before the upload (#186: any failed
      // lookup used to read as a fresh feed, and an update signed for a taken
      // index 0 keeps the old pointer, silently).
      const chunkRes = await fetch(`${BEE_URL}/chunks/${contentHash}`, {
        signal: AbortSignal.timeout(BEE_CALL_TIMEOUT_MS),
      });
      if (chunkRes.ok) {
        const chunkBytes = await readCapped(chunkRes, SWARM_CHUNK_MAX_BYTES, "root chunk");
        holdAfterMs = CLIENT_POINTER_HOLD_MS;
      multisiteFeed = {
          nextIndex: Number(pointer.nextIndex),
          rootChunkPayloadB64: Buffer.from(chunkBytes.subarray(8)).toString("base64"),
        };
      } else {
        console.warn(`[sites/deploy] root chunk fetch ${chunkRes.status} — client feed update skipped`);
      }
    } else if (pointer.rail === "etherna") {
      // Etherna's Beehive only resolves feeds written with inline SOC (uploadPayload).
      // writeEthernaFeedUpdate signs here and sends raw HTTP with the inline-chunk
      // SOC format (confirmed by etherna-soc-legacy-probe.ts), failing over like a relay.
      await writeEthernaFeedUpdate({
        topic,
        index: pointer.nextIndex,
        rootChunk: collectionRootChunk(collection),
        batchId,
        signer,
        ownerHex: owner.toHex(),
        failover: { parent: parentAddress, ethernaRefused: selection.ethernaRefused },
      });
      feedManifestHash = ethernaManifest;
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
      // An explicit index on every upload (#186): without one bee-js discovers
      // it, which reads behind (or answers 0 on any bee error), and an update
      // at a taken index keeps the OLD pointer while the deploy reports success.
      const index = { index: FeedIndex.fromBigInt(pointer.nextIndex) };
      const writer = bee.makeFeedWriter(topic, signer);
      try {
        await whitelistHashes([contentHash]).catch(() => {});
        const chunkRes = await fetch(`${BEE_URL}/chunks/${contentHash}`, {
          signal: AbortSignal.timeout(BEE_CALL_TIMEOUT_MS),
        });
        if (!chunkRes.ok) throw new Error(`fetch root chunk ${chunkRes.status}`);
        const chunkBytes = await readCapped(chunkRes, SWARM_CHUNK_MAX_BYTES, "root chunk");
        const payload = chunkBytes.subarray(8);
        if (payload.length > 4096) {
          console.warn(`[sites/deploy] root chunk ${payload.length}B > 4096 — falling back to legacy SOC write`);
          await withTimeout(
            writer.uploadReference(batchId, new Reference(contentHash), index),
            BEE_CALL_TIMEOUT_MS,
            "multisite feed write (legacy)",
          );
        } else {
          await withTimeout(
            writer.uploadPayload(batchId, payload, index),
            BEE_CALL_TIMEOUT_MS,
            "multisite feed write (inline)",
          );
        }
      } catch (err) {
        console.warn(`[sites/deploy] inline SOC write failed (${(err as Error).message}) — falling back to legacy`);
        await withTimeout(
          writer.uploadReference(batchId, new Reference(contentHash), index),
          BEE_CALL_TIMEOUT_MS,
          "multisite feed write (legacy fallback)",
        );
      }
    }

    // The site's name shows THIS build, whatever its feed later says: the CCIP
    // gateway signs the ledger's latest ref, never the holder's feed (name-targets.ts).
    // Not recorded = the name still shows the previous build, so the response says so.
    let nameRecorded = true;
    if (feedManifestHash) {
      nameRecorded = recordNameTarget(feedManifestHash, { kind: "site", id: siteId, owner: parentAddress, latestRef: contentHash });
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

    // Point B, registry v2.2. The deploy never writes the name: it points at
    // this site's FEED MANIFEST, which the publish just advanced, so the name
    // follows with no chain write and no prompt. This is a read-only check
    // that it still does; when it does not (first bind, or re-bound
    // elsewhere), the response says what the HOLDER should sign.
    //
    // Every refusal is reported, never silent: before, a site bound to a name
    // the organiser had transferred away simply stopped updating.
    let subEns: SiteDeploySubEns | undefined;
    if (site.subEnsLabel) {
      subEns = await checkSiteSubEns(site.subEnsLabel, parentAddress, feedManifestHash, feedOwnerSigner ? "client" : "platform");
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
      // The runtime release this deploy linked: My Sites offers an update when behind.
      runtimeVersion: kit.version,
    } satisfies SiteDirectoryEntry).catch((e) =>
      console.warn("[sites/deploy] creator directory upsert failed:", e)
    );

    return c.json({
      ok: true,
      data: {
        contentHash,
        feedManifestHash,
        siteUrl,
        // Which side built the site: "client" = the browser's collection, admitted (#1032).
        // Every site is browser-built now; kept for apps that read it (#1032).
        builtBy: "client" as const,
        // The runtime release the site linked: the builder's update prompt.
        runtimeVersion: kit.version,
        // Present only when the pointer feed is client-owned: the caller signs
        // the sequence-feed update SOC (beeFeedUpdateIdentifier) with this.
        ...(multisiteFeed ? { multisiteFeed } : {}),
        // What happened to the site's sub-ENS name, when it has one.
        ...(subEns ? { subEns } : {}),
        ...(nameRecorded ? {} : { nameRecorded: false as const }),
      },
    });

  } catch (e) {
    if (isStorageBusy(e)) {
      console.warn(`[sites/deploy] storage busy: ${e.message}`);
      return storageBusy(c);
    }
    console.error("[sites/deploy]", e);
    return c.json({ ok: false, error: e instanceof Error ? e.message : "Deploy failed" }, 500);
  } finally {
    endDeploy?.(holdAfterMs);
  }
});

export { sitesRouter };
