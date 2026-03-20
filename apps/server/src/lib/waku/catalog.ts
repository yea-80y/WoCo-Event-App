/**
 * Waku event catalog publisher.
 *
 * Publishes the full event directory as a single Waku message so that any
 * client connecting at any time can discover ALL events — not just those
 * created in the last 48 hours.
 *
 * Published on:
 * - Server startup (after Waku connects + directory loaded)
 * - After event create/list/unlist (directory changed)
 * - Every 30 minutes to keep Store fresh within the 48h window
 */
import {
  WAKU_CATALOG_TOPIC,
  WAKU_SHARD_INDEX,
  encodeEventCatalog,
  type CatalogEntry,
} from "@woco/shared";
import { getWakuNode, isWakuEnabled } from "./client.js";
import { listEvents } from "../event/service.js";

let _intervalId: ReturnType<typeof setInterval> | null = null;

const REPUBLISH_INTERVAL = 30 * 60 * 1000; // 30 minutes

/**
 * Publish the current event directory as a catalog message.
 * Call after any directory change, or periodically.
 */
export async function publishCatalog(): Promise<void> {
  if (!isWakuEnabled()) return;

  try {
    const node = await getWakuNode();
    if (!node) return;

    const events = await listEvents();
    const entries: CatalogEntry[] = events.map((e) => ({
      eventId: e.eventId,
      title: e.title,
      imageHash: e.imageHash,
      startDate: e.startDate,
      location: e.location,
      creatorAddress: e.creatorAddress,
      seriesCount: e.seriesCount,
      totalTickets: e.totalTickets,
      createdAt: e.createdAt,
      apiUrl: e.apiUrl || "",
    }));

    const payload = encodeEventCatalog({
      publishedAt: new Date().toISOString(),
      entries,
    });

    const encoder = node.createEncoder({
      contentTopic: WAKU_CATALOG_TOPIC,
      shardId: WAKU_SHARD_INDEX,
    });

    await node.lightPush.send(encoder, { payload });
    console.log(`[waku] Published catalog: ${entries.length} events`);
  } catch (err) {
    console.error("[waku] Failed to publish catalog:", err instanceof Error ? err.message : err);
  }
}

/**
 * Start periodic catalog republishing. Call once at server startup.
 */
export function startCatalogRepublish(): void {
  if (_intervalId) return;
  _intervalId = setInterval(() => {
    publishCatalog().catch(() => {});
  }, REPUBLISH_INTERVAL);
}

/**
 * Stop periodic catalog republishing.
 */
export function stopCatalogRepublish(): void {
  if (_intervalId) {
    clearInterval(_intervalId);
    _intervalId = null;
  }
}
