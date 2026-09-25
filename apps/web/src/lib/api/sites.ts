import type { Site, SiteEventsIndex, SiteEventEntry, SiteDirectoryEntry, EventFeed, SiteDeploySubEns, ApiResponse } from "@woco/shared";
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
) {
  const gw = { gatewayUrl };
  if (feedSigner) {
    await writeContentFeed({
      signerPrivKey: feedSigner.privKey,
      topic: siteConfigTopic(site.siteId),
      data: { ...site, updatedAt: Date.now() },
      route: feedRouteFor(gatewayUrl),
    });
    return authPost<{ siteId: string }>("/api/sites", { site, events, siteFeedSigner: feedSigner.address, ...gw });
  }
  return authPost<{ siteId: string }>("/api/sites", { site, events, ...gw });
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
  /** Present when the pointer feed is client-owned — the update we must sign. */
  multisiteFeed?: { nextIndex: number; rootChunkPayloadB64: string };
  /**
   * The site's sub-ENS name, when it has one. The deploy writes no name: the
   * name points at this site's feed manifest and follows every publish, and
   * `awaiting_signature` means the HOLDER must sign that pointer once.
   */
  subEns?: SiteDeploySubEns;
}

/**
 * Deploy a site. With a `feedSigner` on a client-owned site the server hands
 * back the sequence-feed update material and the OWNER signs the pointer-feed
 * update here (identifier derived LOCALLY from siteId — never trusted from the
 * response). The payload is the deployed collection's root chunk, so what the
 * feed serves is exactly what the server reported deploying.
 */
export async function deploySite(
  siteId: string,
  opts: { apiUrl: string; gatewayUrl: string; wocoAppUrl?: string; site?: Site },
  feedSigner?: ContentFeedSigner | null,
) {
  const res = await authPost<DeploySiteResult>(
    `/api/sites/${siteId}/deploy`,
    { ...opts, ...(feedSigner ? { clientFeed: true } : {}) },
  );
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
  pageFeed?: { owner: string; nextIndex: number; rootChunkPayloadB64: string };
  /** The name's state against the page feed, when a name was sent (#614). */
  subEns?: SiteDeploySubEns;
}

/**
 * Publish an event page (#614). With a feed signer the page's feed is the
 * organiser's own: the server prepares the update and it is signed HERE, only
 * when the server prepared it for this very signer and its bytes are the page
 * that was deployed. `feedSigned` says whether that happened - a name may
 * follow the feed only then, never on the server's word alone.
 */
export async function deployEventPage(
  eventId: string,
  opts: { apiUrl: string; gatewayUrl: string; subEnsLabel?: string },
  feedSigner?: ContentFeedSigner | null,
): Promise<ApiResponse<DeployEventPageResult> & { feedSigned: boolean }> {
  const res = await authPost<DeployEventPageResult>("/api/site/deploy", {
    eventId,
    apiUrl: opts.apiUrl,
    gatewayUrl: opts.gatewayUrl,
    ...(opts.subEnsLabel ? { subEnsLabel: opts.subEnsLabel } : {}),
    ...(feedSigner ? { clientFeed: true } : {}),
  });
  const pageFeed = res.ok ? res.data?.pageFeed : undefined;
  if (!res.ok || !res.data || !pageFeed || !feedSigner) return { ...res, feedSigned: false };

  if (pageFeed.owner.toLowerCase() !== feedSigner.address.toLowerCase()) {
    throw new Error("The page feed was prepared for a different key - refusing to sign it");
  }
  const payload = base64ToBytes(pageFeed.rootChunkPayloadB64);
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
