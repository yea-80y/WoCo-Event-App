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
  editionPageCount,
  PAGE_0_CAPACITY,
  PAGE_N_CAPACITY,
} from "../swarm/topics.js";

// ---------------------------------------------------------------------------
// Create event
// ---------------------------------------------------------------------------

export interface CreateProgress {
  type: "progress";
  phase: string;
  current: number;
  total: number;
  message: string;
}

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
  onProgress?: (p: CreateProgress) => void;
}): Promise<EventFeed> {
  const {
    eventId, title, description, startDate, endDate, location,
    creatorAddress, creatorPodKey, imageData, series, signedTickets,
    onProgress,
  } = opts;

  const totalTickets = series.reduce((sum, s) => sum + s.totalSupply, 0);
  let ticketsUploaded = 0;

  const emit = (phase: string, current: number, total: number, message: string) => {
    onProgress?.({ type: "progress", phase, current, total, message });
  };

  console.log(`[event] Creating event ${eventId}: "${title}"`);

  // 1. Upload event image
  emit("image", 0, 1, "Uploading event image...");
  console.log("[event] Uploading image...");
  const imageHash = await uploadToBytes(imageData);
  emit("image", 1, 1, "Image uploaded");

  // 2. For each series: upload tickets, write editions feed(s), init claims feed(s)
  const seriesSummaries: SeriesSummary[] = [];

  for (const s of series) {
    const tickets = signedTickets[s.seriesId];
    if (!tickets || tickets.length !== s.totalSupply) {
      throw new Error(
        `Series ${s.seriesId}: expected ${s.totalSupply} tickets, got ${tickets?.length ?? 0}`,
      );
    }

    const pages = editionPageCount(s.totalSupply);
    console.log(
      `[event] Processing series "${s.name}" (${s.totalSupply} tickets, ${pages} page${pages > 1 ? "s" : ""})...`,
    );

    // Upload tickets to /bytes in parallel batches of 10
    const ticketHashes: string[] = [];
    const BATCH_SIZE = 10;
    for (let batchStart = 0; batchStart < tickets.length; batchStart += BATCH_SIZE) {
      const batch = tickets.slice(batchStart, batchStart + BATCH_SIZE);
      const batchResults = await Promise.all(batch.map((t) => uploadToBytes(t)));
      ticketHashes.push(...batchResults);
      ticketsUploaded += batchResults.length;
      emit(
        "tickets",
        ticketsUploaded,
        totalTickets,
        `Uploading tickets: ${ticketsUploaded}/${totalTickets} (${s.name})`,
      );
      if (ticketHashes.length < tickets.length) {
        console.log(`[event]   Uploaded ${ticketHashes.length}/${tickets.length} tickets...`);
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    console.log(`[event]   All ${ticketHashes.length} tickets uploaded`);

    // Upload series metadata to /bytes (page 0, slot 0)
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
      pageCount: pages,
      createdAt: new Date().toISOString(),
    };
    const metaRef = await uploadToBytes(JSON.stringify(seriesMeta));

    // Write editions across pages
    emit("feeds", 0, pages, `Writing edition feeds for "${s.name}"...`);
    for (let p = 0; p < pages; p++) {
      let pageRefs: string[];

      if (p === 0) {
        const chunk = ticketHashes.slice(0, PAGE_0_CAPACITY);
        pageRefs = [metaRef, ...chunk];
      } else {
        const start = PAGE_0_CAPACITY + (p - 1) * PAGE_N_CAPACITY;
        pageRefs = ticketHashes.slice(start, start + PAGE_N_CAPACITY);
      }

      const editionsPage = pack4096(pageRefs);
      await writeFeedPage(topicEditions(s.seriesId, p), editionsPage);
      emit("feeds", p + 1, pages, `Writing edition feeds for "${s.name}" (${p + 1}/${pages})...`);
    }

    // Verify page 0
    const verified = await readFeedPageWithRetry(topicEditions(s.seriesId, 0), 3, 500);
    if (!verified) {
      throw new Error(`Failed to verify editions feed for series ${s.seriesId}`);
    }

    // Init empty claims feed(s) - one per edition page
    for (let p = 0; p < pages; p++) {
      await writeFeedPage(topicClaims(s.seriesId, p), new Uint8Array(4096));
    }

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

  emit("finalize", 0, 1, "Writing event feed...");
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

  emit("finalize", 1, 1, "Event published!");
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
