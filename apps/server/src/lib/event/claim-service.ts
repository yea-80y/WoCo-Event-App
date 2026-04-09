import { createHash, createHmac, randomUUID } from "node:crypto";
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
  PendingClaimEntry,
  PendingClaimsFeed,
} from "@woco/shared";
import { verifyTicketSignature } from "@woco/shared";
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
  topicPendingClaims,
  editionPageCount,
  PAGE_0_CAPACITY,
  PAGE_N_CAPACITY,
} from "../swarm/topics.js";

/** Internal result type — `_pendingId` is stripped before returning to clients */
export type ClaimResult = ClaimedTicket & { _pendingId?: string };

// ---------------------------------------------------------------------------
// Claim identifier (wallet or email)
// ---------------------------------------------------------------------------

export type ClaimIdentifier =
  | { type: "wallet"; address: Hex0x }
  | { type: "email"; email: string; emailHash: string; legacyEmailHash?: string };

/**
 * Hash email for privacy-safe storage.
 * Uses HMAC-SHA256 with a server-side secret to prevent rainbow table reversal
 * (email hashes are stored on publicly-readable Swarm feeds).
 * Falls back to unsalted SHA-256 only if EMAIL_HASH_SECRET is not configured.
 */
export function hashEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  const secret = process.env.EMAIL_HASH_SECRET;
  if (secret) {
    return createHmac("sha256", secret).update(normalized).digest("hex");
  }
  // Legacy fallback — unsalted SHA-256 (set EMAIL_HASH_SECRET to upgrade)
  return createHash("sha256").update(normalized).digest("hex");
}

/**
 * Legacy unsalted hash — used for backward-compatible dedup lookups
 * during the migration period (existing claims used unsalted SHA-256).
 */
export function hashEmailLegacy(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

// ---------------------------------------------------------------------------
// Claim a ticket
// ---------------------------------------------------------------------------

export async function claimTicket(opts: {
  seriesId: string;
  identifier: ClaimIdentifier;
  encryptedOrder?: SealedBox;
}): Promise<ClaimResult> {
  const { seriesId, identifier, encryptedOrder } = opts;

  const logId = identifier.type === "wallet" ? identifier.address : `email:${identifier.emailHash.slice(0, 12)}...`;
  console.log(`[claim] Claiming ticket for series ${seriesId}, claimer ${logId}`);

  // 0. Reject duplicate approved claims — check claimers feed before any expensive work.
  //    This runs inside the per-series queue so the read is always up-to-date.
  const claimerKey = identifier.type === "wallet"
    ? identifier.address.toLowerCase()
    : `email:${identifier.emailHash}`;

  // For email claims, also check the legacy (unsalted) hash for backward compat
  const legacyClaimerKey = identifier.type === "email" && identifier.legacyEmailHash
    ? `email:${identifier.legacyEmailHash}`
    : null;

  const existingClaimersPage = await readFeedPage(topicClaimers(seriesId));
  if (existingClaimersPage) {
    const existingFeed = decodeJsonFeed<ClaimersFeed>(existingClaimersPage);
    if (existingFeed?.claimers.some(
      (c) => c.claimerAddress.toLowerCase() === claimerKey ||
             (legacyClaimerKey && c.claimerAddress.toLowerCase() === legacyClaimerKey),
    )) {
      throw new Error("Already claimed");
    }
  }

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
    approvalRequired?: boolean;
  };

  const pageCount = meta.pageCount || 1;
  const approvalRequired = !!meta.approvalRequired;

  // 1b. For approval-required series: reject duplicate pending requests
  if (approvalRequired) {
    const pendingFeed = await getPendingClaimsFeed(seriesId);
    if (pendingFeed?.pending.some(
      (e) => e.claimerKey === claimerKey && e.status === "pending",
    )) {
      throw new Error("Already requested");
    }
  }

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

  // 4. Download and verify original signed ticket
  const originalJson = await downloadFromBytes(ticketRef);
  const originalTicket = JSON.parse(originalJson) as SignedTicket;

  // Verify ed25519 signature — defence-in-depth against feed tampering
  if (!verifyTicketSignature(originalTicket)) {
    console.error(`[claim] INVALID SIGNATURE on ticket ref ${ticketRef}, edition ${editionNumber}`);
    throw new Error("Ticket signature verification failed");
  }

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
    ...(approvalRequired ? { approvalStatus: "pending" as const } : {}),
  };

  // 6. Upload claimed ticket to /bytes
  const claimedRef = await uploadToBytes(JSON.stringify(claimedTicket));
  console.log(`[claim] Uploaded claimed ticket: ${claimedRef}`);

  // 7. Write claim hash to claims feed at the found slot — reserves the slot
  const claimsData = cachedClaimsPageData ? new Uint8Array(cachedClaimsPageData) : new Uint8Array(4096);
  const refBytes = hexToBytes32(claimedRef);
  claimsData.set(refBytes, foundSlot * 32);

  await writeFeedPage(topicClaims(seriesId, foundPage), claimsData);
  console.log(`[claim] Updated claims feed page ${foundPage}, slot ${foundSlot}`);

  // 8. Approval gate or instant completion
  const claimerAddress = identifier.type === "wallet" ? identifier.address : `email:${identifier.emailHash}`;

  let orderRef: string | undefined;
  if (encryptedOrder) {
    try {
      orderRef = await uploadToBytes(JSON.stringify(encryptedOrder));
      console.log(`[claim] Encrypted order stored: ${orderRef}`);
    } catch (err) {
      console.error("[claim] Failed to store encrypted order:", err);
    }
  }

  if (approvalRequired) {
    // Pending path: store in pending-claims feed, skip claimers/collection
    const pendingId = randomUUID();
    await createPendingClaimEntry(seriesId, {
      pendingId,
      claimerKey,
      requestedAt: claimedTicket.claimedAt,
      orderRef,
      claimedRef,
      status: "pending",
    });
    console.log(`[claim] Pending claim created: ${pendingId} for edition ${editionNumber}`);
    return { ...claimedTicket, _pendingId: pendingId };
  }

  // Normal path: update claimers feed + user collection
  try {
    await updateClaimersFeed(seriesId, {
      edition: editionNumber,
      claimerAddress,
      claimedRef,
      claimedAt: claimedTicket.claimedAt,
      orderRef,
    });
  } catch (err) {
    console.error("[claim] Failed to update claimers feed:", err);
  }

  // Update user collection in background (non-critical, wallet only)
  if (identifier.type === "wallet") {
    addToUserCollection(identifier.address, {
      seriesId,
      eventId: originalTicket.data.eventId,
      edition: editionNumber,
      claimedRef,
      claimedAt: claimedTicket.claimedAt,
    }).catch((err) => console.error("[claim] Failed to update user collection (non-critical):", err));
  }

  console.log(`[claim] Ticket claimed successfully: edition ${editionNumber}`);
  return claimedTicket;
}

// ---------------------------------------------------------------------------
// Get claim status
// ---------------------------------------------------------------------------

export async function getClaimStatus(
  seriesId: string,
  userAddress?: string,
  userEmailHash?: string,
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

        // Check if this approved claim belongs to the requesting user (skip pending)
        if ((userAddress || userEmailHash) && !userEdition) {
          try {
            const claimedJson = await downloadFromBytes(claims[s]);
            const ct = JSON.parse(claimedJson) as ClaimedTicket;
            // Only count as userEdition if the ticket is approved (or legacy, no status)
            if (ct.approvalStatus === "pending") continue;
            if (userAddress && ct.ownerAddress?.toLowerCase() === userAddress.toLowerCase()) {
              userEdition = ct.edition;
            } else if (userEmailHash && ct.ownerEmailHash === userEmailHash) {
              userEdition = ct.edition;
            }
          } catch {
            // Skip unreadable claims
          }
        }
      }
    }
  }

  // Check pending-claims feed for userPendingId
  let userPendingId: string | undefined;
  if (userAddress || userEmailHash) {
    const claimerKey = userAddress
      ? userAddress.toLowerCase()
      : `email:${userEmailHash}`;
    const pendingFeed = await getPendingClaimsFeed(seriesId);
    const entry = pendingFeed?.pending.find(
      (e) => e.claimerKey === claimerKey && e.status === "pending",
    );
    if (entry) userPendingId = entry.pendingId;
  }

  return {
    seriesId,
    totalSupply: meta.totalSupply,
    claimed,
    available: meta.totalSupply - claimed,
    ...(userEdition != null ? { userEdition } : {}),
    ...(userPendingId ? { userPendingId } : {}),
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
// Pending claims feed
// ---------------------------------------------------------------------------

export async function getPendingClaimsFeed(seriesId: string): Promise<PendingClaimsFeed | null> {
  const page = await readFeedPage(topicPendingClaims(seriesId));
  if (!page) return null;
  return decodeJsonFeed<PendingClaimsFeed>(page);
}

async function createPendingClaimEntry(seriesId: string, entry: PendingClaimEntry): Promise<void> {
  const page = await readFeedPage(topicPendingClaims(seriesId));
  const feed: PendingClaimsFeed = page
    ? decodeJsonFeed<PendingClaimsFeed>(page) ?? { v: 1, seriesId, pending: [], updatedAt: "" }
    : { v: 1, seriesId, pending: [], updatedAt: "" };

  // Idempotent: reject duplicate pending requests for same claimerKey
  if (feed.pending.some((e) => e.claimerKey === entry.claimerKey && e.status === "pending")) {
    throw new Error("Already requested");
  }

  feed.pending.push(entry);
  feed.updatedAt = new Date().toISOString();

  await writeFeedPage(topicPendingClaims(seriesId), encodeJsonFeed(feed));
  console.log(`[claim] Pending claims feed updated: ${feed.pending.length} entries`);
}

export async function approvePendingClaim(
  seriesId: string,
  pendingId: string,
): Promise<void> {
  // 1. Read pending-claims feed, find the entry
  const pendingPage = await readFeedPage(topicPendingClaims(seriesId));
  const pendingFeed: PendingClaimsFeed = pendingPage
    ? decodeJsonFeed<PendingClaimsFeed>(pendingPage) ?? { v: 1, seriesId, pending: [], updatedAt: "" }
    : { v: 1, seriesId, pending: [], updatedAt: "" };

  const entryIdx = pendingFeed.pending.findIndex(
    (e) => e.pendingId === pendingId && e.status === "pending",
  );
  if (entryIdx < 0) throw new Error("Pending claim not found");

  const entry = pendingFeed.pending[entryIdx];

  // 2. Download the reserved ClaimedTicket
  const ticketJson = await downloadFromBytes(entry.claimedRef);
  const pendingTicket = JSON.parse(ticketJson) as ClaimedTicket;
  const editionNumber = pendingTicket.edition;

  // 3. Create approved ClaimedTicket
  const approvedTicket: ClaimedTicket = { ...pendingTicket, approvalStatus: "approved" };
  const newClaimedRef = await uploadToBytes(JSON.stringify(approvedTicket));
  console.log(`[approve] Approved ticket uploaded: ${newClaimedRef}, edition ${editionNumber}`);

  // 4. Update claims feed slot with approved ref
  const { page: claimPage, slot: claimSlot } = editionToPageSlot(editionNumber);
  const claimsPageData = await readFeedPage(topicClaims(seriesId, claimPage));
  const claimsData = claimsPageData ? new Uint8Array(claimsPageData) : new Uint8Array(4096);
  claimsData.set(hexToBytes32(newClaimedRef), claimSlot * 32);
  await writeFeedPage(topicClaims(seriesId, claimPage), claimsData);

  // 5. Update claimers feed (official claim record)
  const claimerAddress = entry.claimerKey; // already lowercase or "email:hash"
  await updateClaimersFeed(seriesId, {
    edition: editionNumber,
    claimerAddress,
    claimedRef: newClaimedRef,
    claimedAt: approvedTicket.claimedAt,
    orderRef: entry.orderRef,
  });

  // 6. Update user collection if wallet claim
  if (!entry.claimerKey.startsWith("email:")) {
    addToUserCollection(entry.claimerKey as Hex0x, {
      seriesId,
      eventId: approvedTicket.eventId,
      edition: editionNumber,
      claimedRef: newClaimedRef,
      claimedAt: approvedTicket.claimedAt,
    }).catch((err) => console.error("[approve] Failed to update user collection:", err));
  }

  // 7. Mark entry as approved
  pendingFeed.pending[entryIdx] = {
    ...entry,
    status: "approved",
    decidedAt: new Date().toISOString(),
  };
  pendingFeed.updatedAt = new Date().toISOString();
  await writeFeedPage(topicPendingClaims(seriesId), encodeJsonFeed(pendingFeed));
  console.log(`[approve] Pending claim ${pendingId} approved`);
}

export async function rejectPendingClaim(
  seriesId: string,
  pendingId: string,
  reason?: string,
): Promise<void> {
  // 1. Read pending-claims feed, find the entry
  const pendingPage = await readFeedPage(topicPendingClaims(seriesId));
  const pendingFeed: PendingClaimsFeed = pendingPage
    ? decodeJsonFeed<PendingClaimsFeed>(pendingPage) ?? { v: 1, seriesId, pending: [], updatedAt: "" }
    : { v: 1, seriesId, pending: [], updatedAt: "" };

  const entryIdx = pendingFeed.pending.findIndex(
    (e) => e.pendingId === pendingId && e.status === "pending",
  );
  if (entryIdx < 0) throw new Error("Pending claim not found");

  const entry = pendingFeed.pending[entryIdx];

  // 2. Download pending ticket to get edition number
  const ticketJson = await downloadFromBytes(entry.claimedRef);
  const pendingTicket = JSON.parse(ticketJson) as ClaimedTicket;
  const editionNumber = pendingTicket.edition;

  // 3. Clear the reserved slot in claims feed (makes it available again)
  const { page: claimPage, slot: claimSlot } = editionToPageSlot(editionNumber);
  const claimsPageData = await readFeedPage(topicClaims(seriesId, claimPage));
  const claimsData = claimsPageData ? new Uint8Array(claimsPageData) : new Uint8Array(4096);
  claimsData.set(new Uint8Array(32), claimSlot * 32); // zero out the slot
  await writeFeedPage(topicClaims(seriesId, claimPage), claimsData);
  console.log(`[reject] Cleared slot page ${claimPage}, slot ${claimSlot} for edition ${editionNumber}`);

  // 4. Mark entry as rejected
  pendingFeed.pending[entryIdx] = {
    ...entry,
    status: "rejected",
    decidedAt: new Date().toISOString(),
    ...(reason ? { rejectionReason: reason } : {}),
  };
  pendingFeed.updatedAt = new Date().toISOString();
  await writeFeedPage(topicPendingClaims(seriesId), encodeJsonFeed(pendingFeed));
  console.log(`[reject] Pending claim ${pendingId} rejected`);
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

/** Convert an edition number back to its page + slot in the claims feed */
function editionToPageSlot(edition: number): { page: number; slot: number } {
  if (edition <= PAGE_0_CAPACITY) {
    return { page: 0, slot: edition }; // slot 1 = edition 1
  }
  const rem = edition - PAGE_0_CAPACITY - 1;
  const page = 1 + Math.floor(rem / PAGE_N_CAPACITY);
  const slot = rem % PAGE_N_CAPACITY;
  return { page, slot };
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

export async function addToUserCollection(ethAddress: string, entry: CollectionEntry): Promise<void> {
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

/** Add a ticket entry to an email-keyed collection feed (woco/pod/collection/email:{hash}) */
export async function addToEmailCollection(emailHash: string, entry: CollectionEntry): Promise<void> {
  return addToUserCollection(`email:${emailHash}`, entry);
}
