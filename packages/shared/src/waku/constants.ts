/**
 * Waku content topic and protocol constants for WoCo event discovery.
 *
 * Content topic format: /{application}/{version}/{topic-name}/{encoding}
 */

/** Real-time event announcements (create/list/unlist). */
export const WAKU_CONTENT_TOPIC = "/woco/1/event-announce/proto";

/** Index announcements — "I maintain an index at Swarm feed X". */
export const WAKU_INDEX_ANNOUNCE_TOPIC = "/woco/1/index-announce/proto";

/** Waku cluster ID — custom cluster for self-hosted nwaku node */
export const WAKU_CLUSTER_ID = 42;

/** Shard index within the cluster */
export const WAKU_SHARD_INDEX = 0;

/** PubSub topic for static sharding: /waku/2/rs/{clusterId}/{shardIndex} */
export const WAKU_PUBSUB_TOPIC = `/waku/2/rs/${WAKU_CLUSTER_ID}/${WAKU_SHARD_INDEX}`;

/** Announcement actions */
export type WakuAnnounceAction = "created" | "listed" | "unlisted";

/** Known event categories — used for category-specific Waku content topics. */
export const WAKU_EVENT_CATEGORIES = [
  "conference",
  "meetup",
  "hackathon",
  "music",
  "art",
  "workshop",
  "social",
  "sports",
  "other",
] as const;

export type WakuEventCategory = (typeof WAKU_EVENT_CATEGORIES)[number];

/** Build a category-specific content topic: /woco/1/events/{category}/proto */
export function wakuCategoryTopic(category: string): string {
  return `/woco/1/events/${category.toLowerCase()}/proto`;
}
