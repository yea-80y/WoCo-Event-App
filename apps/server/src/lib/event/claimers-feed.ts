/**
 * Paged claimers feed.
 *
 * A single JSON feed page holds ~30 realistic entries before encodeJsonFeed's
 * post-gzip 4096-byte limit throws — a ceiling any real event clears. Pages
 * fix it the same way the user-collection feed does: the legacy v1 single
 * page IS page 0 (no migration), and entries spill onto `/pN` pages when the
 * tail page is full. Pages are contiguous by construction — a page is only
 * ever created by spilling from a full predecessor — so readers probe until
 * the first missing page.
 *
 * All writes MUST go through the per-series claimers queue in
 * claim-service.ts (`enqueueClaimersUpdate` / `enqueueClaimersAttach`): these
 * are read-modify-write sequences over multiple pages, and two interleaved
 * writers lose entries.
 *
 * The planners are pure (IO injected via `fits`) so the spill and
 * move-on-overflow behaviour is unit-testable without a bee node.
 */
import type { ClaimerEntry, ClaimersFeed } from "@woco/shared";
import { readFeedPage, writeFeedPage, decodeJsonFeed, encodeJsonFeed } from "../swarm/feeds.js";
import { topicClaimers } from "../swarm/topics.js";

/** Spill early rather than pack to the byte limit: an entry can GROW later
 *  (save-order attaches an orderRef), and a page written at the byte limit
 *  would have no room for that rewrite. 20 × worst-case entry ≈ 3KB gzipped. */
export const CLAIMERS_SOFT_CAP = 20;

/** Runaway guard, same role as COLLECTION_MAX_PAGES — ~160k entries. */
export const CLAIMERS_MAX_PAGES = 8192;

export type FitsFn = (feed: ClaimersFeed) => boolean;

/** True when the feed encodes within the 4096-byte page (post-gzip). */
export const encodeFits: FitsFn = (feed) => {
  try {
    encodeJsonFeed(feed);
    return true;
  } catch (err) {
    if (err instanceof RangeError) return false;
    throw err;
  }
};

export async function readClaimersPages(seriesId: string): Promise<ClaimersFeed[]> {
  const pages: ClaimersFeed[] = [];
  for (let i = 0; i < CLAIMERS_MAX_PAGES; i++) {
    const raw = await readFeedPage(topicClaimers(seriesId, i));
    if (!raw) break;
    const parsed = decodeJsonFeed<ClaimersFeed>(raw);
    if (!parsed) break;
    pages.push(parsed);
  }
  return pages;
}

export async function readAllClaimers(seriesId: string): Promise<ClaimerEntry[]> {
  return (await readClaimersPages(seriesId)).flatMap((p) => p.claimers);
}

export interface PageWrite {
  pageIdx: number;
  feed: ClaimersFeed;
}

/**
 * Plan appending one entry. Returns null when the edition already exists on
 * any page (idempotent — editions are unique per series). Appends to the
 * tail page while it is under the soft cap and still encodes; otherwise
 * opens the next page.
 */
export function planClaimerAppend(
  pages: ClaimersFeed[],
  seriesId: string,
  entry: ClaimerEntry,
  updatedAt: string,
  fits: FitsFn,
  softCap: number = CLAIMERS_SOFT_CAP,
): PageWrite | null {
  if (pages.some((p) => p.claimers.some((c) => c.edition === entry.edition))) {
    return null;
  }
  if (pages.length > 0) {
    const tailIdx = pages.length - 1;
    const tail = pages[tailIdx];
    if (tail.claimers.length < softCap) {
      const candidate: ClaimersFeed = { ...tail, claimers: [...tail.claimers, entry], updatedAt };
      if (fits(candidate)) return { pageIdx: tailIdx, feed: candidate };
    }
  }
  return {
    pageIdx: pages.length,
    feed: { v: 1, seriesId, claimers: [entry], updatedAt },
  };
}

export interface AttachPlan {
  /** In-place page rewrites (entries updated, or shrunk by moves). */
  writes: PageWrite[];
  /** Updated entries that no longer fit their page — re-append these. */
  moved: ClaimerEntry[];
  matched: number;
}

/**
 * Plan attaching an orderRef to every matching entry that lacks one. A page
 * whose rewrite no longer encodes sheds the grown entries instead — they are
 * returned in `moved` for re-appending at the tail. Entries that already
 * carry an orderRef are never touched.
 */
export function planOrderRefAttach(
  pages: ClaimersFeed[],
  isMatch: (c: ClaimerEntry) => boolean,
  orderRef: string,
  updatedAt: string,
  fits: FitsFn,
): AttachPlan {
  const writes: PageWrite[] = [];
  const moved: ClaimerEntry[] = [];
  let matched = 0;

  pages.forEach((page, pageIdx) => {
    const updatedEditions = new Set<number>();
    const updated = page.claimers.map((c) => {
      if (isMatch(c) && !c.orderRef) {
        updatedEditions.add(c.edition);
        return { ...c, orderRef };
      }
      return c;
    });
    if (updatedEditions.size === 0) return;
    matched += updatedEditions.size;

    const candidate: ClaimersFeed = { ...page, claimers: updated, updatedAt };
    if (fits(candidate)) {
      writes.push({ pageIdx, feed: candidate });
      return;
    }
    writes.push({
      pageIdx,
      feed: { ...page, claimers: updated.filter((c) => !updatedEditions.has(c.edition)), updatedAt },
    });
    moved.push(...updated.filter((c) => updatedEditions.has(c.edition)));
  });

  return { writes, moved, matched };
}

/** Append one claimer entry. Caller must hold the per-series claimers queue. */
export async function appendClaimerEntry(seriesId: string, entry: ClaimerEntry): Promise<void> {
  const pages = await readClaimersPages(seriesId);
  const plan = planClaimerAppend(pages, seriesId, entry, new Date().toISOString(), encodeFits);
  if (!plan) return; // duplicate write of the same edition
  if (plan.pageIdx >= CLAIMERS_MAX_PAGES) {
    throw new Error(`Claimers feed exceeds ${CLAIMERS_MAX_PAGES} pages — refusing further writes`);
  }
  await writeFeedPage(topicClaimers(seriesId, plan.pageIdx), encodeJsonFeed(plan.feed));
  console.log(
    `[claim] Claimers page ${plan.pageIdx} updated: ${plan.feed.claimers.length} entries on page`,
  );
}

/**
 * Attach an orderRef to every matching entry lacking one; returns how many
 * were updated. Caller must hold the per-series claimers queue.
 */
export async function attachOrderRefToClaimers(
  seriesId: string,
  isMatch: (c: ClaimerEntry) => boolean,
  orderRef: string,
): Promise<number> {
  const pages = await readClaimersPages(seriesId);
  const updatedAt = new Date().toISOString();
  const plan = planOrderRefAttach(pages, isMatch, orderRef, updatedAt, encodeFits);
  if (plan.matched === 0) return 0;

  // Apply in-place rewrites to a working copy, then re-append any moved
  // entries so they land on (or open) the tail page.
  const working = [...pages];
  const dirty = new Set<number>();
  for (const w of plan.writes) {
    working[w.pageIdx] = w.feed;
    dirty.add(w.pageIdx);
  }
  for (const m of plan.moved) {
    const ap = planClaimerAppend(working, seriesId, m, updatedAt, encodeFits);
    if (!ap) continue; // cannot happen: the edition was just removed from its page
    if (ap.pageIdx >= CLAIMERS_MAX_PAGES) {
      throw new Error(`Claimers feed exceeds ${CLAIMERS_MAX_PAGES} pages — refusing further writes`);
    }
    working[ap.pageIdx] = ap.feed;
    dirty.add(ap.pageIdx);
  }
  for (const pageIdx of [...dirty].sort((a, b) => a - b)) {
    await writeFeedPage(topicClaimers(seriesId, pageIdx), encodeJsonFeed(working[pageIdx]));
  }
  return plan.matched;
}
