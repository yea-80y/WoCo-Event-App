import { createHmac, randomUUID } from "node:crypto";
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
  | {
      type: "wallet";
      address: Hex0x;
      /** Optional secondary email identifier — set when a logged-in wallet user
       *  pays by Stripe with a customer email. Recorded on the claim so dedup
       *  works against both handles (wallet OR email). */
      secondaryEmail?: string;
      secondaryEmailHash?: string;
    }
  | { type: "email"; email: string; emailHash: string };

/**
 * Hash email for privacy-safe storage using HMAC-SHA256 with a server-side
 * secret. Email hashes live on publicly-readable Swarm feeds — without the
 * HMAC key, an unsalted SHA-256 is trivially reversible via rainbow tables.
 *
 * `EMAIL_HASH_SECRET` is mandatory: startup fails if unset (see index.ts).
 * The legacy unsalted-SHA-256 path + `legacyEmailHash` dual-lookup were
 * removed after confirming no active claims on the old hash format.
 */
export function hashEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  const secret = process.env.EMAIL_HASH_SECRET;
  if (!secret) {
    // Should never hit this in practice — index.ts refuses to start without the env var.
    throw new Error("EMAIL_HASH_SECRET is not set");
  }
  return createHmac("sha256", secret).update(normalized).digest("hex");
}

// ---------------------------------------------------------------------------
// Claim a ticket
// ---------------------------------------------------------------------------

export async function claimTicket(opts: {
  seriesId: string;
  identifier: ClaimIdentifier;
  encryptedOrder?: SealedBox;
  /** Payment method, if known. Stored on the claim entry for dashboard display. */
  via?: import("@woco/shared").ClaimVia;
  /**
   * True when this claim represents a real paid purchase. Paid claims allow
   * the same identifier to purchase multiple tickets of the same series —
   * per-purchase uniqueness is enforced by txHash-replay prevention (crypto)
   * or the Stripe payment_intent (card), not by identifier dedup.
   *
   * Free and approval-required series keep the single-claim-per-identifier
   * rule (spam prevention).
   */
  paid?: boolean;
}): Promise<ClaimResult> {
  const { seriesId, identifier, encryptedOrder, via, paid } = opts;

  const logId = identifier.type === "wallet" ? identifier.address : `email:${identifier.emailHash.slice(0, 12)}...`;
  console.log(`[claim] Claiming ticket for series ${seriesId}, claimer ${logId}`);

  // 0. Reject duplicate approved claims — check claimers feed before any expensive work.
  //    This runs inside the per-series queue so the read is always up-to-date.
  const claimerKey = identifier.type === "wallet"
    ? identifier.address.toLowerCase()
    : `email:${identifier.emailHash}`;

  // For dual-identity Stripe claims (wallet + email), dedup against BOTH
  // handles: wallet claim would match the primary key; an earlier email-only
  // claim with the same email would match via the email-prefixed key or a
  // secondaryEmailHash on some prior dual-identity entry.
  const secondaryEmailHash =
    identifier.type === "wallet" ? identifier.secondaryEmailHash : undefined;

  // Paid series allow multi-purchase: one identifier can hold multiple editions
  // because each purchase is independently verified (on-chain txHash consumed,
  // or Stripe payment_intent settled). Free/approval series keep the one-per-
  // identifier rule to stop spam.
  if (!paid) {
    const existingClaimersPage = await readFeedPage(topicClaimers(seriesId));
    if (existingClaimersPage) {
      const existingFeed = decodeJsonFeed<ClaimersFeed>(existingClaimersPage);
      const duplicate = existingFeed?.claimers.some((c) => {
        const key = c.claimerAddress.toLowerCase();
        if (key === claimerKey) return true;
        if (secondaryEmailHash) {
          if (key === `email:${secondaryEmailHash}`) return true;
          if (c.secondaryEmailHash === secondaryEmailHash) return true;
        }
        if (identifier.type === "email") {
          if (c.secondaryEmailHash === identifier.emailHash) return true;
        }
        return false;
      });
      if (duplicate) {
        throw new Error("Already claimed");
      }
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
    ownerEmailHash:
      identifier.type === "email"
        ? identifier.emailHash
        : identifier.secondaryEmailHash,
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
      ...(via ? { via } : {}),
      ...(secondaryEmailHash ? { secondaryEmailHash } : {}),
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

/** Safety cap to bound probe cost — ~20 entries/page × 50 = 1000 tickets/user. */
const COLLECTION_MAX_PAGES = 50;

/**
 * Read a user's full collection across all pages. Probes sequentially
 * starting at page 0 and stops at the first missing page. Writers write
 * contiguously so a gap means end-of-data.
 */
export async function getUserCollection(address: string): Promise<UserCollection | null> {
  const page0Raw = await readFeedPage(topicUserCollection(address, 0));
  if (!page0Raw) return null;
  const page0 = decodeJsonFeed<UserCollection>(page0Raw);
  if (!page0) return null;

  const allEntries: CollectionEntry[] = [...page0.entries];
  let latestUpdatedAt = page0.updatedAt;

  for (let i = 1; i < COLLECTION_MAX_PAGES; i++) {
    const raw = await readFeedPage(topicUserCollection(address, i));
    if (!raw) break;
    const parsed = decodeJsonFeed<UserCollection>(raw);
    if (!parsed) break;
    allEntries.push(...parsed.entries);
    if (parsed.updatedAt > latestUpdatedAt) latestUpdatedAt = parsed.updatedAt;
  }

  return { v: 1, entries: allEntries, updatedAt: latestUpdatedAt };
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

  // Idempotent by edition — each edition is unique per series, so this
  // protects against duplicate writes from the same claim operation while
  // still allowing the same identifier to hold multiple editions of a paid
  // series (claimerAddress is no longer unique per entry).
  if (feed.claimers.some((c) => c.edition === entry.edition)) {
    return;
  }

  feed.claimers.push(entry);
  feed.updatedAt = new Date().toISOString();

  await writeFeedPage(topicClaimers(seriesId), encodeJsonFeed(feed));
  console.log(`[claim] Claimers feed updated: ${feed.claimers.length} claims`);
}

export async function addToUserCollection(ethAddress: string, entry: CollectionEntry): Promise<void> {
  // Probe pages 0..N until a gap; accumulate entries for dedup and locate the
  // current tail page. Contiguous writes mean the first missing page = end.
  const pages: UserCollection[] = [];
  for (let i = 0; i < COLLECTION_MAX_PAGES; i++) {
    const raw = await readFeedPage(topicUserCollection(ethAddress, i));
    if (!raw) break;
    const parsed = decodeJsonFeed<UserCollection>(raw);
    if (!parsed) break;
    pages.push(parsed);
  }

  const allEntries = pages.flatMap((p) => p.entries);

  // Dedup by claimedRef (unique per edition) — a user who buys multiple
  // editions of the same paid series should see every one of them in their
  // collection. Only true duplicate writes of the same claim are dropped.
  if (allEntries.some((e) => e.claimedRef === entry.claimedRef)) return;

  const updatedAt = new Date().toISOString();

  if (pages.length === 0) {
    // First ticket for this address.
    const firstPage: UserCollection = { v: 1, entries: [entry], updatedAt };
    await writeFeedPage(topicUserCollection(ethAddress, 0), encodeJsonFeed(firstPage));
    console.log(`[claim] User collection created: page 0, 1 entry`);
    return;
  }

  if (pages.length >= COLLECTION_MAX_PAGES) {
    throw new Error(`Collection exceeds ${COLLECTION_MAX_PAGES} pages — refusing further writes`);
  }

  // Try to append to the last page; on JSON-feed overflow, spill to a new page.
  const lastPageIdx = pages.length - 1;
  const lastPage = pages[lastPageIdx];
  const candidate: UserCollection = {
    ...lastPage,
    entries: [...lastPage.entries, entry],
    updatedAt,
  };

  try {
    const bytes = encodeJsonFeed(candidate);
    await writeFeedPage(topicUserCollection(ethAddress, lastPageIdx), bytes);
    console.log(`[claim] User collection updated: page ${lastPageIdx}, ${candidate.entries.length} entries on page`);
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    const newPageIdx = pages.length;
    const newPage: UserCollection = { v: 1, entries: [entry], updatedAt };
    await writeFeedPage(topicUserCollection(ethAddress, newPageIdx), encodeJsonFeed(newPage));
    console.log(`[claim] User collection spilled to page ${newPageIdx}`);
  }
}

/** Add a ticket entry to an email-keyed collection feed (woco/pod/collection/email:{hash}) */
export async function addToEmailCollection(emailHash: string, entry: CollectionEntry): Promise<void> {
  return addToUserCollection(`email:${emailHash}`, entry);
}
