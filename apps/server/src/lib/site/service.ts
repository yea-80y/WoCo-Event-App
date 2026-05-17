import { Topic } from "@ethersphere/bee-js";
import { siteCreatorDirectoryTopic } from "@woco/shared";
import type { SiteDirectoryEntry, SiteDirectory } from "@woco/shared";
import { readFeedPage, readFeedPageStrict, writeFeedPage, encodeJsonFeed, decodeJsonFeed } from "../swarm/feeds.js";

const DIR_PAGE_LIMIT = 4096;

// ── Read ─────────────────────────────────────────────────────────────────────

// In-memory memo for getCreatorSites — collapses burst reads when the
// creator portal mounts AND repeat loads across tabs/refreshes. 5 minutes
// matches CREATOR_EVENTS_MEMO_TTL_MS. Upsert paths bypass with
// { fresh: true } and invalidate on write so a newly published / deployed
// site appears immediately for its author.
const CREATOR_SITES_MEMO_TTL_MS = 5 * 60_000;
const _creatorSitesMemo = new Map<string, { at: number; data: SiteDirectoryEntry[] }>();
const _creatorSitesInFlight = new Map<string, Promise<SiteDirectoryEntry[]>>();

export function invalidateCreatorSitesCache(ethAddress: string): void {
  _creatorSitesMemo.delete(ethAddress.toLowerCase());
}

export async function getCreatorSites(
  ethAddress: string,
  opts: { fresh?: boolean } = {},
): Promise<SiteDirectoryEntry[]> {
  const key = ethAddress.toLowerCase();
  if (!opts.fresh) {
    const memo = _creatorSitesMemo.get(key);
    if (memo && Date.now() - memo.at < CREATOR_SITES_MEMO_TTL_MS) return memo.data;
    const inFlight = _creatorSitesInFlight.get(key);
    if (inFlight) return inFlight;
  }

  const load = (async () => {
    const page0 = await readFeedPage(Topic.fromString(siteCreatorDirectoryTopic(ethAddress)));
    if (!page0) return [];
    const dir = decodeJsonFeed<SiteDirectory>(page0);
    if (!dir) return [];

    const totalPages = dir.pages ?? 0;
    if (totalPages === 0) return [...dir.entries];

    const overflow = await Promise.all(
      Array.from({ length: totalPages }, (_, i) =>
        readFeedPage(Topic.fromString(siteCreatorDirectoryTopic(ethAddress, i + 1))),
      ),
    );
    const all = [...dir.entries];
    for (const pageData of overflow) {
      if (!pageData) break;
      const decoded = decodeJsonFeed<SiteDirectory>(pageData);
      if (decoded?.entries) all.push(...decoded.entries);
    }
    return all;
  })();

  _creatorSitesInFlight.set(key, load);
  try {
    const data = await load;
    // Only memoize populated results. readFeedPage() swallows transient
    // errors into null (returning []), which would otherwise pin an empty
    // response for CREATOR_SITES_MEMO_TTL_MS — exactly the "navigate away,
    // come back" symptom on first creator-portal load.
    if (data.length > 0) {
      _creatorSitesMemo.set(key, { at: Date.now(), data });
    }
    return data;
  } finally {
    _creatorSitesInFlight.delete(key);
  }
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
 * Strict read of the creator's site directory for the WRITE path. Returns
 * the full prior contents or throws on any transient read error. Bootstrap
 * (page 0 absent) returns [] — safe to write the first site.
 *
 * MUST be used in place of getCreatorSites() before any directory rewrite —
 * a [] from a transient Swarm failure would otherwise cause upsert to
 * overwrite the directory with just the new entry, wiping every other site
 * the creator owns.
 */
async function readCreatorSitesStrict(ethAddress: string): Promise<SiteDirectoryEntry[]> {
  const page0 = await readFeedPageStrict(Topic.fromString(siteCreatorDirectoryTopic(ethAddress)));
  if (page0.status === "error") {
    throw new Error(`Site directory read failed (page 0) — refusing to write: ${page0.error.message}`);
  }
  if (page0.status === "absent") return [];

  const dir = decodeJsonFeed<SiteDirectory>(page0.data);
  if (!dir) {
    throw new Error("Site directory page 0 decoded to null — refusing to write");
  }

  const all = [...dir.entries];
  const totalPages = dir.pages ?? 0;
  for (let p = 1; p <= totalPages; p++) {
    const overflow = await readFeedPageStrict(Topic.fromString(siteCreatorDirectoryTopic(ethAddress, p)));
    if (overflow.status === "error") {
      throw new Error(`Site directory read failed (overflow page ${p}) — refusing to write: ${overflow.error.message}`);
    }
    if (overflow.status === "absent") break;
    const decoded = decodeJsonFeed<SiteDirectory>(overflow.data);
    if (decoded?.entries) all.push(...decoded.entries);
  }
  return all;
}

/**
 * Upsert a site entry into the creator's directory feed.
 * Existing entry for the same siteId is replaced (updates feedHash, deployedUrl, etc).
 *
 * Throws if the prior directory state can't be read confidently — refuses
 * to write rather than risk overwriting the directory with a partial view.
 * Callers (publish / deploy) invoke this fire-and-forget so the throw
 * surfaces as a logged warning; the published site itself is unaffected.
 */
export async function upsertCreatorSite(ethAddress: string, entry: SiteDirectoryEntry): Promise<void> {
  const existing = await readCreatorSitesStrict(ethAddress);
  const filtered = existing.filter((e) => e.siteId !== entry.siteId);
  const updated = [entry, ...filtered]; // most-recently-published first
  await writeDirectoryPages(updated, (p) => siteCreatorDirectoryTopic(ethAddress, p));
  invalidateCreatorSitesCache(ethAddress);
  console.log(`[site] Creator directory updated for ${ethAddress}: ${updated.length} site(s)`);
}
