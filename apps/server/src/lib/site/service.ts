import { Topic } from "@ethersphere/bee-js";
import { siteCreatorDirectoryTopic } from "@woco/shared";
import type { SiteDirectoryEntry, SiteDirectory } from "@woco/shared";
import { readFeedPage, writeFeedPage, encodeJsonFeed, decodeJsonFeed } from "../swarm/feeds.js";

const DIR_PAGE_LIMIT = 4096;

// ── Read ─────────────────────────────────────────────────────────────────────

export async function getCreatorSites(ethAddress: string): Promise<SiteDirectoryEntry[]> {
  const page0 = await readFeedPage(Topic.fromString(siteCreatorDirectoryTopic(ethAddress)));
  if (!page0) return [];
  const dir = decodeJsonFeed<SiteDirectory>(page0);
  if (!dir) return [];

  const all = [...dir.entries];
  const totalPages = dir.pages ?? 0;
  for (let p = 1; p <= totalPages; p++) {
    const pageData = await readFeedPage(Topic.fromString(siteCreatorDirectoryTopic(ethAddress, p)));
    if (!pageData) break;
    const overflow = decodeJsonFeed<SiteDirectory>(pageData);
    if (overflow?.entries) all.push(...overflow.entries);
  }
  return all;
}

// ── Write ────────────────────────────────────────────────────────────────────

async function writeDirectoryPages(entries: SiteDirectoryEntry[], topicFn: (p: number) => string): Promise<void> {
  const updatedAt = new Date().toISOString();
  const pages: SiteDirectoryEntry[][] = [];
  let current: SiteDirectoryEntry[] = [];

  for (const entry of entries) {
    current.push(entry);
    const test: SiteDirectory = { v: 1, entries: current, updatedAt, pages: 0 };
    if (JSON.stringify(test).length > DIR_PAGE_LIMIT) {
      current.pop();
      if (current.length > 0) pages.push(current);
      current = [entry];
    }
  }
  if (current.length > 0) pages.push(current);

  const page0: SiteDirectory = {
    v: 1,
    entries: pages[0] ?? [],
    updatedAt,
    pages: pages.length - 1,
  };
  await writeFeedPage(Topic.fromString(topicFn(0)), encodeJsonFeed(page0));

  for (let p = 1; p < pages.length; p++) {
    const overflow: SiteDirectory = { v: 1, entries: pages[p], updatedAt };
    await writeFeedPage(Topic.fromString(topicFn(p)), encodeJsonFeed(overflow));
  }
}

/**
 * Upsert a site entry into the creator's directory feed.
 * Existing entry for the same siteId is replaced (updates feedHash, deployedUrl, etc).
 */
export async function upsertCreatorSite(ethAddress: string, entry: SiteDirectoryEntry): Promise<void> {
  const existing = await getCreatorSites(ethAddress);
  const filtered = existing.filter((e) => e.siteId !== entry.siteId);
  const updated = [entry, ...filtered]; // most-recently-published first
  await writeDirectoryPages(updated, (p) => siteCreatorDirectoryTopic(ethAddress, p));
  console.log(`[site] Creator directory updated for ${ethAddress}: ${updated.length} site(s)`);
}
