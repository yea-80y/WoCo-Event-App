import type { Site, SiteEventsIndex, SiteEventEntry, SiteDirectoryEntry, EventFeed } from "@woco/shared";
import { authPost, authDelete, authGet, get } from "./client.js";

export interface SiteEventsFull {
  index: SiteEventsIndex;
  events: EventFeed[];
}

export async function publishSite(site: Site, events: SiteEventEntry[] = []) {
  return authPost<{ siteId: string }>("/api/sites", { site, events });
}

export async function uploadSiteImage(imageBase64: string, gatewayUrl?: string) {
  return authPost<{ imageRef: string }>("/api/sites/upload-image", {
    image: imageBase64,
    ...(gatewayUrl ? { gatewayUrl } : {}),
  });
}

export async function deploySite(siteId: string, opts: { apiUrl: string; gatewayUrl: string; wocoAppUrl?: string; site?: Site }) {
  return authPost<{ contentHash: string; feedManifestHash: string; siteUrl: string }>(
    `/api/sites/${siteId}/deploy`,
    opts,
  );
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
