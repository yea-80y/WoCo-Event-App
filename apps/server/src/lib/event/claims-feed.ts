/**
 * Claims feed reads + slot selection.
 *
 * The claims feed is the source of truth for which editions are sold: a binary
 * 4096-byte page per 128 editions, each 32-byte slot holding the Swarm ref of a
 * ClaimedTicket, or zeroes for unsold. Allocation reads it, picks the first zero
 * slot, and writes that slot back — so what the reader returns for a page it
 * cannot fetch decides whether a ticket is issued twice.
 *
 * `readFeedPage` cannot answer that: it collapses a Bee 404 and a transient
 * network/5xx/parse failure into the same `null`. On most feeds that is
 * harmless. Here "absent" is the normal state of every new series (a page is
 * only written when its first ticket sells) while "unreadable" must stop the
 * claim dead — so this feed uses the strict reader and keeps the two apart.
 *
 * `selectFreeSlot` is pure so that rule is testable without a bee node.
 */
import { decode4096, decode4096Claims, readFeedPageStrict } from "../swarm/feeds.js";
import { topicClaims } from "../swarm/topics.js";
import type { FeedReadStrictResult } from "../swarm/feeds.js";

export type StrictPageReader = (seriesId: string, page: number) => Promise<FeedReadStrictResult>;

/**
 * One claims page, or null when it has genuinely never been written. Throws
 * when the page exists but would not read — the caller must not proceed to
 * allocate or rewrite a slot on state it could not see.
 */
export async function readClaimsPageStrict(
  seriesId: string,
  page: number,
  /** Injectable so the absent-vs-error rule is testable without a bee node. */
  readPage: StrictPageReader = (id, p) => readFeedPageStrict(topicClaims(id, p)),
): Promise<Uint8Array | null> {
  const result = await readPage(seriesId, page);
  if (result.status === "absent") return null;
  if (result.status === "error") {
    console.error(`[claim] claims page ${page} unreadable for series ${seriesId}:`, result.error);
    throw new Error("Could not read the claims feed — try again");
  }
  return result.data;
}

/** A claims page paired with the editions page holding its ticket refs. */
export interface ClaimsPagePair {
  /** Null ONLY when provably never written — every slot on it is free. */
  claims: Uint8Array | null;
  /** Null when the editions page is missing; the page is skipped entirely. */
  editions: Uint8Array | null;
}

export interface FreeSlot {
  page: number;
  slot: number;
  ticketRef: string;
  /** The page's current bytes, to be rewritten with the new claim. Null means
   *  the page does not exist yet, so a blank page is the correct base. */
  claimsPage: Uint8Array | null;
}

/**
 * First unsold edition across the pages, in order. Slot 0 of page 0 holds the
 * series metadata ref, never a ticket. Returns null when the series is sold out
 * (or every editions page is missing).
 */
export function selectFreeSlot(pages: ClaimsPagePair[]): FreeSlot | null {
  for (let page = 0; page < pages.length; page++) {
    const { claims, editions } = pages[page];
    if (!editions) continue;

    // A never-written page means every slot on it is unsold. This is only sound
    // because the reader above refuses to return null for a page it failed to
    // fetch — otherwise a read blip would resell the whole page.
    const slots = claims ? decode4096Claims(claims) : new Array(128).fill("");
    const editionRefs = decode4096(editions);
    const startSlot = page === 0 ? 1 : 0;

    for (let slot = startSlot; slot < editionRefs.length; slot++) {
      if (slots[slot] === "") {
        return { page, slot, ticketRef: editionRefs[slot], claimsPage: claims };
      }
    }
  }
  return null;
}
