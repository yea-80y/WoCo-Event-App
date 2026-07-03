import type { Site, SiteEventsIndex, SiteEventEntry, SiteDirectoryEntry, EventFeed } from "@woco/shared";
import { siteConfigTopic, multisiteFeedTopic, beeFeedUpdateIdentifier } from "@woco/shared";
import { authPost, authDelete, authGet, get } from "./client.js";
import { writeContentFeed, type ContentFeedSigner } from "../swarm/content-feed.js";
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
export async function publishSite(site: Site, events: SiteEventEntry[] = [], feedSigner?: ContentFeedSigner | null) {
  if (feedSigner) {
    await writeContentFeed({
      signerPrivKey: feedSigner.privKey,
      topic: siteConfigTopic(site.siteId),
      data: { ...site, updatedAt: Date.now() },
    });
    return authPost<{ siteId: string }>("/api/sites", { site, events, siteFeedSigner: feedSigner.address });
  }
  return authPost<{ siteId: string }>("/api/sites", { site, events });
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
    const bin = atob(rootChunkPayloadB64);
    const payload = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) payload[i] = bin.charCodeAt(i);
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
