import { Topic } from "@ethersphere/bee-js";

/**
 * Feed topic helpers.
 * IMPORTANT: These strings are stable - changing them changes the feed address.
 */

const EVENT_NS = "woco/event";
const POD_NS = "woco/pod";

export const topicEventDirectory = () =>
  Topic.fromString(`${EVENT_NS}/directory`);

export const topicEvent = (eventId: string) =>
  Topic.fromString(`${EVENT_NS}/${eventId}`);

/**
 * Editions feed topic. Page 0 is the base topic, additional pages
 * are suffixed with /p{pageIndex} to support >127 tickets per series.
 */
export const topicEditions = (seriesId: string, page = 0) =>
  Topic.fromString(
    page === 0
      ? `${POD_NS}/editions/${seriesId}`
      : `${POD_NS}/editions/${seriesId}/p${page}`,
  );

/**
 * Claims feed topic. Same pagination scheme as editions.
 */
export const topicClaims = (seriesId: string, page = 0) =>
  Topic.fromString(
    page === 0
      ? `${POD_NS}/claims/${seriesId}`
      : `${POD_NS}/claims/${seriesId}/p${page}`,
  );

export const topicClaimers = (seriesId: string) =>
  Topic.fromString(`${POD_NS}/claimers/${seriesId}`);

export const topicUserCollection = (ethAddress: string) =>
  Topic.fromString(`${POD_NS}/collection/${ethAddress.toLowerCase()}`);

export const topicCreator = (creatorPodKey: string) =>
  Topic.fromString(`${POD_NS}/creator/${creatorPodKey}`);

// ---------------------------------------------------------------------------
// Pagination helpers
// ---------------------------------------------------------------------------

/** How many ticket slots fit on page 0 (slot 0 = metadata). */
export const PAGE_0_CAPACITY = 127;

/** How many ticket slots fit on pages 1+. */
export const PAGE_N_CAPACITY = 128;

/** Calculate how many edition pages are needed for a given supply. */
export function editionPageCount(totalSupply: number): number {
  if (totalSupply <= PAGE_0_CAPACITY) return 1;
  return 1 + Math.ceil((totalSupply - PAGE_0_CAPACITY) / PAGE_N_CAPACITY);
}
