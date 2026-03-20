/**
 * Waku event announcement publishing.
 *
 * Fire-and-forget: Waku failures are logged but never block the HTTP response.
 * The Swarm directory remains the authoritative source of truth.
 *
 * Announcements are published to:
 * 1. /woco/1/event-announce/proto — the main topic (all events)
 * 2. /woco/1/events/{category}/proto — category-specific topic (if category set)
 *
 * Clients can subscribe to just the categories they care about.
 */
import type { EventDirectoryEntry } from "@woco/shared";
import {
  WAKU_CONTENT_TOPIC,
  WAKU_SHARD_INDEX,
  wakuCategoryTopic,
  encodeEventAnnouncement,
  type EventAnnouncement,
} from "@woco/shared";
import { getWakuNode, isWakuEnabled } from "./client.js";
import { listEvents } from "../event/service.js";

function buildAnnouncement(
  entry: EventDirectoryEntry,
  action: EventAnnouncement["action"],
): EventAnnouncement {
  return {
    eventId: entry.eventId,
    title: entry.title,
    imageHash: entry.imageHash,
    startDate: entry.startDate,
    location: entry.location,
    creatorAddress: entry.creatorAddress,
    seriesCount: entry.seriesCount,
    totalTickets: entry.totalTickets,
    createdAt: entry.createdAt,
    apiUrl: entry.apiUrl || "",
    announcedAt: new Date().toISOString(),
    action,
    category: "",
    tags: [],
    region: "",
    swarmRef: "",
  };
}

/**
 * Announce an event on the Waku network.
 * Publishes to the main topic AND the category topic (if category is set).
 */
export async function announceEvent(
  entry: EventDirectoryEntry,
  action: "created" | "listed",
): Promise<void> {
  if (!isWakuEnabled()) return;

  try {
    const node = await getWakuNode();
    if (!node) return;

    const announcement = buildAnnouncement(entry, action);
    const payload = encodeEventAnnouncement(announcement);

    // Publish to main topic
    const mainEncoder = node.createEncoder({ contentTopic: WAKU_CONTENT_TOPIC, shardId: WAKU_SHARD_INDEX });
    const result = await node.lightPush.send(mainEncoder, { payload });

    const successes = result?.successes?.length ?? 0;
    const failures = result?.failures?.length ?? 0;
    if (failures > 0 && successes === 0) {
      console.log(`[waku] Announced event ${entry.eventId} (action=${action}, relay=${successes}/${successes + failures} — Filter delivery still works)`);
    } else if (failures > 0) {
      console.log(`[waku] Announced event ${entry.eventId} (action=${action}, ${successes} ok, ${failures} failed)`);
    } else {
      console.log(`[waku] Announced event ${entry.eventId} (action=${action})`);
    }

    // Also publish to category topic if category is set
    if (announcement.category) {
      const catEncoder = node.createEncoder({
        contentTopic: wakuCategoryTopic(announcement.category),
        shardId: WAKU_SHARD_INDEX,
      });
      await node.lightPush.send(catEncoder, { payload }).catch(() => {});
    }
  } catch (err) {
    console.error(
      "[waku] Failed to announce event:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Announce that an event has been unlisted from the WoCo directory.
 * Publishes to main topic AND category topic (if known).
 */
export async function announceUnlist(
  eventId: string,
  creatorAddress: string,
  category?: string,
): Promise<void> {
  if (!isWakuEnabled()) return;

  try {
    const node = await getWakuNode();
    if (!node) return;

    const announcement: EventAnnouncement = {
      eventId,
      title: "",
      imageHash: "",
      startDate: "",
      location: "",
      creatorAddress: creatorAddress.toLowerCase(),
      seriesCount: 0,
      totalTickets: 0,
      createdAt: "",
      apiUrl: "",
      announcedAt: new Date().toISOString(),
      action: "unlisted",
      category: category || "",
      tags: [],
      region: "",
      swarmRef: "",
    };

    const payload = encodeEventAnnouncement(announcement);

    const mainEncoder = node.createEncoder({ contentTopic: WAKU_CONTENT_TOPIC, shardId: WAKU_SHARD_INDEX });
    await node.lightPush.send(mainEncoder, { payload });

    if (category) {
      const catEncoder = node.createEncoder({
        contentTopic: wakuCategoryTopic(category),
        shardId: WAKU_SHARD_INDEX,
      });
      await node.lightPush.send(catEncoder, { payload }).catch(() => {});
    }

    console.log(`[waku] Announced unlist for event ${eventId}`);
  } catch (err) {
    console.error(
      "[waku] Failed to announce unlist:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Re-announce ALL events from the Swarm directory individually.
 * Called on server startup so that any client querying Store within the 48h
 * window discovers all events — like BitTorrent DHT re-announce.
 */
export async function reannounceAllEvents(): Promise<void> {
  if (!isWakuEnabled()) return;

  try {
    const node = await getWakuNode();
    if (!node) return;

    const events = await listEvents();
    if (events.length === 0) {
      console.log("[waku] No events to re-announce");
      return;
    }

    const mainEncoder = node.createEncoder({ contentTopic: WAKU_CONTENT_TOPIC, shardId: WAKU_SHARD_INDEX });
    let announced = 0;

    for (const entry of events) {
      try {
        const announcement = buildAnnouncement(entry, "listed");
        const payload = encodeEventAnnouncement(announcement);

        await node.lightPush.send(mainEncoder, { payload });

        // Also publish to category topic
        if (announcement.category) {
          const catEncoder = node.createEncoder({
            contentTopic: wakuCategoryTopic(announcement.category),
            shardId: WAKU_SHARD_INDEX,
          });
          await node.lightPush.send(catEncoder, { payload }).catch(() => {});
        }

        announced++;
      } catch {
        // Skip individual failures, continue with the rest
      }
    }

    console.log(`[waku] Re-announced ${announced}/${events.length} events on startup`);
  } catch (err) {
    console.error("[waku] Re-announce failed:", err instanceof Error ? err.message : err);
  }
}
