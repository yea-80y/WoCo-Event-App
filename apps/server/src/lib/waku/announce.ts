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
  type WakuAnnounceAction,
} from "@woco/shared";
import { getWakuNode, isWakuEnabled } from "./client.js";

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
    };

    const payload = encodeEventAnnouncement(announcement);
    const result = await node.lightPush.send(encoder, { payload });

    const successes = result?.successes?.length ?? 0;
    const failures = result?.failures?.length ?? 0;
    if (failures > 0 && successes === 0) {
      // On a self-hosted single-node setup (no relay peers), LightPush "fails"
      // but Filter delivery still works — local subscribers receive the message.
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
