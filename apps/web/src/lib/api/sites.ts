import type { Site, SiteEventsIndex, SiteEventEntry } from "@woco/shared";
import { authPost, authDelete, get } from "./client.js";

export async function publishSite(site: Site, events: SiteEventEntry[] = []) {
  return authPost<{ siteId: string }>("/api/sites", { site, events });
}

export async function getSiteEvents(siteId: string, apiUrl?: string) {
  return get<SiteEventsIndex>(`/api/sites/${siteId}/events`, apiUrl);
}

export async function removeSiteEvent(siteId: string, eventId: string) {
  return authDelete<SiteEventsIndex>(`/api/sites/${siteId}/events/${eventId}`);
}
