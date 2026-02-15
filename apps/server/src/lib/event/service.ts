import type { Hex64, Hex0x, EventFeed, EventDirectoryEntry, SeriesSummary } from "@woco/shared";
import { uploadToBytes, downloadFromBytes } from "../swarm/bytes.js";
import {
  pack4096,
  decode4096,
  readFeedPage,
  readFeedPageWithRetry,
  writeFeedPage,
  encodeJsonFeed,
  decodeJsonFeed,
} from "../swarm/feeds.js";
import {
  topicEventDirectory,
  topicEvent,
  topicEditions,
  topicClaims,
} from "../swarm/topics.js";

// ---------------------------------------------------------------------------
// Create event
// ---------------------------------------------------------------------------

export async function createEvent(opts: {
  eventId: string;
  title: string;
  description: string;
  startDate: string;
  endDate: string;
  location: string;
  creatorAddress: Hex0x;
  creatorPodKey: string;
  imageData: Uint8Array;
  series: Array<{
    seriesId: string;
    name: string;
    description: string;
    totalSupply: number;
  }>;
  /** signedTickets[seriesId] = array of serialized signed tickets */
  signedTickets: Record<string, string[]>;
}): Promise<EventFeed> {
  const {
    eventId, title, description, startDate, endDate, location,
    creatorAddress, creatorPodKey, imageData, series, signedTickets,
  } = opts;

  console.log(`[event] Creating event ${eventId}: "${title}"`);

  // 1. Upload event image
  console.log("[event] Uploading image...");
  const imageHash = await uploadToBytes(imageData);

  // 2. For each series: upload tickets, write editions feed, init claims feed
  const seriesSummaries: SeriesSummary[] = [];

  for (const s of series) {
    const tickets = signedTickets[s.seriesId];
    if (!tickets || tickets.length !== s.totalSupply) {
      throw new Error(
        `Series ${s.seriesId}: expected ${s.totalSupply} tickets, got ${tickets?.length ?? 0}`,
      );
    }
    if (s.totalSupply > 127) {
      throw new Error(`Series ${s.seriesId}: max 127 tickets per series in v1`);
    }

    console.log(`[event] Processing series "${s.name}" (${s.totalSupply} tickets)...`);

    // Upload each ticket to /bytes
    const ticketHashes: string[] = [];
    for (let i = 0; i < tickets.length; i++) {
      const hash = await uploadToBytes(tickets[i]);
      ticketHashes.push(hash);
      // Brief delay between uploads to avoid rate limiting
      if (i < tickets.length - 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    // Upload series metadata to /bytes (slot 0)
    const seriesMeta = {
      v: 1,
      seriesId: s.seriesId,
      eventId,
      name: s.name,
      description: s.description,
      imageHash,
      creatorPodKey,
      creatorAddress,
      totalSupply: s.totalSupply,
      createdAt: new Date().toISOString(),
    };
    const metaRef = await uploadToBytes(JSON.stringify(seriesMeta));

    // Pack editions feed: [metaRef, ticketHash1, ticketHash2, ...]
    const editionsPage = pack4096([metaRef, ...ticketHashes]);
    await writeFeedPage(topicEditions(s.seriesId), editionsPage);

    // Verify editions feed
    const verified = await readFeedPageWithRetry(topicEditions(s.seriesId), 3, 500);
    if (!verified) {
      throw new Error(`Failed to verify editions feed for series ${s.seriesId}`);
    }

    // Init empty claims feed
    await writeFeedPage(topicClaims(s.seriesId), new Uint8Array(4096));

    seriesSummaries.push({
      seriesId: s.seriesId,
      name: s.name,
      description: s.description,
      totalSupply: s.totalSupply,
      price: 0,
    });
  }

  // 3. Build and write event feed
  const eventFeed: EventFeed = {
    v: 1,
    eventId,
    title,
    description,
    imageHash,
    startDate,
    endDate,
    location,
    creatorAddress,
    creatorPodKey,
    series: seriesSummaries,
    createdAt: new Date().toISOString(),
  };

  console.log("[event] Writing event feed...");
  await writeFeedPage(topicEvent(eventId), encodeJsonFeed(eventFeed));

  // Verify event feed
  const verifiedEvent = await readFeedPageWithRetry(topicEvent(eventId), 3, 500);
  if (!verifiedEvent) {
    throw new Error("Failed to verify event feed write");
  }

  // 4. Update event directory (best-effort)
  try {
    await addToEventDirectory({
      eventId,
      title,
      imageHash,
      startDate,
      location,
      creatorAddress,
      seriesCount: series.length,
      totalTickets: series.reduce((sum, s) => sum + s.totalSupply, 0),
      createdAt: eventFeed.createdAt,
    });
  } catch (err) {
    console.error("[event] Failed to update directory (non-critical):", err);
  }

  console.log(`[event] Event ${eventId} created successfully`);
  return eventFeed;
}

// ---------------------------------------------------------------------------
// Read events
// ---------------------------------------------------------------------------

export async function getEvent(eventId: string): Promise<EventFeed | null> {
  const page = await readFeedPageWithRetry(topicEvent(eventId));
  if (!page) return null;
  return decodeJsonFeed<EventFeed>(page);
}

interface EventDirectory {
  v: 1;
  entries: EventDirectoryEntry[];
  updatedAt: string;
}

export async function listEvents(): Promise<EventDirectoryEntry[]> {
  const page = await readFeedPage(topicEventDirectory());
  if (!page) return [];
  const dir = decodeJsonFeed<EventDirectory>(page);
  return dir?.entries ?? [];
}

// ---------------------------------------------------------------------------
// Directory helpers
// ---------------------------------------------------------------------------

async function addToEventDirectory(entry: EventDirectoryEntry): Promise<void> {
  const page = await readFeedPage(topicEventDirectory());
  const dir: EventDirectory = page
    ? decodeJsonFeed<EventDirectory>(page) ?? { v: 1, entries: [], updatedAt: "" }
    : { v: 1, entries: [], updatedAt: "" };

  // Idempotent
  if (dir.entries.some((e) => e.eventId === entry.eventId)) return;

  dir.entries.unshift(entry);
  dir.updatedAt = new Date().toISOString();

  // Cap at 128 entries
  if (dir.entries.length > 128) dir.entries = dir.entries.slice(0, 128);

  await writeFeedPage(topicEventDirectory(), encodeJsonFeed(dir));
  console.log(`[event] Directory updated: ${dir.entries.length} events`);
}
