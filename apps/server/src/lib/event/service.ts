import type { Hex64, Hex0x, EventFeed, EventDirectoryEntry, SeriesSummary, OrderField, ClaimMode } from "@woco/shared";
import { uploadToBytes, downloadFromBytes } from "../swarm/bytes.js";
import { announceEvent as wakuAnnounce } from "../waku/announce.js";
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
  topicCreatorDirectory,
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
    approvalRequired?: boolean;
    wave?: string;
    saleStart?: string;
    saleEnd?: string;
    paymentRedirectUrl?: string;
  }>;
  /** signedTickets[seriesId] = array of serialized signed tickets */
  signedTickets: Record<string, string[]>;
  /** Organizer's X25519 encryption public key (hex) */
  encryptionKey?: string;
  /** Order form fields (if organizer wants attendee info) */
  orderFields?: OrderField[];
  /** How attendees can claim tickets */
  claimMode?: ClaimMode;
  /** If true, skip adding to the public event directory (site builder use case) */
  skipAutoList?: boolean;
  onProgress?: (p: CreateProgress) => void;
}): Promise<EventFeed> {
  const {
    eventId, title, description, startDate, endDate, location,
    creatorAddress, creatorPodKey, imageData, series, signedTickets,
    encryptionKey, orderFields, claimMode, skipAutoList, onProgress,
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

  const createdAt = new Date().toISOString();

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

    // Upload tickets to /bytes in parallel batches of 20
    const ticketHashes: string[] = [];
    const BATCH_SIZE = 20;
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
      createdAt,
      ...(s.approvalRequired ? { approvalRequired: true } : {}),
    };
    const metaRef = await uploadToBytes(JSON.stringify(seriesMeta));

    // Build page data for all edition pages
    const editionPages: Uint8Array[] = [];
    for (let p = 0; p < pages; p++) {
      let pageRefs: string[];
      if (p === 0) {
        pageRefs = [metaRef, ...ticketHashes.slice(0, PAGE_0_CAPACITY)];
      } else {
        const start = PAGE_0_CAPACITY + (p - 1) * PAGE_N_CAPACITY;
        pageRefs = ticketHashes.slice(start, start + PAGE_N_CAPACITY);
      }
      editionPages.push(pack4096(pageRefs));
    }

    // Write edition pages + claims pages in parallel
    emit("feeds", 0, pages, `Writing feeds for "${s.name}"...`);
    const feedWrites: Promise<void>[] = [];
    for (let p = 0; p < pages; p++) {
      feedWrites.push(writeFeedPage(topicEditions(s.seriesId, p), editionPages[p]));
      feedWrites.push(writeFeedPage(topicClaims(s.seriesId, p), new Uint8Array(4096)));
    }
    await Promise.all(feedWrites);
    emit("feeds", pages, pages, `Feeds written for "${s.name}"`);

    // Verify page 0
    const verified = await readFeedPageWithRetry(topicEditions(s.seriesId, 0), 3, 500);
    if (!verified) {
      throw new Error(`Failed to verify editions feed for series ${s.seriesId}`);
    }

    seriesSummaries.push({
      seriesId: s.seriesId,
      name: s.name,
      description: s.description,
      totalSupply: s.totalSupply,
      price: 0,
      ...(s.approvalRequired ? { approvalRequired: true } : {}),
      ...(s.wave ? { wave: s.wave } : {}),
      ...(s.saleStart ? { saleStart: s.saleStart } : {}),
      ...(s.saleEnd ? { saleEnd: s.saleEnd } : {}),
      ...(s.paymentRedirectUrl ? { paymentRedirectUrl: s.paymentRedirectUrl } : {}),
    });
  }

  // 4. Build and write event feed
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
    createdAt,
    ...(encryptionKey ? { encryptionKey } : {}),
    ...(orderFields?.length ? { orderFields } : {}),
    ...(claimMode && claimMode !== "wallet" ? { claimMode } : {}),
  };

  emit("finalize", 0, 1, "Writing event feed...");
  console.log("[event] Writing event feed...");
  await writeFeedPage(topicEvent(eventId), encodeJsonFeed(eventFeed));

  // Verify event feed
  const verifiedEvent = await readFeedPageWithRetry(topicEvent(eventId), 3, 500);
  if (!verifiedEvent) {
    throw new Error("Failed to verify event feed write");
  }

  // 5. Event is now fully on Swarm — announce on Waku + update directories.
  // Both are fire-and-forget: the event is complete and verifiable at this point,
  // so any client that receives the Waku announcement can load the event page.
  const dirEntry: EventDirectoryEntry = {
    eventId, title, imageHash, startDate, location, creatorAddress,
    seriesCount: series.length,
    totalTickets,
    createdAt,
  };
  wakuAnnounce(dirEntry, "created")
    .catch((err) => console.error("[waku] Announce failed:", err));
  addToEventDirectory(dirEntry, { skipPublicDirectory: !!skipAutoList })
    .catch((err) => console.error("[event] Failed to update directory (non-critical):", err));

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
  /** Number of overflow pages (0 = all entries fit on page 0) */
  pages?: number;
}

/** Max JSON bytes per directory page (must fit in a single 4096-byte Bee chunk). */
const DIR_PAGE_LIMIT = 4096;

export async function listEvents(): Promise<EventDirectoryEntry[]> {
  const page0 = await readFeedPage(topicEventDirectory());
  if (!page0) return [];
  const dir = decodeJsonFeed<EventDirectory>(page0);
  if (!dir) return [];

  const all = [...dir.entries];

  // Read overflow pages
  const totalPages = dir.pages ?? 0;
  for (let p = 1; p <= totalPages; p++) {
    const pageData = await readFeedPage(topicEventDirectory(p));
    if (!pageData) break;
    const overflow = decodeJsonFeed<EventDirectory>(pageData);
    if (overflow?.entries) all.push(...overflow.entries);
  }

  return all;
}

// ---------------------------------------------------------------------------
// Directory helpers
// ---------------------------------------------------------------------------

export { addToEventDirectory as addEventToDirectory };

/** Strip empty/default fields to keep directory entries small (must fit in 4096-byte Bee chunk). */
function compactEntry(e: EventDirectoryEntry): EventDirectoryEntry {
  const compact: Record<string, unknown> = {
    eventId: e.eventId,
    title: e.title,
    imageHash: e.imageHash,
    startDate: e.startDate,
    creatorAddress: e.creatorAddress,
    seriesCount: e.seriesCount,
    totalTickets: e.totalTickets,
    createdAt: e.createdAt,
  };
  if (e.location) compact.location = e.location;
  if (e.apiUrl) compact.apiUrl = e.apiUrl;
  return compact as unknown as EventDirectoryEntry;
}

/**
 * Write a directory (page 0 + overflow pages) to paginated feeds.
 * Each page stays within DIR_PAGE_LIMIT so bee-js uses the direct SOC path.
 */
async function writeDirectoryPages(
  allEntries: EventDirectoryEntry[],
  updatedAt: string,
  topicFn: (page: number) => import("@ethersphere/bee-js").Topic,
): Promise<void> {
  const compact = allEntries.map(compactEntry);

  // Split entries across pages that fit within 4096 bytes each
  const pages: EventDirectoryEntry[][] = [];
  let current: EventDirectoryEntry[] = [];
  for (const entry of compact) {
    current.push(entry);
    const testDir: EventDirectory = {
      v: 1,
      entries: current,
      updatedAt,
      ...(pages.length > 0 ? {} : { pages: pages.length }),
    };
    if (JSON.stringify(testDir).length > DIR_PAGE_LIMIT) {
      current.pop();
      if (current.length > 0) pages.push(current);
      current = [entry];
    }
  }
  if (current.length > 0) pages.push(current);

  // Write page 0 with the page count
  const page0: EventDirectory = {
    v: 1,
    entries: pages[0] ?? [],
    updatedAt,
    pages: pages.length - 1, // number of OVERFLOW pages
  };
  await writeFeedPage(topicFn(0), encodeJsonFeed(page0));

  // Write overflow pages
  for (let p = 1; p < pages.length; p++) {
    const overflow: EventDirectory = { v: 1, entries: pages[p], updatedAt };
    await writeFeedPage(topicFn(p), encodeJsonFeed(overflow));
  }
}

async function addToEventDirectory(
  entry: EventDirectoryEntry,
  opts: { skipPublicDirectory?: boolean } = {},
): Promise<void> {
  // Write to global public directory (skipped for site-builder events until explicitly listed)
  if (!opts.skipPublicDirectory) {
    const allEntries = await listEvents();
    if (!allEntries.some((e) => e.eventId === entry.eventId)) {
      allEntries.unshift(entry);
      const updatedAt = new Date().toISOString();
      await writeDirectoryPages(allEntries, updatedAt, topicEventDirectory);
      console.log(`[event] Directory updated: ${allEntries.length} events`);
    }
  }

  // Also write to per-creator index (never removed from — listing status doesn't affect organiser view)
  const creatorEntries = await getCreatorEvents(entry.creatorAddress);
  if (!creatorEntries.some((e) => e.eventId === entry.eventId)) {
    creatorEntries.unshift(entry);
    const updatedAt = new Date().toISOString();
    await writeDirectoryPages(
      creatorEntries,
      updatedAt,
      (p) => topicCreatorDirectory(entry.creatorAddress, p),
    );
    console.log(`[event] Creator index updated for ${entry.creatorAddress}: ${creatorEntries.length} events`);
  }
}

export async function getCreatorEvents(ethAddress: string): Promise<EventDirectoryEntry[]> {
  const page0 = await readFeedPage(topicCreatorDirectory(ethAddress));
  if (!page0) return [];
  const dir = decodeJsonFeed<EventDirectory>(page0);
  if (!dir) return [];

  const all = [...dir.entries];
  const totalPages = dir.pages ?? 0;
  for (let p = 1; p <= totalPages; p++) {
    const pageData = await readFeedPage(topicCreatorDirectory(ethAddress, p));
    if (!pageData) break;
    const overflow = decodeJsonFeed<EventDirectory>(pageData);
    if (overflow?.entries) all.push(...overflow.entries);
  }
  return all;
}

export async function removeEventFromDirectory(eventId: string): Promise<void> {
  const allEntries = await listEvents();
  const before = allEntries.length;
  const filtered = allEntries.filter((e) => e.eventId !== eventId);
  if (filtered.length === before) return; // not in directory

  const updatedAt = new Date().toISOString();
  await writeDirectoryPages(filtered, updatedAt, topicEventDirectory);
  console.log(`[event] Directory updated (removed ${eventId}): ${filtered.length} events`);
}
