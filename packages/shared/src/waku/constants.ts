/**
 * Waku content topic and protocol constants for WoCo event discovery.
 *
 * Content topic format: /{application}/{version}/{topic-name}/{encoding}
 */

export const WAKU_CONTENT_TOPIC = "/woco/1/event-announce/proto";

/** Waku cluster ID — custom cluster for self-hosted nwaku node */
export const WAKU_CLUSTER_ID = 42;

/** Shard index within the cluster */
export const WAKU_SHARD_INDEX = 0;

/** PubSub topic for static sharding: /waku/2/rs/{clusterId}/{shardIndex} */
export const WAKU_PUBSUB_TOPIC = `/waku/2/rs/${WAKU_CLUSTER_ID}/${WAKU_SHARD_INDEX}`;

/** Announcement actions */
export type WakuAnnounceAction = "created" | "listed" | "unlisted";
