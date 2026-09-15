/**
 * The pages an organiser's own names may point at, found through the feeds
 * that carry each name: a site's `subEnsLabel` and an event's.
 *
 * A feed only CLAIMS a name. It is client-signed, so a modified client can
 * write any label into it; whether this account holds the name and whether it
 * loads is decided by the chain read in `sub-ens/name-records.ts`, never here.
 */

import type { EventFeed } from "@woco/shared";
import { isPastEvent } from "../utils/events.js";
import { settleInBatches } from "../utils/settle-in-batches.js";

export interface PageName {
  label: string;
  title: string;
}

interface SiteCandidate {
  label?: string;
  title: string;
}

interface EventCandidate {
  label?: string;
  title: string;
  startDate: string;
  endDate?: string;
}

/**
 * Sites first: a venue's site outlives any one event, so when both claim a name
 * the site's title is shown. Events that have ended are left out, since the
 * sheet is for something a person can still go to.
 */
export function pageNamesFrom(
  sites: readonly SiteCandidate[],
  events: readonly EventCandidate[],
  now: number = Date.now(),
): PageName[] {
  const pages = new Map<string, PageName>();
  const add = (label: string | undefined, title: string) => {
    const key = label?.trim().toLowerCase();
    if (key && !pages.has(key)) pages.set(key, { label: key, title });
  };
  for (const site of sites) add(site.label, site.title);
  for (const event of events) if (!isPastEvent(event, now)) add(event.label, event.title);
  return [...pages.values()];
}

/**
 * Never prompts. Events come from the public by-creator list; sites from the
 * organiser's own list, an authenticated read, so without a session on this
 * device only a list already cached here is used.
 */
export async function readMyPages(owner: string, hasSession: boolean): Promise<PageName[]> {
  const [events, sites] = await Promise.all([readEvents(owner), readSites(owner, hasSession)]);
  return pageNamesFrom(sites, events);
}

async function readEvents(owner: string): Promise<EventCandidate[]> {
  const [{ getEventsByCreatorResult, getEvent }, { cacheGet, cacheKey }] = await Promise.all([
    import("../api/events.js"),
    import("../cache/cache.js"),
  ]);
  const list = await getEventsByCreatorResult(owner);
  const upcoming = (list.ok ? list.data ?? [] : []).filter((entry) => !isPastEvent(entry));
  // A feed this device already holds costs no request.
  const reads = await settleInBatches(upcoming, 4, async (entry) =>
    cacheGet<EventFeed>(cacheKey.event(entry.eventId)) ??
    getEvent(entry.eventId, entry.apiUrl, entry.creatorFeedSigner),
  );
  return reads.flatMap((read) =>
    read.status === "fulfilled" && read.value
      ? [{ label: read.value.subEnsLabel, title: read.value.title, startDate: read.value.startDate, endDate: read.value.endDate }]
      : [],
  );
}

async function readSites(owner: string, hasSession: boolean): Promise<SiteCandidate[]> {
  const [{ getMySitesSWR }, { loadSite }] = await Promise.all([
    import("../api/creator-cache.js"),
    import("../api/sites.js"),
  ]);
  const swr = getMySitesSWR(owner);
  const entries = swr.cached ?? (hasSession ? (await swr.refresh()).data ?? [] : []);
  const reads = await settleInBatches(entries, 4, (entry) => loadSite(entry.siteId));
  return reads.flatMap((read, i) =>
    read.status === "fulfilled" && read.value.ok && read.value.data
      ? [{ label: read.value.data.subEnsLabel, title: entries[i]!.brandName }]
      : [],
  );
}
