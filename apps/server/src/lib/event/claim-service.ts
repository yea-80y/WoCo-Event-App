import { createHash } from "node:crypto";
import type {
  Hex0x,
  ClaimedTicket,
  SignedTicket,
  SeriesClaimStatus,
  CollectionEntry,
  UserCollection,
  SealedBox,
  ClaimerEntry,
  ClaimersFeed,
} from "@woco/shared";
import { uploadToBytes, downloadFromBytes } from "../swarm/bytes.js";
import {
  pack4096,
  decode4096,
  decode4096Claims,
  readFeedPage,
  readFeedPageWithRetry,
  writeFeedPage,
  encodeJsonFeed,
  decodeJsonFeed,
} from "../swarm/feeds.js";
import {
  topicEditions,
  topicClaims,
  topicClaimers,
  topicUserCollection,
  editionPageCount,
  PAGE_0_CAPACITY,
  PAGE_N_CAPACITY,
} from "../swarm/topics.js";

// ---------------------------------------------------------------------------
// Claim identifier (wallet or email)
// ---------------------------------------------------------------------------

export type ClaimIdentifier =
  | { type: "wallet"; address: Hex0x }
  | { type: "email"; email: string; emailHash: string };

/** Hash email for privacy-safe storage */
export function hashEmail(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

// ---------------------------------------------------------------------------
// Claim a ticket
// ---------------------------------------------------------------------------

export async function claimTicket(opts: {
  seriesId: string;
  identifier: ClaimIdentifier;
  encryptedOrder?: SealedBox;
}): Promise<ClaimedTicket> {
  const { seriesId, identifier, encryptedOrder } = opts;

  const logId = identifier.type === "wallet" ? identifier.address : `email:${identifier.emailHash.slice(0, 12)}...`;
  console.log(`[claim] Claiming ticket for series ${seriesId}, claimer ${logId}`);

  // 1. Read series metadata from editions page 0, slot 0
  const editionsPage0 = await readFeedPageWithRetry(topicEditions(seriesId, 0));
  if (!editionsPage0) {
    throw new Error("Series not found");
  }

  const refs = decode4096(editionsPage0);
  if (refs.length === 0) {
    throw new Error("Series has no metadata");
  }

  const metaJson = await downloadFromBytes(refs[0]);
  const meta = JSON.parse(metaJson) as {
    totalSupply: number;
    pageCount: number;
    eventId: string;
    seriesId: string;
    name: string;
  };

  const pageCount = meta.pageCount || 1;

  // 2. Find next unclaimed slot — fetch all pages in parallel, then scan
  let foundPage = -1;
  let foundSlot = -1;
  let ticketRef = "";
  let cachedClaimsPageData: Uint8Array | null = null;

  // Parallel fetch of all claims + editions pages
  const pageResults = await Promise.all(
    Array.from({ length: pageCount }, (_, p) =>
      Promise.all([
        readFeedPage(topicClaims(seriesId, p)),
        p === 0 ? Promise.resolve(editionsPage0) : readFeedPage(topicEditions(seriesId, p)),
      ]),
    ),
  );

  for (let p = 0; p < pageCount; p++) {
    const [claimsPage, editionsPageData] = pageResults[p];
    const claims = claimsPage ? decode4096Claims(claimsPage) : new Array(128).fill("");

    if (!editionsPageData) continue;

    const editionRefs = decode4096(editionsPageData);
    const startSlot = p === 0 ? 1 : 0; // Skip metadata slot on page 0

    for (let s = startSlot; s < editionRefs.length; s++) {
      if (claims[s] === "") {
        foundPage = p;
        foundSlot = s;
        ticketRef = editionRefs[s];
        cachedClaimsPageData = claimsPage;
        break;
      }
    }

    if (foundPage >= 0) break;
  }

  if (foundPage < 0 || !ticketRef) {
    throw new Error("No tickets available");
  }

  // 3. Calculate edition number from page + slot
  let editionNumber: number;
  if (foundPage === 0) {
    editionNumber = foundSlot; // slot 1 = edition 1
  } else {
    editionNumber = PAGE_0_CAPACITY + (foundPage - 1) * PAGE_N_CAPACITY + foundSlot + 1;
  }

  console.log(`[claim] Found unclaimed slot: page ${foundPage}, slot ${foundSlot}, edition ${editionNumber}`);

  // 4. Download original signed ticket
  const originalJson = await downloadFromBytes(ticketRef);
  const originalTicket = JSON.parse(originalJson) as SignedTicket;

  // 5. Create claimed ticket
  const claimedTicket: ClaimedTicket = {
    podType: "woco.ticket.claimed.v1",
    eventId: originalTicket.data.eventId,
    seriesId: originalTicket.data.seriesId,
    seriesName: originalTicket.data.seriesName,
    edition: originalTicket.data.edition,
    totalSupply: originalTicket.data.totalSupply,
    imageHash: originalTicket.data.imageHash,
    creator: originalTicket.data.creator,
    mintedAt: originalTicket.data.mintedAt,
    ownerAddress: identifier.type === "wallet" ? identifier.address : undefined,
    ownerEmailHash: identifier.type === "email" ? identifier.emailHash : undefined,
    claimedAt: new Date().toISOString(),
    originalPodHash: ticketRef,
    originalSignature: originalTicket.signature,
  };

  // 6. Upload claimed ticket to /bytes
  const claimedRef = await uploadToBytes(JSON.stringify(claimedTicket));
  console.log(`[claim] Uploaded claimed ticket: ${claimedRef}`);

  // 7. Write claim hash to claims feed at the found slot (use cached page from step 2)
  const claimsData = cachedClaimsPageData ? new Uint8Array(cachedClaimsPageData) : new Uint8Array(4096);

  // Write the claimed ref into the slot
  const refBytes = hexToBytes32(claimedRef);
  claimsData.set(refBytes, foundSlot * 32);

  await writeFeedPage(topicClaims(seriesId, foundPage), claimsData);
  console.log(`[claim] Updated claims feed page ${foundPage}, slot ${foundSlot}`);

  // 8. Fire non-critical background updates in parallel (don't block response)
  const claimerAddress = identifier.type === "wallet" ? identifier.address : `email:${identifier.emailHash}`;

  const backgroundTasks: Promise<void>[] = [];

  // 8a. Store encrypted order + update claimers feed (order ref needed for claimers entry)
  backgroundTasks.push(
    (async () => {
      let orderRef: string | undefined;
      if (encryptedOrder) {
        try {
          orderRef = await uploadToBytes(JSON.stringify(encryptedOrder));
          console.log(`[claim] Encrypted order stored: ${orderRef}`);
        } catch (err) {
          console.error("[claim] Failed to store encrypted order (non-critical):", err);
        }
      }
      await updateClaimersFeed(seriesId, {
        edition: editionNumber,
        claimerAddress,
        claimedRef,
        claimedAt: claimedTicket.claimedAt,
        orderRef,
      });
    })().catch((err) => console.error("[claim] Failed to update claimers feed (non-critical):", err)),
  );

  // 8b. Update user collection (wallet claims only, independent of order/claimers)
  if (identifier.type === "wallet") {
    backgroundTasks.push(
      addToUserCollection(identifier.address, {
        seriesId,
        eventId: originalTicket.data.eventId,
        edition: editionNumber,
        claimedRef,
        claimedAt: claimedTicket.claimedAt,
      }).catch((err) => console.error("[claim] Failed to update user collection (non-critical):", err)),
    );
  }

  // Don't await — let them settle in background after response
  Promise.allSettled(backgroundTasks).then(() => {
    console.log(`[claim] Background updates complete for edition ${editionNumber}`);
  });

  console.log(`[claim] Ticket claimed successfully: edition ${editionNumber}`);
  return claimedTicket;
}

// ---------------------------------------------------------------------------
// Get claim status
// ---------------------------------------------------------------------------

export async function getClaimStatus(
  seriesId: string,
  userAddress?: string,
): Promise<SeriesClaimStatus> {
  const editionsPage0 = await readFeedPage(topicEditions(seriesId, 0));
  if (!editionsPage0) {
    throw new Error("Series not found");
  }

  const refs = decode4096(editionsPage0);
  if (refs.length === 0) throw new Error("Series has no metadata");

  const metaJson = await downloadFromBytes(refs[0]);
  const meta = JSON.parse(metaJson) as {
    totalSupply: number;
    pageCount: number;
  };

  const pageCount = meta.pageCount || 1;
  let claimed = 0;
  let userEdition: number | undefined;

  for (let p = 0; p < pageCount; p++) {
    const claimsPage = await readFeedPage(topicClaims(seriesId, p));
    if (!claimsPage) continue;

    const claims = decode4096Claims(claimsPage);
    const startSlot = p === 0 ? 1 : 0;

    for (let s = startSlot; s < 128; s++) {
      if (claims[s] !== "") {
        claimed++;

        // Check if this claim belongs to the requesting user
        if (userAddress && !userEdition) {
          try {
            const claimedJson = await downloadFromBytes(claims[s]);
            const ct = JSON.parse(claimedJson) as ClaimedTicket;
            if (ct.ownerAddress?.toLowerCase() === userAddress.toLowerCase()) {
              userEdition = ct.edition;
            }
          } catch {
            // Skip unreadable claims
          }
        }
      }
    }
  }

  return {
    seriesId,
    totalSupply: meta.totalSupply,
    claimed,
    available: meta.totalSupply - claimed,
    userEdition,
  };
}

// ---------------------------------------------------------------------------
// Collection reader (used by collection routes)
// ---------------------------------------------------------------------------

export async function getUserCollection(address: string): Promise<UserCollection | null> {
  const page = await readFeedPage(topicUserCollection(address));
  if (!page) return null;
  return decodeJsonFeed<UserCollection>(page);
}

export async function getClaimedTicketDetail(ref: string): Promise<ClaimedTicket | null> {
  try {
    const json = await downloadFromBytes(ref);
    return JSON.parse(json) as ClaimedTicket;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexToBytes32(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function updateClaimersFeed(seriesId: string, entry: ClaimerEntry): Promise<void> {
  const page = await readFeedPage(topicClaimers(seriesId));
  const feed: ClaimersFeed = page
    ? decodeJsonFeed<ClaimersFeed>(page) ?? { v: 1, seriesId, claimers: [], updatedAt: "" }
    : { v: 1, seriesId, claimers: [], updatedAt: "" };

  // Idempotent - don't add duplicate claims for same address
  if (feed.claimers.some((c) => c.claimerAddress.toLowerCase() === entry.claimerAddress.toLowerCase())) {
    return;
  }

  feed.claimers.push(entry);
  feed.updatedAt = new Date().toISOString();

  await writeFeedPage(topicClaimers(seriesId), encodeJsonFeed(feed));
  console.log(`[claim] Claimers feed updated: ${feed.claimers.length} claims`);
}

async function addToUserCollection(ethAddress: string, entry: CollectionEntry): Promise<void> {
  const page = await readFeedPage(topicUserCollection(ethAddress));
  const collection: UserCollection = page
    ? decodeJsonFeed<UserCollection>(page) ?? { v: 1, entries: [], updatedAt: "" }
    : { v: 1, entries: [], updatedAt: "" };

  // Idempotent
  if (collection.entries.some((e) => e.seriesId === entry.seriesId)) return;

  collection.entries.push(entry);
  collection.updatedAt = new Date().toISOString();

  await writeFeedPage(topicUserCollection(ethAddress), encodeJsonFeed(collection));
  console.log(`[claim] User collection updated: ${collection.entries.length} tickets`);
}
