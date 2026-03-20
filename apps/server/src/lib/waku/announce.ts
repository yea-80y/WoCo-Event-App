/**
 * Waku event announcement publishing.
 *
 * Fire-and-forget: Waku failures are logged but never block the HTTP response.
 * The Swarm directory remains the authoritative source of truth.
 */
import type { EventDirectoryEntry } from "@woco/shared";
import {
  WAKU_CONTENT_TOPIC,
  WAKU_SHARD_INDEX,
  encodeEventAnnouncement,
  type EventAnnouncement,
} from "@woco/shared";
import { getWakuNode, isWakuEnabled } from "./client.js";
import { listEvents } from "../event/service.js";

/**
 * Announce an event on the Waku network.
 * Called after event creation or listing on the WoCo directory.
 */
export async function announceEvent(
  entry: EventDirectoryEntry,
  action: "created" | "listed",
): Promise<void> {
  if (!isWakuEnabled()) return;

  try {
    const node = await getWakuNode();
    if (!node) return;

    const encoder = node.createEncoder({ contentTopic: WAKU_CONTENT_TOPIC, shardId: WAKU_SHARD_INDEX });

    const announcement: EventAnnouncement = {
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

    const payload = encodeEventAnnouncement(announcement);
    const result = await node.lightPush.send(encoder, { payload });

    const successes = result?.successes?.length ?? 0;
    const failures = result?.failures?.length ?? 0;
    if (failures > 0 && successes === 0) {
      console.log(`[waku] Announced event ${entry.eventId} (action=${action}, relay=${successes}/${successes + failures} — Filter delivery still works)`);
    } else if (failures > 0) {
      console.log(`[waku] Announced event ${entry.eventId} (action=${action}, ${successes} ok, ${failures} failed)`);
    } else {
      console.log(`[waku] Announced event ${entry.eventId} (action=${action})`);
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
 * Frontends subscribed via Waku will remove it from their discovered set.
 */
export async function announceUnlist(
  eventId: string,
  creatorAddress: string,
): Promise<void> {
  if (!isWakuEnabled()) return;

  try {
    const node = await getWakuNode();
    if (!node) return;

    const encoder = node.createEncoder({ contentTopic: WAKU_CONTENT_TOPIC, shardId: WAKU_SHARD_INDEX });

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
      category: "",
      tags: [],
      region: "",
      swarmRef: "",
    };

    const payload = encodeEventAnnouncement(announcement);
    await node.lightPush.send(encoder, { payload });
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

    const encoder = node.createEncoder({ contentTopic: WAKU_CONTENT_TOPIC, shardId: WAKU_SHARD_INDEX });
    let announced = 0;

    for (const entry of events) {
      try {
        const announcement: EventAnnouncement = {
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
          action: "listed",
          category: "",
          tags: [],
          region: "",
          swarmRef: "",
        };

        const payload = encodeEventAnnouncement(announcement);
        await node.lightPush.send(encoder, { payload });
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
