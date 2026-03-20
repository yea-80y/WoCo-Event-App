/**
 * Waku index announcement publisher.
 *
 * Announces this server's event index on the Waku network so other clients
 * and servers can discover it. Any node can maintain and announce its own
 * index — this is the decentralised discovery unlock.
 *
 * Published on:
 * - Server startup (after Waku connects + directory loaded)
 * - Every hour to stay visible within the 48h Store window
 */
import {
  WAKU_INDEX_ANNOUNCE_TOPIC,
  WAKU_SHARD_INDEX,
  encodeIndexAnnouncement,
  type IndexAnnouncement,
} from "@woco/shared";
import { getWakuNode, isWakuEnabled } from "./client.js";
import { listEvents } from "../event/service.js";
import { getPlatformOwner } from "../../config/swarm.js";

let _intervalId: ReturnType<typeof setInterval> | null = null;

const REPUBLISH_INTERVAL = 60 * 60 * 1000; // 1 hour

/**
 * Publish an index announcement for this server's event directory.
 */
export async function publishIndexAnnouncement(): Promise<void> {
  if (!isWakuEnabled()) return;

  try {
    const node = await getWakuNode();
    if (!node) return;

    const events = await listEvents();
    const owner = getPlatformOwner();

    const announcement: IndexAnnouncement = {
      maintainer: owner.toHex(),
      swarmFeedTopic: "woco/event/directory",
      swarmSignerAddress: owner.toHex(),
      eventCount: events.length,
      categories: [],
      region: "",
      updatedAt: new Date().toISOString(),
      apiUrl: process.env.PUBLIC_API_URL || "",
    };

    const encoder = node.createEncoder({
      contentTopic: WAKU_INDEX_ANNOUNCE_TOPIC,
      shardId: WAKU_SHARD_INDEX,
    });

    const payload = encodeIndexAnnouncement(announcement);
    await node.lightPush.send(encoder, { payload });
    console.log(`[waku] Published index announcement: ${events.length} events, signer=${announcement.swarmSignerAddress}`);
  } catch (err) {
    console.error("[waku] Failed to publish index announcement:", err instanceof Error ? err.message : err);
  }
}

/**
 * Start periodic index announcement republishing. Call once at server startup.
 */
export function startIndexAnnounceRepublish(): void {
  if (_intervalId) return;
  _intervalId = setInterval(() => {
    publishIndexAnnouncement().catch(() => {});
  }, REPUBLISH_INTERVAL);
}

/**
 * Stop periodic index announcement republishing.
 */
export function stopIndexAnnounceRepublish(): void {
  if (_intervalId) {
    clearInterval(_intervalId);
    _intervalId = null;
  }
}
