/**
 * Waku content topic and protocol constants for WoCo event discovery.
 *
 * Content topic format: /{application}/{version}/{topic-name}/{encoding}
 */

export const WAKU_CONTENT_TOPIC = "/woco/1/event-announce/proto";

/** Waku cluster ID — use the default public Waku network */
export const WAKU_CLUSTER_ID = 1;

/** Announcement actions */
export type WakuAnnounceAction = "created" | "listed" | "unlisted";
