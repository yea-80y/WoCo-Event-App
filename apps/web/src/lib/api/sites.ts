import type { Site, SiteEventsIndex, SiteEventEntry, SiteDirectoryEntry, EventFeed, SiteDeploySubEns, ApiResponse, EventPageConfig, EventPageHead } from "@woco/shared";
import {
  siteConfigTopic,
  multisiteFeedTopic,
  eventPageFeedTopic,
  beeFeedUpdateIdentifier,
  assertFeedUpdateMatches,
} from "@woco/shared";
import { authPost, authDelete, authGet, get } from "./client.js";
import { writeContentFeed, type ContentFeedSigner } from "../swarm/content-feed.js";
import { feedRouteFor } from "../swarm/gateways.js";
import { signAndUploadSoc } from "../swarm/client-soc.js";
import { retryOnceIfStorageBusy, type StorageBusyRetryOptions } from "./storage-busy.js";
import { rebuildForNewRuntime, storedSomethingElse } from "./site-deploy-verdict.js";

export interface SiteEventsFull {
  index: SiteEventsIndex;
  events: EventFeed[];
}

/**
 * Publish a site. With a `feedSigner` (Phase B for sites) the full Site —
 * pages included, the SOC writer auto-pages — is signed + uploaded as the
 * OWNER's client-owned SOC first, and the server only writes a `SitePointer`
 * + the (still platform-signed) events index and directory carrier. Without a
 * signer (kinds that can't own feeds yet) the legacy platform-written path runs.
 *
 * A new site's first save can be refused for about a minute (`storage-busy.ts`,
 * #943): the server request alone is sent once more after the wait - the config
 * SOC above it is already up and is not signed again.
 */
export async function publishSite(
  site: Site,
  events: SiteEventEntry[],
  feedSigner: ContentFeedSigner | null | undefined,
  /** The site's home gateway — routes the config SOC's stamp AND the server's
   *  pointer/events-index feed writes onto the site's own batch (#48). Required,
   *  as `deploySite`'s is: a missing one stamped the config on WoCo while the
   *  deploy went to Etherna. */
  gatewayUrl: string,
  retry: StorageBusyRetryOptions = {},
) {
  const gw = { gatewayUrl };
  if (feedSigner) {
    await writeContentFeed({
      signerPrivKey: feedSigner.privKey,
      topic: siteConfigTopic(site.siteId),
      data: { ...site, updatedAt: Date.now() },
      route: feedRouteFor(gatewayUrl),
    });
    return retryOnceIfStorageBusy(
      () => authPost<{ siteId: string }>("/api/sites", { site, events, siteFeedSigner: feedSigner.address, ...gw }),
      retry,
    );
  }
  return retryOnceIfStorageBusy(() => authPost<{ siteId: string }>("/api/sites", { site, events, ...gw }), retry);
}

export async function uploadSiteImage(imageBase64: string, gatewayUrl?: string) {
  return authPost<{ imageRef: string }>("/api/sites/upload-image", {
    image: imageBase64,
    ...(gatewayUrl ? { gatewayUrl } : {}),
  });
}

export interface DeploySiteResult {
  contentHash: string;
  feedManifestHash: string;
  siteUrl: string;
  /** "client": the browser's build was admitted (#1032); "server": the old full-copy build. */
  builtBy?: "client" | "server";
  /** The runtime release a browser build linked; absent for a server build. */
  runtimeVersion?: number;
  /** Present when the pointer feed is client-owned — the update we must sign. */
  multisiteFeed?: { nextIndex: number; rootChunkPayloadB64: string };
  /**
   * The site's sub-ENS name, when it has one. The deploy writes no name: the
   * name points at this site's feed manifest and follows every publish, and
   * `awaiting_signature` means the HOLDER must sign that pointer once.
   */
  subEns?: SiteDeploySubEns;
  /** The server could not record this build for the name: it still shows the previous one. */
  nameRecorded?: false;
}

/**
 * Deploy a site. With a `feedSigner` on a client-owned site the server hands
 * back the sequence-feed update material and the OWNER signs the pointer-feed
 * update here (identifier derived LOCALLY from siteId — never trusted from the
 * response). The payload is the deployed collection's root chunk, so what the
 * feed serves is exactly what the server reported deploying. A first deploy the
 * server refused as busy (nothing was uploaded) is sent once more after the wait.
 *
 * The site is built HERE on the shared runtime release (#1032) and the server
 * stores it only if its own rebuild is identical; there is no server build to
 * fall back to (slice 4). A release published between the kit read and the
 * deploy costs one rebuild.
 */
export async function deploySite(
  siteId: string,
  /** `site` and `parentAddress` are required: every website is built here (null = not signed in). */
  opts: { apiUrl: string; gatewayUrl: string; wocoAppUrl?: string; site: Site; parentAddress: string | null },
  feedSigner?: ContentFeedSigner | null,
  retry: StorageBusyRetryOptions = {},
): Promise<ApiResponse<DeploySiteResult>> {
  const { parentAddress, site, ...request } = opts;
  if (!parentAddress) return { ok: false, error: "Sign in to publish your website." };
  const clientFeed = feedSigner ? { clientFeed: true } : {};
  const send = (body: Record<string, unknown>) =>
    retryOnceIfStorageBusy(() => authPost<DeploySiteResult>(`/api/sites/${siteId}/deploy`, body), retry);
  const build = () =>
    import("./site-collection.js").then((m) =>
      m.buildClientSiteCollection({
        site,
        parentAddress,
        apiUrl: request.apiUrl,
        gatewayUrl: request.gatewayUrl,
        wocoAppUrl: request.wocoAppUrl ?? "https://woco.eth.limo",
      }),
    );

  let attempt = await build();
  if (!attempt.ok) return attempt;
  let built = attempt.built;
  let res = await send({ ...request, site: built.site, collection: built.body, ...clientFeed });
  if (rebuildForNewRuntime(res)) {
    // A new runtime release landed between the kit read and the deploy: build on it once.
    attempt = await build();
    if (!attempt.ok) return attempt;
    built = attempt.built;
    res = await send({ ...request, site: built.site, collection: built.body, ...clientFeed });
  }
  if (storedSomethingElse(res, built.root)) {
    // The server admits only an identical rebuild, so this cannot happen short of
    // a server fault: never sign a pointer to a site we did not build.
    throw new Error("The server stored a different site than this browser built");
  }
  if (res.ok && res.data?.multisiteFeed && feedSigner) {
    const { nextIndex, rootChunkPayloadB64 } = res.data.multisiteFeed;
    const payload = base64ToBytes(rootChunkPayloadB64);
    assertFeedUpdateMatches(payload, res.data.contentHash);
    await signAndUploadSoc({
      signerPrivKey: feedSigner.privKey,
      identifier: beeFeedUpdateIdentifier(multisiteFeedTopic(siteId), nextIndex),
      payload,
      // Stamp on the same batch the deploy used (Etherna user batch when the
      // Etherna gateway was picked) — the feed must live where its content does.
      gatewayUrl: opts.gatewayUrl,
    });
  }
  return res;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export interface DeployEventPageResult {
  contentHash: string;
  /** The page feed's manifest; empty when this deploy prepared no feed. */
  feedManifestHash: string;
  /** Present only when the page feed is the organiser's own (#614). */
  feedOwner?: "client";
  /** Where to sign; WHAT to sign is this browser's own built root node (#1032). */
  pageFeed?: { owner: string; nextIndex: number };
  /** The runtime release the page linked (#1032). */
  runtimeVersion?: number;
  /** The name's state against the page feed, when a name was sent (#614). */
  subEns?: SiteDeploySubEns;
  /** The server could not record this build for the name: it still shows the previous one. */
  nameRecorded?: false;
}

/**
 * Publish an event page (#614). The page is built HERE on the shared runtime
 * release (#1032 slice 5): the server says what config it bakes and suggests the
 * head (`GET /api/site/:eventId/page-config`), this browser builds, and the
 * server stores the page only if its own rebuild is identical. With a feed
 * signer the page's feed is the organiser's own: the update is signed HERE over
 * the root node this browser built, only when the server prepared it for this
 * very signer and stored that very root. `feedSigned` says whether that happened
 * - a name may follow the feed only then, never on the server's word alone. A
 * first publish refused as busy (nothing was uploaded) is sent once more after
 * the wait; a release published mid-publish costs one rebuild.
 */
export async function deployEventPage(
  eventId: string,
  opts: { apiUrl: string; gatewayUrl: string; subEnsLabel?: string },
  feedSigner?: ContentFeedSigner | null,
  retry: StorageBusyRetryOptions = {},
): Promise<ApiResponse<DeployEventPageResult> & { feedSigned: boolean }> {
  const cfg = await authGet<{ config: EventPageConfig; head: EventPageHead }>(
    `/api/site/${encodeURIComponent(eventId)}/page-config?apiUrl=${encodeURIComponent(opts.apiUrl)}`,
  );
  if (!cfg.ok || !cfg.data) return { ok: false, error: cfg.ok ? "The page could not be prepared" : (cfg.error ?? "The page could not be prepared"), feedSigned: false };
  const { config, head } = cfg.data;
  const build = () =>
    import("./site-collection.js").then((m) => m.buildClientEventPageCollection({ apiUrl: opts.apiUrl, config, head }));
  const send = (body: { runtimeVersion: number; objects: string[] }) =>
    retryOnceIfStorageBusy(
      () =>
        authPost<DeployEventPageResult>("/api/site/deploy", {
          eventId,
          apiUrl: opts.apiUrl,
          gatewayUrl: opts.gatewayUrl,
          ...(opts.subEnsLabel ? { subEnsLabel: opts.subEnsLabel } : {}),
          ...(feedSigner ? { clientFeed: true } : {}),
          head,
          collection: body,
        }),
      retry,
    );

  let attempt = await build();
  if (!attempt.ok) return { ...attempt, feedSigned: false };
  let built = attempt.built;
  let res = await send(built.body);
  if (rebuildForNewRuntime(res)) {
    attempt = await build();
    if (!attempt.ok) return { ...attempt, feedSigned: false };
    built = attempt.built;
    res = await send(built.body);
  }
  if (res.ok && res.data && res.data.contentHash !== built.root) {
    // The server stores only its own identical rebuild: never sign a pointer to anything else.
    throw new Error("The server stored a different page than this browser built");
  }
  const pageFeed = res.ok ? res.data?.pageFeed : undefined;
  if (!res.ok || !res.data || !pageFeed || !feedSigner) return { ...res, feedSigned: false };

  if (pageFeed.owner.toLowerCase() !== feedSigner.address.toLowerCase()) {
    throw new Error("The page feed was prepared for a different key - refusing to sign it");
  }
  const payload = built.rootNode;
  assertFeedUpdateMatches(payload, res.data.contentHash);
  await signAndUploadSoc({
    signerPrivKey: feedSigner.privKey,
    // Derived here from the event id, never taken from the response.
    identifier: beeFeedUpdateIdentifier(eventPageFeedTopic(eventId), pageFeed.nextIndex),
    payload,
    gatewayUrl: opts.gatewayUrl,
  });
  return { ...res, feedSigned: true };
}

/** The latest site runtime release's version (#1032), or null when none can be read. */
export async function getSiteRuntimeVersion(apiUrl?: string): Promise<number | null> {
  const r = await get<{ version?: unknown }>("/api/sites/runtime", apiUrl).catch(() => null);
  const v = r?.ok ? r.data?.version : undefined;
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 1 ? v : null;
}

export async function loadSite(siteId: string, apiUrl?: string) {
  return get<Site>(`/api/sites/${siteId}`, apiUrl);
}

export async function getSiteEvents(siteId: string, apiUrl?: string) {
  return get<SiteEventsIndex>(`/api/sites/${siteId}/events`, apiUrl);
}

export async function getSiteEventsFull(siteId: string, apiUrl?: string) {
  return get<SiteEventsFull>(`/api/sites/${siteId}/events-full`, apiUrl);
}

export async function removeSiteEvent(siteId: string, eventId: string) {
  return authDelete<SiteEventsIndex>(`/api/sites/${siteId}/events/${eventId}`);
}

export async function addSiteEvent(siteId: string, eventId: string, featured = false) {
  return authPost<SiteEventsIndex>(`/api/sites/${siteId}/events`, { eventId, featured });
}

export async function getCreatorSites() {
  return authGet<SiteDirectoryEntry[]>("/api/sites/mine");
}
