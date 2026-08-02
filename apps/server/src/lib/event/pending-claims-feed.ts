/**
 * Paged pending-claims feed — the same treatment claimers-feed.ts got, for the
 * same reason: one JSON feed page is 4096 bytes post-gzip, and a pending entry
 * is bigger than a claimer entry (sealed address + two Swarm refs + a UUID), so
 * a page tops out at ~16 entries. Decided requests are KEPT as history, so the
 * feed only ever grows — any event that runs an approval queue clears that
 * ceiling and then every further write throws.
 *
 * Layout mirrors claimers: the legacy v1 single page IS page 0 (no migration),
 * overflow spills onto `/pN`, and pages are contiguous by construction — a page
 * is only ever created by spilling from a full predecessor — so readers probe
 * until the first missing page.
 *
 * Moving an entry between pages is safe: `claimerSealed` is AES-GCM bound to
 * {seriesId, pendingId} (claimer-seal.ts), which is per-ENTRY context, not
 * per-page — the ciphertext still authenticates wherever the entry lands.
 *
 * All writes MUST go through the per-series pending queue in claim-service.ts
 * (`enqueuePendingOp`): these are read-modify-write sequences over multiple
 * pages, and claim-time appends interleave with organiser approve/reject.
 *
 * The planners are pure (IO injected via `fits`) so spill and move-on-overflow
 * are unit-testable without a bee node.
 */
import type { PendingClaimEntry, PendingClaimsFeed } from "@woco/shared";
import {
  readFeedPage,
  readFeedPageStrict,
  writeFeedPage,
  decodeJsonFeed,
  encodeJsonFeed,
  type FeedReadStrictResult,
} from "../swarm/feeds.js";
import { topicPendingClaims } from "../swarm/topics.js";

/**
 * Spill well before the byte limit: a pending entry GROWS when it is decided
 * (`decidedAt`, plus a rejection reason up to 500 chars). Measured against the
 * real encoder: 16 undecided entries fill a page, 12 survive a 100-char reason
 * each, 6 survive a 500-char one. Half the undecided ceiling leaves every entry
 * on a full page room to gain a decision without a move.
 */
export const PENDING_SOFT_CAP = 8;

/** Runaway guard, same role as CLAIMERS_MAX_PAGES — ~65k entries. */
export const PENDING_MAX_PAGES = 8192;

export type FitsFn = (feed: PendingClaimsFeed) => boolean;

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

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function readPendingPages(seriesId: string): Promise<PendingClaimsFeed[]> {
  const pages: PendingClaimsFeed[] = [];
  for (let i = 0; i < PENDING_MAX_PAGES; i++) {
    const raw = await readFeedPage(topicPendingClaims(seriesId, i));
    if (!raw) break;
    const parsed = decodeJsonFeed<PendingClaimsFeed>(raw);
    if (!parsed) break;
    pages.push(parsed);
  }
  return pages;
}

/**
 * Every page flattened into one feed-shaped view, so callers that only read
 * (`approvals.ts`, the claim-time duplicate check, `getClaimStatus`) keep
 * working against a single `pending` array. Null when page 0 was never written,
 * preserving the pre-paging "no feed" signal.
 */
export function mergePendingPages(
  seriesId: string,
  pages: PendingClaimsFeed[],
): PendingClaimsFeed | null {
  if (pages.length === 0) return null;
  return {
    v: 1,
    seriesId,
    pending: pages.flatMap((p) => p.pending),
    updatedAt: pages.reduce((latest, p) => (p.updatedAt > latest ? p.updatedAt : latest), ""),
  };
}

export type PendingPagesRead =
  | { status: "ok"; pages: PendingClaimsFeed[] }
  | { status: "error"; error: Error };

export type StrictPageReader = (
  seriesId: string,
  page: number,
) => Promise<FeedReadStrictResult>;

/**
 * Fail-closed paged read. Mandatory for every read-modify-write on this feed
 * (feeds.ts spells the rule out): `readFeedPage` collapses a transient Swarm
 * error into the same null it uses for "never written", and a writer that
 * believes a page is missing REPLACES it — a single read hiccup would publish a
 * page holding only the new entry and drop every request already on it. Those
 * requests would become undecidable while their claims-feed slots stayed
 * reserved forever.
 *
 * Any page that errors OR fails to decode aborts the whole read: probing stops
 * at the first gap, so an unreadable page also hides every page after it. Only
 * a true 404 ("absent") ends the chain.
 */
export async function readPendingPagesStrict(
  seriesId: string,
  /** Injectable so the fail-closed semantics are testable without a bee node. */
  readPage: StrictPageReader = (id, page) => readFeedPageStrict(topicPendingClaims(id, page)),
  /** Retry backoff for an errored page, mirroring the claims feed. On the paid
   *  approval path this read runs AFTER the claims slot is written, so failing
   *  it refunds a buyer whose seat is already reserved and strands that seat. */
  delaysMs: number[] = [300, 900],
): Promise<PendingPagesRead> {
  const pages: PendingClaimsFeed[] = [];
  for (let i = 0; i < PENDING_MAX_PAGES; i++) {
    let page = await readPage(seriesId, i);
    for (let attempt = 0; page.status === "error" && attempt < delaysMs.length; attempt++) {
      await new Promise((r) => setTimeout(r, delaysMs[attempt]));
      page = await readPage(seriesId, i);
    }
    if (page.status === "absent") break;
    if (page.status === "error") return { status: "error", error: page.error };
    const parsed = decodeJsonFeed<PendingClaimsFeed>(page.data);
    if (!parsed) {
      return {
        status: "error",
        error: new Error(`pending-claims page ${i} present but undecodable`),
      };
    }
    pages.push(parsed);
  }
  return { status: "ok", pages };
}

/** Strict read or throw — the write paths cannot proceed on a partial view. */
async function readPendingPagesForWrite(seriesId: string): Promise<PendingClaimsFeed[]> {
  const read = await readPendingPagesStrict(seriesId);
  if (read.status === "error") {
    throw new Error(`Could not read pending-claims feed: ${read.error.message}`);
  }
  return read.pages;
}

// ---------------------------------------------------------------------------
// Planners (pure)
// ---------------------------------------------------------------------------

export interface PageWrite {
  pageIdx: number;
  feed: PendingClaimsFeed;
}

/**
 * Plan appending one entry. Returns null when `pendingId` already exists on any
 * page (idempotent — pendingIds are UUIDs, so this only fires on a replayed
 * write). Appends to the tail page while it is under the soft cap and still
 * encodes; otherwise opens the next page.
 */
export function planPendingAppend(
  pages: PendingClaimsFeed[],
  seriesId: string,
  entry: PendingClaimEntry,
  updatedAt: string,
  fits: FitsFn,
  softCap: number = PENDING_SOFT_CAP,
): PageWrite | null {
  if (pages.some((p) => p.pending.some((e) => e.pendingId === entry.pendingId))) {
    return null;
  }
  if (pages.length > 0) {
    const tailIdx = pages.length - 1;
    const tail = pages[tailIdx];
    if (tail.pending.length < softCap) {
      const candidate: PendingClaimsFeed = {
        ...tail,
        pending: [...tail.pending, entry],
        updatedAt,
      };
      if (fits(candidate)) return { pageIdx: tailIdx, feed: candidate };
    }
  }
  return {
    pageIdx: pages.length,
    feed: { v: 1, seriesId, pending: [entry], updatedAt },
  };
}

/** The fields a decision stamps onto an entry. */
export type PendingDecision = Pick<PendingClaimEntry, "status" | "decidedAt" | "rejectionReason">;

export interface DecisionPlan {
  /** In-place page rewrites (entry updated, or the page shrunk by a move). */
  writes: PageWrite[];
  /** Decided entry that no longer fits its page — re-append it at the tail. */
  moved: PendingClaimEntry | null;
  /** False when no page holds a still-pending entry with that pendingId. */
  found: boolean;
}

/**
 * Plan stamping a decision onto the still-pending entry with `pendingId`. A
 * rejection reason can outgrow the page it sits on, in which case the entry is
 * shed from its page and returned in `moved` for re-appending at the tail —
 * safe because the sealed address is bound to the entry, not the page.
 */
export function planPendingDecision(
  pages: PendingClaimsFeed[],
  pendingId: string,
  decision: PendingDecision,
  updatedAt: string,
  fits: FitsFn,
): DecisionPlan {
  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const page = pages[pageIdx];
    const idx = page.pending.findIndex((e) => e.pendingId === pendingId && e.status === "pending");
    if (idx < 0) continue;

    const decided: PendingClaimEntry = { ...page.pending[idx], ...decision };
    const updated = [...page.pending];
    updated[idx] = decided;

    const candidate: PendingClaimsFeed = { ...page, pending: updated, updatedAt };
    if (fits(candidate)) {
      return { writes: [{ pageIdx, feed: candidate }], moved: null, found: true };
    }
    return {
      writes: [
        {
          pageIdx,
          feed: { ...page, pending: page.pending.filter((_, i) => i !== idx), updatedAt },
        },
      ],
      moved: decided,
      found: true,
    };
  }
  return { writes: [], moved: null, found: false };
}

// ---------------------------------------------------------------------------
// Writes — callers must hold the per-series pending queue
// ---------------------------------------------------------------------------

function assertPageBudget(pageIdx: number): void {
  if (pageIdx >= PENDING_MAX_PAGES) {
    throw new Error(`Pending-claims feed exceeds ${PENDING_MAX_PAGES} pages — refusing further writes`);
  }
}

/**
 * Append one pending request. Throws "Already requested" when the same claimer
 * already has an undecided entry — the check reads inside the queue, so it is
 * atomic against a concurrent append rather than a check-then-act.
 */
export async function appendPendingEntry(
  seriesId: string,
  entry: PendingClaimEntry,
  isSameClaimer: (e: PendingClaimEntry) => boolean,
): Promise<void> {
  const pages = await readPendingPagesForWrite(seriesId);
  if (pages.some((p) => p.pending.some((e) => e.status === "pending" && isSameClaimer(e)))) {
    throw new Error("Already requested");
  }
  const plan = planPendingAppend(pages, seriesId, entry, new Date().toISOString(), encodeFits);
  if (!plan) return; // replayed write of the same pendingId
  assertPageBudget(plan.pageIdx);
  await writeFeedPage(topicPendingClaims(seriesId, plan.pageIdx), encodeJsonFeed(plan.feed));
  console.log(
    `[claim] Pending-claims page ${plan.pageIdx} updated: ${plan.feed.pending.length} entries on page`,
  );
}

/**
 * Stamp a decision onto a still-pending entry. Returns false when the entry is
 * gone or already decided. Caller must hold the per-series pending queue.
 *
 * Pages are written in ascending index order, so a move writes the SHRUNK
 * source page before the tail page it lands on. Interrupted mid-move the entry
 * is therefore lost rather than duplicated, which is the safer failure: by the
 * time a decision is recorded the claims feed already carries its effect, so a
 * lost record leaves the organiser's queue in the intended end state, whereas a
 * duplicate would show a phantom still-pending request that could be REJECTED —
 * clearing the claims slot of an already-approved ticket.
 */
export async function markPendingDecided(
  seriesId: string,
  pendingId: string,
  decision: PendingDecision,
): Promise<boolean> {
  const pages = await readPendingPagesForWrite(seriesId);
  const updatedAt = new Date().toISOString();
  const plan = planPendingDecision(pages, pendingId, decision, updatedAt, encodeFits);
  if (!plan.found) return false;

  const working = [...pages];
  const dirty = new Set<number>();
  for (const w of plan.writes) {
    working[w.pageIdx] = w.feed;
    dirty.add(w.pageIdx);
  }
  if (plan.moved) {
    const ap = planPendingAppend(working, seriesId, plan.moved, updatedAt, encodeFits);
    // Cannot be null: the entry was just removed from its page above.
    if (ap) {
      assertPageBudget(ap.pageIdx);
      working[ap.pageIdx] = ap.feed;
      dirty.add(ap.pageIdx);
    }
  }
  // Encode EVERY dirty page before writing any of them. A move publishes the
  // shrunk source page first; if the tail then failed to encode, the entry
  // would already be gone from the feed with nowhere to land.
  const encoded = [...dirty]
    .sort((a, b) => a - b)
    .map((pageIdx) => ({ pageIdx, bytes: encodeJsonFeed(working[pageIdx]) }));
  for (const { pageIdx, bytes } of encoded) {
    await writeFeedPage(topicPendingClaims(seriesId, pageIdx), bytes);
  }
  return true;
}
