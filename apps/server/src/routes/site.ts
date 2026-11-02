import { Hono } from "hono";
import { Topic } from "@ethersphere/bee-js";
import {
  eventPageDeployConfig,
  eventPageFeedTopic,
  parseEventPageHead,
  validateLabel,
  EVENT_PAGE_TITLE_MAX,
  type EventPageConfig,
  type EventPageHead,
} from "@woco/shared";
import { requireAuth } from "../middleware/auth.js";
import { eventPageDeployGate } from "../lib/event/page-deploy-gate.js";
import { getEvent } from "../lib/event/service.js";
import {
  batchForDeploy,
  BatchPurchaseRequired,
  PlatformBatchUnavailable,
  ETHERNA_URL,
  isEthernaGateway,
} from "../lib/etherna/batch-router.js";
import { recordUpload } from "../lib/swarm/storage-ledger.js";
import { whitelistHashes } from "../lib/swarm/whitelist.js";
import { registerEthernaOffer, prepareEthernaFeedIndex } from "../lib/etherna/upload.js";
import { isStorageBusy, storageBusyBody, STORAGE_BUSY_RETRY_AFTER_HEADER } from "../lib/swarm/storage-busy.js";
import { beginDeploy, CLIENT_POINTER_HOLD_MS, DEPLOY_IN_PROGRESS_CODE, DEPLOY_IN_PROGRESS_MESSAGE } from "../lib/site/deploy-guard.js";
import { checkSiteSubEns, type SiteDeploySubEns } from "../lib/sub-ens/site-pointer.js";
import { recordNameTarget } from "../lib/sub-ens/name-targets.js";
import {
  admitClientEventPage,
  decodeClientCollection,
  serveRuntimeKit,
  siteRuntimeKits,
  uploadSiteObjects,
  type SiteRuntimeKit,
} from "../lib/site/collection-publish.js";
import { siteRuntimeReleases } from "../lib/site/runtime-release.js";
import { isSafeIdParam, resolveDeployApiUrl } from "../lib/site/deploy-config.js";

/**
 * Single-event pages (#614, #617; built in the browser since #1032 slice 5).
 *
 * The page is built in the organiser's browser on the shared runtime release's
 * `eventPage` line (`@woco/shared/site/collection` buildEventPageCollection) and
 * this server rebuilds it from its OWN config (its API base, Etherna, the feed
 * signer pinned at create) and the browser's head (title + image, format-checked):
 * it stores its own build only when the browser's is byte-identical. It reads
 * nothing of the event to admit a page - the event feed is the organiser's own
 * signed data, so a second read could only add timing differences.
 */
const site = new Hono();

// GET /api/site/runtime/kit/:store - the single-event page runtime's kit (#1032
// slice 5), as /api/sites/runtime/kit is the websites'.
site.get("/runtime/kit/:store", (c) => serveRuntimeKit(c, "eventPage"));

/** What an app from before browser-built pages sees. */
const CLIENT_BUILD_REQUIRED_MESSAGE = "This version of the app can no longer publish event pages - reload the page to update it, then publish again.";
/** Event images live on WoCo's bee whatever store the page is on. */
const CONTENT_GATEWAY_URL = "https://gateway.woco-net.com";

/** The config this server bakes into an event page. Never read from a request body. */
function pageConfig(apiUrl: string, eventId: string, signer: string): EventPageConfig {
  return eventPageDeployConfig({ apiUrl, gatewayUrl: ETHERNA_URL, contentGatewayUrl: CONTENT_GATEWAY_URL, eventId, eventSigner: signer });
}

/**
 * The head this server suggests to the builder: the event's own title and image,
 * shaped to pass `parseEventPageHead`. Only a suggestion - a deploy is admitted
 * on the head the browser sends, never on a read of the event.
 */
function suggestedHead(event: { title?: string; imageHash?: string } | null): EventPageHead {
  const title = (event?.title?.trim() || "Event").slice(0, EVENT_PAGE_TITLE_MAX);
  const ref = (event?.imageHash ?? "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(ref) && !/^0+$/.test(ref) ? { title, imageHash: ref } : { title };
}

/** The kit an event-page deploy builds against: the held release's `eventPage` line on Etherna. */
async function liveEventPageKit(): Promise<SiteRuntimeKit | null> {
  const release = await siteRuntimeReleases.get();
  if (!release) return null;
  return siteRuntimeKits.kit(release, "eventPage", "etherna").catch((e: unknown) => {
    console.warn(`[site/deploy] event-page runtime kit unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  });
}
let eventPageKit = liveEventPageKit;
let pageGate = eventPageDeployGate;

/** Tests only. */
export const __siteDeployTestHooks = {
  setRuntimeKit(kit: (() => Promise<SiteRuntimeKit | null>) | null): void {
    eventPageKit = kit ?? liveEventPageKit;
  },
  setGate(gate: typeof eventPageDeployGate | null): void {
    pageGate = gate ?? eventPageDeployGate;
  },
};

// ── Routes ─────────────────────────────────────────────────────────────────

// GET /api/site/:eventId/page-config — the exact config a deploy of this page
// bakes (key order fixed) and a suggested head, for the creator's browser to
// build with. Creator only, as the deploy.
site.get("/:eventId/page-config", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const eventId = c.req.param("eventId");
  if (!isSafeIdParam(eventId)) return c.json({ ok: false, error: "eventId is malformed" }, 400);
  const apiUrl = resolveDeployApiUrl(c.req.query("apiUrl") ?? "");
  if (!apiUrl) return c.json({ ok: false, error: "PUBLIC_API_BASE is not configured on the server" }, 400);
  const gate = pageGate(eventId, parentAddress);
  if (!gate.ok) return c.json({ ok: false, error: gate.error }, gate.status);
  // The event's title and image, best effort: a failed read suggests WoCo's logo.
  const event = await getEvent(eventId, gate.signer).catch(() => null);
  return c.json({ ok: true, data: { config: pageConfig(apiUrl, eventId, gate.signer), head: suggestedHead(event) } });
});

// POST /api/site/deploy — store a browser-built event page.
site.post("/deploy", requireAuth, async (c) => {
  let endDeploy: ((holdMs?: number) => void) | null = null;
  let holdAfterMs = 0;

  try {
    const parentAddress = (c.get("parentAddress") as string).toLowerCase();

    const body = await c.req.json() as {
      eventId: string;
      gatewayUrl?: string;
      apiUrl: string;
      /** The browser will sign the page-feed update (#614); absent = no feed. */
      clientFeed?: boolean;
      /** A name to check against the page feed - read-only, never written here. */
      subEnsLabel?: string;
      /** The title + image the browser rendered the head with (#1032 slice 5). */
      head?: unknown;
      /** The browser's build (#1032 slice 5). */
      collection?: unknown;
    };
    const { eventId, gatewayUrl, apiUrl: clientApiUrl, subEnsLabel } = body;

    // eventId is interpolated into the deployed page's SITE_CONFIG, so its shape
    // is a security property, not just hygiene: the charset admits no `<`, `>`,
    // quote or slash, which holds even if the escaping below is ever bypassed
    // (#193).
    if (!eventId || !isSafeIdParam(eventId)) {
      return c.json({ ok: false, error: "eventId is missing or malformed" }, 400);
    }

    // The API base every authenticated request from the deployed page is sent to.
    // Taken from the server's own PUBLIC_API_BASE and the client's claim
    // discarded — `sanitisePublicApiUrl` only rejected private/non-https hosts,
    // so it admitted any https host the organiser chose, which would have
    // received visitors' session delegation and signature headers (#193).
    const apiUrl = resolveDeployApiUrl(clientApiUrl);
    if (!apiUrl) {
      return c.json({
        ok: false,
        error: "apiUrl is required and PUBLIC_API_BASE is not configured on the server",
      }, 400);
    }

    // Event pages are stored on Etherna only (#617): its feed is the organiser's
    // and Etherna is where the browser signs it into. Absent means Etherna.
    if (gatewayUrl?.trim() && !isEthernaGateway(gatewayUrl)) {
      return c.json({ ok: false, error: "Event pages are published on Etherna" }, 400);
    }
    if (subEnsLabel !== undefined && (typeof subEnsLabel !== "string" || validateLabel(subEnsLabel))) {
      return c.json({ ok: false, error: "subEnsLabel is not a valid name" }, 400);
    }

    // Only the event's creator publishes its page (#679), and the page feed is
    // owned by the signer pinned at create (#676) - never a request value.
    const gate = pageGate(eventId, parentAddress);
    if (!gate.ok) return c.json({ ok: false, error: gate.error }, gate.status);

    // The page feed's index is resolved before the upload and held through it
    // (below): one deploy of a page at a time (deploy-guard.ts).
    endDeploy = beginDeploy(`event-page:${eventId}`);
    if (!endDeploy) return c.json({ ok: false, error: DEPLOY_IN_PROGRESS_MESSAGE, code: DEPLOY_IN_PROGRESS_CODE }, 409);

    // Every page is built in the browser on the shared runtime release (#1032);
    // this server only checks that build. An app from before that sends none.
    if (body.collection === undefined) {
      return c.json({ ok: false, error: CLIENT_BUILD_REQUIRED_MESSAGE, code: "CLIENT_BUILD_REQUIRED" }, 400);
    }
    const received = decodeClientCollection(body.collection);
    if (!received) return c.json({ ok: false, error: "Malformed page collection", code: "COLLECTION_MISMATCH" }, 400);
    const head = parseEventPageHead(body.head);
    if (!head) return c.json({ ok: false, error: "The page's title or image is missing or malformed", code: "COLLECTION_MISMATCH" }, 400);

    let selection;
    try {
      selection = batchForDeploy({
        ownerAddress: parentAddress,
        gatewayUrl: ETHERNA_URL,
        deployType: "event",
      });
    } catch (err) {
      if (err instanceof BatchPurchaseRequired) {
        return c.json({ ok: false, error: err.message, code: "BATCH_PURCHASE_REQUIRED" }, 402);
      }
      if (err instanceof PlatformBatchUnavailable) return c.json({ ok: false, error: err.message, code: err.code }, 503);
      throw err;
    }
    const { batchId, target } = selection;
    // The route above only ever asks for Etherna; anything else is a router bug.
    if (target !== "etherna") throw new Error(`event page routed to ${target}, expected etherna`);

    // The server's own rebuild: its config (Phase B carrier: the signer pinned at
    // create, so the page reads GET /api/events/:id?signer=…) and the checked head.
    const kit = await eventPageKit();
    if (!kit) return c.json({ ok: false, error: "The site runtime is unavailable right now", code: "RUNTIME_RELEASE_UNAVAILABLE" }, 503);
    const verdict = admitClientEventPage({ kit, config: pageConfig(apiUrl, eventId, gate.signer), head, received });
    if (!verdict.ok) {
      console.warn(`[site/deploy] browser-built page refused for ${eventId}: ${verdict.code} (${verdict.error})`);
      return c.json({ ok: false, error: verdict.error, code: verdict.code }, 409);
    }
    const collection = verdict.collection;

    // The page feed's next index, resolved BEFORE the upload (#943): a first
    // publish's feed has never been written, bee skips such a chunk for a minute
    // after a few misses, and resolving after the upload failed the deploy with
    // the page already up - and the retry uploaded it again. Once: the deploy
    // guard above keeps another deploy of this page from resolving the same index
    // during the upload. Only for a signing client, owned by the signer pinned at
    // create.
    const pagePrep = body.clientFeed === true
      ? await prepareEthernaFeedIndex({
          topic: Topic.fromString(eventPageFeedTopic(eventId)),
          batchId,
          ownerHex: gate.signer.replace(/^0x/, ""),
        })
      : null;

    // Five small objects; the runtime is linked from the release. Anonymously
    // readable once the root is offered (a site root's offer serves what it links).
    await uploadSiteObjects("etherna", batchId, collection);
    const contentHash = collection.root;
    await registerEthernaOffer(contentHash);

    // Event pages are exempt from the free-hosting gate (publishing an event must
    // never block on it) but their bytes still land in the ledger — it is the
    // capacity meter and the per-owner migration manifest for ALL hosted content.
    recordUpload(parentAddress, {
      ref: contentHash,
      bytes: collection.objects.reduce((n, o) => n + o.data.length, 0),
      kind: "event-site-deploy",
      batchId,
      target,
      note: eventId,
      // The page links the release: a re-stamp of the owner's page stops there.
      links: [kit.release.root],
    });

    // The page's feed is the ORGANISER's (#614): owned by the signer pinned at
    // create and signed in the browser, so no key but theirs can change what a
    // name following it shows. The platform never writes one - it used to, and
    // with no creator check any account could advance it (#679). A client that
    // cannot sign gets no feed at all, never a platform one. The browser signs
    // its OWN root node (it built it, and the stored root is checked against it).
    let feedManifestHash = "";
    let pageFeed: { owner: string; nextIndex: number } | undefined;
    let nameRecorded = true;
    if (body.clientFeed === true && pagePrep) {
      feedManifestHash = pagePrep.feedManifestHash;
      // The owner travels with the update so the browser refuses to sign a feed
      // it does not own.
      holdAfterMs = CLIENT_POINTER_HOLD_MS;
      pageFeed = { owner: gate.signer, nextIndex: Number(pagePrep.nextIndex) };
      // Etherna answers 402 to an anonymous /bzz/{manifest}/ without an offer.
      void registerEthernaOffer(feedManifestHash).catch((e) =>
        console.warn("[site/deploy] etherna feed-manifest offer failed (non-fatal):", e));
      // The page's name shows THIS build, whatever the feed later says (name-targets.ts).
      // Not recorded = the name still shows the previous build, so the response says so.
      nameRecorded = recordNameTarget(feedManifestHash, { kind: "event", id: eventId, owner: parentAddress, latestRef: contentHash });
    }

    // Does the name already follow this feed? Read-only chain state, so the
    // builder asks for a pointer signature only the first time (#614).
    let subEns: SiteDeploySubEns | undefined;
    if (subEnsLabel && feedManifestHash) {
      subEns = await checkSiteSubEns(subEnsLabel, parentAddress, feedManifestHash, "client");
    }

    // Whitelist the page and its feed on our gateway, as the site deploy does
    // (sites.ts). Without it our gateway refuses an event page outright - 403
    // for `eventtest` on 2026-09-21 - so only other people's nodes can serve
    // the organiser's own page (#613). Fire-and-forget: a whitelist failure
    // must not fail a deploy that has already landed.
    void whitelistHashes([contentHash, feedManifestHash].filter(Boolean)).catch((e) =>
      console.warn("[site/deploy] whitelist call failed:", e),
    );

    return c.json({
      ok: true,
      data: {
        contentHash,
        feedManifestHash,
        runtimeVersion: kit.version,
        ...(pageFeed ? { feedOwner: "client" as const, pageFeed } : {}),
        ...(subEns ? { subEns } : {}),
        ...(nameRecorded ? {} : { nameRecorded: false as const }),
      },
    });

  } catch (e) {
    if (isStorageBusy(e)) {
      console.warn(`[site/deploy] storage busy: ${e.message}`);
      c.header("Retry-After", STORAGE_BUSY_RETRY_AFTER_HEADER);
      return c.json(storageBusyBody(), 503);
    }
    console.error("[site/deploy]", e);
    return c.json({
      ok: false,
      error: e instanceof Error ? e.message : "Deploy failed",
    }, 500);

  } finally {
    endDeploy?.(holdAfterMs);
  }
});

export { site as siteRoute };
