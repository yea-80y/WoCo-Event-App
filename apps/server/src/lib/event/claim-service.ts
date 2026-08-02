import { createHmac, hkdfSync, randomUUID } from "node:crypto";
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
import { verifyTicketSignature, contentFeedSocIdentifier, editionsContentTopic } from "@woco/shared";
import { uploadToBytes, downloadFromBytes } from "../swarm/bytes.js";
import { readSocPayload } from "../swarm/soc-upload.js";
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
import { heldFor } from "./reservation-store.js";
import { appendClaimerEntry, attachOrderRefToClaimers, readAllClaimers } from "./claimers-feed.js";
import { readClaimsPageStrict, selectFreeSlot } from "./claims-feed.js";
import {
  readPendingPages,
  mergePendingPages,
  appendPendingEntry,
  markPendingDecided,
} from "./pending-claims-feed.js";
import { sealClaimer, unsealClaimer } from "./claimer-seal.js";
import { bindTicket } from "../gate/store.js";
import { signOwnerBinding } from "../ticket/owner-binding.js";

/** Internal result type — `_pendingId` is stripped before returning to clients */
export type ClaimResult = ClaimedTicket & { _pendingId?: string };

// ---------------------------------------------------------------------------
// Editions feed reads (carrier-owned SOC | legacy platform feed)
// ---------------------------------------------------------------------------
//
// Phase B: a client-owned event's editions feed is a Single-Owner Chunk owned by
// the organiser's content-feed signer (the `carrier` — a public ADDRESS, resolved
// server-side from the trusted event feed, NEVER from a client request). The
// server holds no key for it; it can only READ. When no carrier is known we fall
// back to the legacy platform-signed feed (older events). The 4096-byte `pack4096`
// page is the SOC's inline payload — same bytes the legacy feed held, so every
// decode below (`decode4096`, slot-0 metaRef) is unchanged.

function bytesToHexStr(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function editionsSocIdHex(seriesId: string, page: number): string {
  return bytesToHexStr(contentFeedSocIdentifier(editionsContentTopic(seriesId, page)));
}

/** Read one editions page — carrier-owned SOC when a carrier is known, else the
 *  legacy platform feed. Returns the raw 4096-byte page or null if absent. */
async function readEditionsPage(
  seriesId: string,
  page: number,
  carrier?: string,
): Promise<Uint8Array | null> {
  if (carrier) {
    return readSocPayload(carrier, editionsSocIdHex(seriesId, page)).catch(() => null);
  }
  return readFeedPage(topicEditions(seriesId, page));
}

/** Page-0 read with retry — first claim after publish may race SOC/feed
 *  propagation. Mirrors `readFeedPageWithRetry` for the carrier path. */
async function readEditionsPage0WithRetry(
  seriesId: string,
  carrier?: string,
  maxRetries = 5,
  initialDelayMs = 1000,
): Promise<Uint8Array | null> {
  if (!carrier) return readFeedPageWithRetry(topicEditions(seriesId, 0));
  let delay = initialDelayMs;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await readEditionsPage(seriesId, 0, carrier);
    if (result) return result;
    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, 5000);
    }
  }
  return null;
}

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

/** Prefix for HMAC-hashed wallet handles on public feeds (claimers, pending). */
export const WALLET_HANDLE_PREFIX = "wallet:";

/**
 * Hash a wallet address for public-feed storage, same rationale as hashEmail:
 * the claimers/pending feeds sit at derivable public addresses, and a raw
 * wallet address there is a publicly-linkable record of who attended a named
 * event.
 *
 * Two properties are load-bearing:
 * - KEY separation, not input separation: hashEmail HMACs attacker-chosen
 *   strings under EMAIL_HASH_SECRET with no prefix (legacy format, frozen by
 *   every stored hash), so no input convention can stop a crafted "email"
 *   from colliding with a wallet hash under the same key. Wallet hashing
 *   therefore uses its own HKDF-derived key — the two PRFs are independent.
 * - the seriesId salt makes the same wallet produce a DIFFERENT handle in
 *   every series, so public observers cannot link one person's attendance
 *   across events. Every comparison in this codebase is within one series,
 *   so the salt costs nothing functionally. Do not remove it to "simplify" —
 *   a global handle rebuilds the cross-event profile this exists to prevent.
 *
 * Rotating EMAIL_HASH_SECRET breaks dedup continuity for wallet claims
 * exactly as it does for email claims.
 */
export function hashWalletAddress(address: string, seriesId: string): string {
  const secret = process.env.EMAIL_HASH_SECRET;
  if (!secret) {
    throw new Error("EMAIL_HASH_SECRET is not set");
  }
  const walletKey = hkdfSync("sha256", secret, "", "woco/wallet-hash/v1", 32);
  return createHmac("sha256", Buffer.from(walletKey))
    .update(`${seriesId}:${address.trim().toLowerCase()}`)
    .digest("hex");
}

/** Public-feed claim handle for a wallet address: "wallet:{hmac}". */
export function walletHandle(address: string, seriesId: string): string {
  return WALLET_HANDLE_PREFIX + hashWalletAddress(address, seriesId);
}

/**
 * Does a feed entry's claim handle refer to the given internal claimer key
 * (lowercase wallet address, or "email:{hash}")? Matches the hashed form and,
 * for wallet keys, the bare-address form written before 2026-08-01.
 */
export function claimHandleMatches(entryHandle: string, claimerKey: string, seriesId: string): boolean {
  const entry = entryHandle.toLowerCase();
  const key = claimerKey.toLowerCase();
  if (entry === key) return true; // email:{hash} equality, or legacy bare address
  if (key.startsWith("email:") || key.startsWith(WALLET_HANDLE_PREFIX)) return false;
  return entry === walletHandle(key, seriesId);
}

// ---------------------------------------------------------------------------
// Claim a ticket
// ---------------------------------------------------------------------------

export async function claimTicket(opts: {
  seriesId: string;
  identifier: ClaimIdentifier;
  encryptedOrder?: SealedBox;
  /**
   * Pre-uploaded order Swarm ref. When present, skips the upload step and
   * uses this ref directly — used by the Stripe flow, which pre-uploads the
   * encrypted order before redirecting to Checkout so every ticket in a
   * multi-purchase batch gets the full form data without relying on a
   * post-return save-order call from the browser.
   */
  orderRef?: string;
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
  /** Override the claim timestamp (ISO string). Defaults to now. Used by Stripe webhook to record payment time. */
  claimedAt?: string;
  /** Phase B: organiser's content-feed signer ADDRESS (the editions SOC owner).
   *  Resolved server-side from the trusted event feed (`creatorFeedSigner`), never
   *  from the request body. Absent ⇒ legacy platform-signed editions feed. */
  carrier?: string;
  /**
   * Present when the claimer has a WoCo account at claim time (claimed.v2,
   * plan §3 "go-forward claims"). The caller MUST have verified the account:
   * wallet-session claims use the verified parent; the Stripe webhook uses
   * the server-vouched metadata.claimerAddress. Effects:
   *  - `podPubKey` set → ClaimedTicket born as v2 with `owner` + platform
   *    `ownerSig` (issued-to-identity, no bearer dance ever needed)
   *  - the edition is gate-bound to `parentAddress` at claim time (on approve
   *    for approval-required series) — profile unlocked with the purchase
   */
  accountClaim?: { parentAddress: string; podPubKey?: string };
}): Promise<ClaimResult> {
  const { seriesId, identifier, encryptedOrder, orderRef: prefetchedOrderRef, via, paid, claimedAt: claimedAtOverride, carrier, accountClaim } = opts;

  const logId = identifier.type === "wallet" ? identifier.address : `email:${identifier.emailHash.slice(0, 12)}...`;
  console.log(`[claim] Claiming ticket for series ${seriesId}, claimer ${logId}`);

  // Phase timings — surface where Swarm latency lands per claim.
  const tStart = Date.now();
  let tPhase = tStart;
  const lap = (): number => { const d = Date.now() - tPhase; tPhase = Date.now(); return d; };
  const timings: Record<string, number> = {};

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
    const existingClaimers = await readAllClaimers(seriesId);
    {
      const duplicate = existingClaimers.some((c) => {
        if (claimHandleMatches(c.claimerAddress, claimerKey, seriesId)) return true;
        if (secondaryEmailHash) {
          if (c.claimerAddress.toLowerCase() === `email:${secondaryEmailHash}`) return true;
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
    timings.dedup = lap();
  } else {
    tPhase = Date.now();
  }

  // 1. Load series metadata via process-level cache. Editions feed + meta
  //    JSON are both immutable (written once at publish, never updated), so
  //    a process-lifetime cache is safe and saves 2 Swarm round-trips per
  //    claim after the first one — these dominated the measured per-claim
  //    latency.
  const cachedMeta = await loadSeriesMeta(seriesId, carrier);
  timings.metaRead = lap();

  const editionsPage0 = cachedMeta.editionsPage0;
  const pageCount = cachedMeta.pageCount;
  const approvalRequired = cachedMeta.approvalRequired;

  // 1b. For approval-required series: reject duplicate pending requests
  if (approvalRequired) {
    const pendingFeed = await getPendingClaimsFeed(seriesId);
    if (pendingFeed?.pending.some(
      (e) => claimHandleMatches(e.claimerKey, claimerKey, seriesId) && e.status === "pending",
    )) {
      throw new Error("Already requested");
    }
    timings.pendingCheck = lap();
  }

  // 2. Find next unclaimed slot. Parallel fetch of all claims + editions pages;
  //    a claims page that will not read rejects here, before anything is
  //    allocated, rather than reading as 128 free slots.
  const pageResults = await Promise.all(
    Array.from({ length: pageCount }, async (_, p) => {
      const [claims, editions] = await Promise.all([
        readClaimsPageStrict(seriesId, p),
        p === 0 ? Promise.resolve(editionsPage0) : readEditionsPage(seriesId, p, carrier),
      ]);
      return { claims, editions };
    }),
  );

  const free = selectFreeSlot(pageResults);
  if (!free || !free.ticketRef) {
    throw new Error("No tickets available");
  }
  const { page: foundPage, slot: foundSlot, ticketRef, claimsPage: cachedClaimsPageData } = free;
  timings.findSlot = lap();

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
  timings.ticketDl = lap();

  // Verify ed25519 signature — defence-in-depth against feed tampering
  if (!verifyTicketSignature(originalTicket)) {
    console.error(`[claim] INVALID SIGNATURE on ticket ref ${ticketRef}, edition ${editionNumber}`);
    throw new Error("Ticket signature verification failed");
  }

  // 5. Create claimed ticket. With a verified account present (accountClaim)
  //    and a POD pubkey, the ticket is born issued-to-identity: claimed.v2,
  //    owner + platform ownerSig from the first byte — no bearer dance later.
  const claimedAt = claimedAtOverride ?? new Date().toISOString();
  const ownerPodPubKey = accountClaim?.podPubKey?.toLowerCase();
  let ownerBound = !!ownerPodPubKey && /^[0-9a-f]{64}$/.test(ownerPodPubKey);

  const claimedTicket: ClaimedTicket = {
    podType: ownerBound ? "woco.ticket.claimed.v2" : "woco.ticket.claimed.v1",
    eventId: originalTicket.data.eventId,
    seriesId: originalTicket.data.seriesId,
    seriesName: originalTicket.data.seriesName,
    edition: originalTicket.data.edition,
    totalSupply: originalTicket.data.totalSupply,
    imageHash: originalTicket.data.imageHash,
    creator: originalTicket.data.creator,
    mintedAt: originalTicket.data.mintedAt,
    ...(ownerBound ? { owner: ownerPodPubKey } : {}),
    // Public blob (reachable via the claims feed) — never the raw address.
    ...(identifier.type === "wallet"
      ? { ownerAddressHash: hashWalletAddress(identifier.address, seriesId) }
      : {}),
    ownerEmailHash:
      identifier.type === "email"
        ? identifier.emailHash
        : identifier.secondaryEmailHash,
    claimedAt,
    originalPodHash: ticketRef,
    originalSignature: originalTicket.signature,
    ...(approvalRequired ? { approvalStatus: "pending" as const } : {}),
  };

  if (ownerBound) {
    try {
      claimedTicket.ownerSig = await signOwnerBinding({
        eventId: claimedTicket.eventId,
        seriesId: claimedTicket.seriesId,
        edition: claimedTicket.edition,
        owner: ownerPodPubKey!,
        claimedAt,
      });
    } catch (err) {
      // Never block a sale on the attestation — downgrade to a v1 bearer
      // ticket with the owner field as a plain retro-style stamp.
      console.error("[claim] ownerSig signing failed — downgrading to v1:", err);
      claimedTicket.podType = "woco.ticket.claimed.v1";
      ownerBound = false;
    }
  }

  // 6. Upload claimed ticket to /bytes
  const claimedRef = await uploadToBytes(JSON.stringify(claimedTicket));
  console.log(`[claim] Uploaded claimed ticket: ${claimedRef}`);
  timings.ticketUp = lap();

  // 7. Write claim hash to claims feed at the found slot — reserves the slot.
  //    Starting from a blank page is only safe because the scan used the strict
  //    reader: a null here means the page has never been written, so there is
  //    nothing on it to preserve.
  const claimsData = cachedClaimsPageData ? new Uint8Array(cachedClaimsPageData) : new Uint8Array(4096);
  const refBytes = hexToBytes32(claimedRef);
  claimsData.set(refBytes, foundSlot * 32);

  await writeFeedPage(topicClaims(seriesId, foundPage), claimsData);
  console.log(`[claim] Updated claims feed page ${foundPage}, slot ${foundSlot}`);
  timings.claimsFeedWrite = lap();

  // 8. Approval gate or instant completion
  // Public claim handle — hashed for wallets, never the raw address (the
  // claimers and pending feeds sit at publicly derivable SOC addresses).
  const claimerAddress = identifier.type === "wallet"
    ? walletHandle(identifier.address, seriesId)
    : `email:${identifier.emailHash}`;

  let orderRef: string | undefined = prefetchedOrderRef;
  if (!orderRef && encryptedOrder) {
    try {
      orderRef = await uploadToBytes(JSON.stringify(encryptedOrder));
      console.log(`[claim] Encrypted order stored: ${orderRef}`);
    } catch (err) {
      console.error("[claim] Failed to store encrypted order:", err);
    }
    timings.orderUp = lap();
  } else if (orderRef) {
    console.log(`[claim] Using pre-uploaded order ref: ${orderRef}`);
    tPhase = Date.now();
  }

  if (approvalRequired) {
    // Pending path: store in pending-claims feed, skip claimers/collection.
    // claimerKey on the feed is the PUBLIC handle; the raw wallet address the
    // approve path needs (gate binding + collection topic) rides sealed.
    const pendingId = randomUUID();
    await createPendingClaimEntry(seriesId, {
      pendingId,
      claimerKey: claimerAddress,
      ...(identifier.type === "wallet"
        ? { claimerSealed: sealClaimer(identifier.address.toLowerCase(), seriesId, pendingId) }
        : {}),
      requestedAt: claimedTicket.claimedAt,
      orderRef,
      claimedRef,
      status: "pending",
    }, claimerKey);
    console.log(`[claim] Pending claim created: ${pendingId} for edition ${editionNumber}`);
    return { ...claimedTicket, _pendingId: pendingId };
  }

  // Account-holder claim: gate-bind the edition at purchase so the buyer's
  // profile is unlocked with the ticket — no Route A/B dance. Sync file write;
  // an already-consumed edition is a silent no-op (nullifier semantics).
  if (accountClaim) {
    // Never let this throw: the slot is already written, so the ticket exists.
    // A throw here would propagate to the Stripe webhook, which stops the batch
    // and refunds — handing the buyer their money back while they keep a
    // discoverable, door-valid ticket. The bind is best-effort by design; the
    // attendee gate can rebind later.
    try {
      const bound = bindTicket({
        seriesId,
        edition: editionNumber,
        eventId: originalTicket.data.eventId,
        parentAddress: accountClaim.parentAddress,
        podPubKey: ownerBound ? ownerPodPubKey : undefined,
        paid: !!paid,
        route: "claim",
      });
      if (bound) {
        console.log(`[gate] bound ${seriesId}#${editionNumber} → ${accountClaim.parentAddress} (claim)`);
      }
    } catch (err) {
      console.error(`[gate] bind failed for ${seriesId}#${editionNumber} — ticket stands:`, err);
    }
  }

  // Normal path: claimers feed write goes to a per-series background queue
  // (see `enqueueClaimersUpdate` for the ordering rationale). The buyer's
  // claim is already durable in the claims feed at this point — claimers is
  // a derived index used by the dashboard and the optional /save-order
  // attachment, both of which tolerate eventual consistency.
  const tClaimersEnqueue = Date.now();
  enqueueClaimersUpdate(seriesId, {
    edition: editionNumber,
    claimerAddress,
    claimedRef,
    claimedAt: claimedTicket.claimedAt,
    orderRef,
    ...(via ? { via } : {}),
    ...(secondaryEmailHash ? { secondaryEmailHash } : {}),
  })
    .then(() => console.log(`[claim] claimers bg=${Date.now() - tClaimersEnqueue}ms (edition=${editionNumber})`))
    .catch((err) => console.error("[claim] Failed to update claimers feed (bg):", err));
  timings.claimersFeed = lap(); // expected ≈ 0 — measures enqueue, not write

  // Update user collection in background (non-critical, wallet only)
  if (identifier.type === "wallet") {
    const tCol = Date.now();
    addToUserCollection(identifier.address, {
      seriesId,
      eventId: originalTicket.data.eventId,
      edition: editionNumber,
      claimedRef,
      claimedAt: claimedTicket.claimedAt,
    })
      .then(() => console.log(`[claim] collection bg=${Date.now() - tCol}ms (edition=${editionNumber})`))
      .catch((err) => console.error("[claim] Failed to update user collection (non-critical):", err));
  }

  const summary = Object.entries(timings).map(([k, v]) => `${k}=${v}ms`).join(" ");
  console.log(`[claim] timings — ${summary} total=${Date.now() - tStart}ms (edition=${editionNumber} pages=${pageCount})`);
  console.log(`[claim] Ticket claimed successfully: edition ${editionNumber}`);
  return claimedTicket;
}

// ---------------------------------------------------------------------------
// Get claim status
// ---------------------------------------------------------------------------

/** Module-level cache of immutable series state. Editions page 0 + the
 *  metadata JSON it points to are written ONCE at series creation
 *  (`service.ts` writes `topicEditions(seriesId, p)` exactly once per page
 *  and never re-writes them — only `topicClaims` mutates as tickets get
 *  claimed). Caching for the life of the process is therefore safe; entries
 *  cannot become stale. Server restart simply repopulates on first claim.
 *
 *  Storing the raw `editionsPage0` bytes lets the claim path skip BOTH the
 *  feed read and the metadata download — these were the dominant cost in
 *  the per-claim timing trace. */
type CachedSeriesMeta = {
  totalSupply: number;
  pageCount: number;
  approvalRequired: boolean;
  /** Raw 4096-byte editions feed page 0 — contains [metaRef, ticketRef0..N].
   *  Treat as read-only; callers should `new Uint8Array(...)` if mutating. */
  editionsPage0: Uint8Array;
};

const seriesMetaCache = new Map<string, CachedSeriesMeta>();

async function loadSeriesMeta(seriesId: string, carrier?: string): Promise<CachedSeriesMeta> {
  // Cache key includes the carrier: a client-owned event and a legacy event
  // could (in theory) collide on seriesId, and an early no-carrier miss must not
  // pin a wrong entry for a later carrier-aware read. Editions are immutable, so
  // the (seriesId, carrier) entry is safe for the process lifetime.
  const cacheKey = carrier ? `${seriesId}|${carrier.toLowerCase()}` : seriesId;
  const cached = seriesMetaCache.get(cacheKey);
  if (cached) return cached;

  // Use the retry variant — first-time load may race with feed/SOC propagation
  // right after series creation. Subsequent calls hit the cache so retry
  // cost is paid at most once.
  const editionsPage0 = await readEditionsPage0WithRetry(seriesId, carrier);
  if (!editionsPage0) throw new Error("Series not found");
  const refs = decode4096(editionsPage0);
  if (refs.length === 0) throw new Error("Series has no metadata");

  const metaJson = await downloadFromBytes(refs[0]);
  const parsed = JSON.parse(metaJson) as {
    totalSupply: number;
    pageCount?: number;
    approvalRequired?: boolean;
  };
  const meta: CachedSeriesMeta = {
    totalSupply: parsed.totalSupply,
    pageCount: parsed.pageCount || 1,
    approvalRequired: !!parsed.approvalRequired,
    editionsPage0,
  };
  seriesMetaCache.set(cacheKey, meta);
  return meta;
}

export async function getClaimStatus(
  seriesId: string,
  userAddress?: string,
  userEmailHash?: string,
  carrier?: string,
): Promise<SeriesClaimStatus> {
  const meta = await loadSeriesMeta(seriesId, carrier);
  const pageCount = meta.pageCount;

  // Fan out reads: all claim pages + (when needed) pending-claims feed in
  // parallel. Per-page Swarm reads are independent; serialising them was the
  // largest avoidable latency for events with multiple pages.
  const wantUserLookup = !!(userAddress || userEmailHash);
  // Strict, because `available` here is what /reserve hands checkout holds
  // against: a page read as empty under-counts `claimed`, oversells the series,
  // and the buyer pays for a ticket the claim path then cannot issue.
  const claimPagesPromise = Promise.all(
    Array.from({ length: pageCount }, (_, p) => readClaimsPageStrict(seriesId, p)),
  );
  const pendingPromise: Promise<PendingClaimsFeed | null> = wantUserLookup
    ? getPendingClaimsFeed(seriesId)
    : Promise.resolve(null);

  const [claimPages, pendingFeed] = await Promise.all([claimPagesPromise, pendingPromise]);

  // Walk the slot table to count claimed editions. Per-slot ticket-body reads
  // are only required when we need to identify the requesting user's
  // editions; the reservation path passes no user and skips them entirely.
  let claimed = 0;
  const ticketReads: Array<Promise<{ ref: string } & Partial<ClaimedTicket>>> = [];

  for (let p = 0; p < pageCount; p++) {
    const claimsPage = claimPages[p];
    if (!claimsPage) continue;

    const claims = decode4096Claims(claimsPage);
    const startSlot = p === 0 ? 1 : 0;

    for (let s = startSlot; s < 128; s++) {
      const ref = claims[s];
      if (ref === "") continue;
      claimed++;

      if (wantUserLookup) {
        ticketReads.push(
          downloadFromBytes(ref)
            .then((json) => ({ ref, ...(JSON.parse(json) as ClaimedTicket) }))
            .catch(() => ({ ref })),
        );
      }
    }
  }

  const userEditions: number[] = [];
  if (wantUserLookup && ticketReads.length > 0) {
    const tickets = await Promise.all(ticketReads);
    const userAddressHash = userAddress ? hashWalletAddress(userAddress, seriesId) : undefined;
    for (const ct of tickets) {
      if (ct.approvalStatus === "pending") continue;
      const walletMatch = userAddress && (
        ct.ownerAddressHash === userAddressHash ||
        // Legacy tickets (pre-2026-08-01) carry the raw address.
        ct.ownerAddress?.toLowerCase() === userAddress.toLowerCase()
      );
      if (walletMatch) {
        if (typeof ct.edition === "number") userEditions.push(ct.edition);
      } else if (userEmailHash && ct.ownerEmailHash === userEmailHash) {
        if (typeof ct.edition === "number") userEditions.push(ct.edition);
      }
    }
  }

  let userPendingId: string | undefined;
  if (wantUserLookup) {
    const claimerKey = userAddress
      ? userAddress.toLowerCase()
      : `email:${userEmailHash}`;
    const entry = pendingFeed?.pending.find(
      (e) => claimHandleMatches(e.claimerKey, claimerKey, seriesId) && e.status === "pending",
    );
    if (entry) userPendingId = entry.pendingId;
  }

  userEditions.sort((a, b) => a - b);
  const userEdition = userEditions[0];

  // `available` is the physical remaining count — totalSupply minus confirmed
  // claims. Active reservations are NOT subtracted here: doing so contaminates
  // the shared cache (a user's own reservation reduces THEIR own visible
  // availability) and produces false "Not enough tickets" UI for the buyer
  // who placed the hold. Concurrency is enforced at /reserve time, where the
  // server checks held+requested against true availability and returns the
  // precise remaining count if oversubscribed.
  const available = Math.max(0, meta.totalSupply - claimed);
  const held = heldFor(seriesId);

  return {
    seriesId,
    totalSupply: meta.totalSupply,
    claimed,
    available,
    held,
    ...(userEditions.length > 0 ? { userEdition, userEditions } : {}),
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

/**
 * Fetch a single ClaimedTicket by its edition number — one page read + one
 * body read instead of the full getClaimStatus fan-out. Used by the attendee
 * gate to check `ownerEmailHash` against a presented email.
 */
export async function getClaimedTicketByEdition(
  seriesId: string,
  edition: number,
): Promise<ClaimedTicket | null> {
  if (!Number.isInteger(edition) || edition < 1) return null;
  const { page, slot } = editionToPageSlot(edition);
  // Strict: a gate check must not read a transient failure as "no such ticket".
  const claimsPage = await readClaimsPageStrict(seriesId, page);
  if (!claimsPage) return null;
  const ref = decode4096Claims(claimsPage)[slot];
  if (!ref) return null;
  return getClaimedTicketDetail(ref);
}

export type StampResult = "stamped" | "already-owned" | "not-found";

/**
 * Stamp the attendee's ed25519 POD pubkey into `ClaimedTicket.owner` and
 * republish the claims-feed slot (attendee gate bind → de-platformed
 * ownership record, plan §3). First stamp wins: an existing DIFFERENT owner
 * is never overwritten — the gate nullifier already guarantees one bind per
 * edition, so a conflicting owner means a v2 issued-to-identity ticket or an
 * earlier stamp, both authoritative over a retro-bind.
 *
 * MUST run inside `queueSeriesClaim(seriesId, …)` — this is a read-modify-write
 * of a claims page that concurrent claim allocations also rewrite.
 */
export async function stampTicketOwner(
  seriesId: string,
  edition: number,
  podPubKey: string,
): Promise<StampResult> {
  const { page, slot } = editionToPageSlot(edition);
  // Strict: this rewrites the page, and "not-found" on a transient failure
  // would silently skip the owner bind rather than let the caller retry.
  const claimsPageData = await readClaimsPageStrict(seriesId, page);
  if (!claimsPageData) return "not-found";
  const ref = decode4096Claims(claimsPageData)[slot];
  if (!ref) return "not-found";

  const ticket = JSON.parse(await downloadFromBytes(ref)) as ClaimedTicket;
  if (ticket.owner) return ticket.owner === podPubKey ? "stamped" : "already-owned";

  const stamped: ClaimedTicket = { ...ticket, owner: podPubKey };
  const newRef = await uploadToBytes(JSON.stringify(stamped));

  const claimsData = new Uint8Array(claimsPageData);
  claimsData.set(hexToBytes32(newRef), slot * 32);
  await writeFeedPage(topicClaims(seriesId, page), claimsData);
  console.log(`[gate] owner stamped: ${seriesId}#${edition} → pod:${podPubKey.slice(0, 12)}… (${newRef})`);
  return "stamped";
}

// ---------------------------------------------------------------------------
// Pending claims feed
// ---------------------------------------------------------------------------

/** Every page of the pending feed flattened into one view. Null when the feed
 *  has never been written. */
export async function getPendingClaimsFeed(seriesId: string): Promise<PendingClaimsFeed | null> {
  return mergePendingPages(seriesId, await readPendingPages(seriesId));
}

/** The still-pending entry with this id, or null. Read only — the write that
 *  acts on it re-checks inside the pending queue. */
async function findPendingEntry(
  seriesId: string,
  pendingId: string,
): Promise<PendingClaimEntry | null> {
  const pages = await readPendingPages(seriesId);
  return (
    pages
      .flatMap((p) => p.pending)
      .find((e) => e.pendingId === pendingId && e.status === "pending") ?? null
  );
}

function createPendingClaimEntry(
  seriesId: string,
  entry: PendingClaimEntry,
  // Internal claimer key (raw lowercase address or "email:{hash}") — needed to
  // match legacy pending entries that stored the bare address.
  rawClaimerKey: string,
): Promise<void> {
  return enqueuePendingOp(seriesId, () =>
    appendPendingEntry(seriesId, entry, (e) =>
      claimHandleMatches(e.claimerKey, rawClaimerKey, seriesId),
    ),
  );
}

export async function approvePendingClaim(
  seriesId: string,
  pendingId: string,
): Promise<void> {
  // 1. Find the entry across the pending feed's pages
  const entry = await findPendingEntry(seriesId, pendingId);
  if (!entry) throw new Error("Pending claim not found");

  // 2. Download the reserved ClaimedTicket
  const ticketJson = await downloadFromBytes(entry.claimedRef);
  const pendingTicket = JSON.parse(ticketJson) as ClaimedTicket;
  const editionNumber = pendingTicket.edition;

  // 3. Create approved ClaimedTicket
  const approvedTicket: ClaimedTicket = { ...pendingTicket, approvalStatus: "approved" };
  const newClaimedRef = await uploadToBytes(JSON.stringify(approvedTicket));
  console.log(`[approve] Approved ticket uploaded: ${newClaimedRef}, edition ${editionNumber}`);

  // Recover the raw wallet address for this pending claim: sealed on entries
  // written since 2026-08-01 (public feeds carry only HMAC handles); legacy
  // entries carried it bare in claimerKey; legacy tickets in ownerAddress.
  const rawClaimer =
    (entry.claimerSealed ? unsealClaimer(entry.claimerSealed, seriesId, entry.pendingId) : null) ??
    (!entry.claimerKey.startsWith("email:") && !entry.claimerKey.startsWith(WALLET_HANDLE_PREFIX)
      ? entry.claimerKey
      : null) ??
    approvedTicket.ownerAddress ?? null;
  if (entry.claimerSealed && !rawClaimer) {
    console.error(
      `[approve] claimerSealed failed to unseal for ${entry.pendingId} — gate binding and collection skipped`,
    );
  }

  // Identity-issued (claimed.v2) pending claim: the gate binding was deferred
  // until approval — bind now to the wallet the ticket was claimed with.
  if (approvedTicket.owner && rawClaimer) {
    const bound = bindTicket({
      seriesId,
      edition: editionNumber,
      eventId: approvedTicket.eventId,
      parentAddress: rawClaimer,
      podPubKey: approvedTicket.owner,
      route: "claim",
    });
    if (bound) {
      console.log(`[gate] bound ${seriesId}#${editionNumber} → ${rawClaimer} (claim, on approve)`);
    }
  }

  // 4. Update claims feed slot with approved ref. The page always exists (the
  //    claim reserved this slot), so a null read is a transient failure, never
  //    "absent" — starting from a blank page would erase every other claim on it.
  const { page: claimPage, slot: claimSlot } = editionToPageSlot(editionNumber);
  const claimsPageData = await readClaimsPageStrict(seriesId, claimPage);
  if (!claimsPageData) {
    // Absent, yet the claim reserved a slot on it — the feed is inconsistent.
    throw new Error("Could not read the claims feed — try again");
  }
  const claimsData = new Uint8Array(claimsPageData);
  claimsData.set(hexToBytes32(newClaimedRef), claimSlot * 32);
  await writeFeedPage(topicClaims(seriesId, claimPage), claimsData);

  // 5. Update claimers feed via the per-series queue. Awaited here (unlike
  //    the normal claim path) because approval is admin-triggered and rare —
  //    waiting a few seconds for the admin's dashboard to be consistent on
  //    return is preferable to a race window with concurrent approvals.
  const claimerAddress = entry.claimerKey; // already lowercase or "email:hash"
  await enqueueClaimersUpdate(seriesId, {
    edition: editionNumber,
    claimerAddress,
    claimedRef: newClaimedRef,
    claimedAt: approvedTicket.claimedAt,
    orderRef: entry.orderRef,
  });

  // 6. Update user collection if wallet claim (topic is keyed by the RAW
  //    address — the collection is the holder's own passport feed)
  if (rawClaimer) {
    addToUserCollection(rawClaimer as Hex0x, {
      seriesId,
      eventId: approvedTicket.eventId,
      edition: editionNumber,
      claimedRef: newClaimedRef,
      claimedAt: approvedTicket.claimedAt,
    }).catch((err) => console.error("[approve] Failed to update user collection:", err));
  }

  // 7. Mark entry as approved. Queued and re-read rather than written back from
  //    the step-1 snapshot: a claim-time append between the two would otherwise
  //    be erased by a whole-feed overwrite.
  const marked = await enqueuePendingOp(seriesId, () =>
    markPendingDecided(seriesId, pendingId, {
      status: "approved",
      decidedAt: new Date().toISOString(),
    }),
  );
  if (!marked) {
    // The ticket IS approved (claims feed written above) — only the audit entry
    // is missing, so don't fail the organiser's request.
    console.error(`[approve] Pending entry ${pendingId} vanished before the decision was recorded`);
  }
  console.log(`[approve] Pending claim ${pendingId} approved`);
}

export async function rejectPendingClaim(
  seriesId: string,
  pendingId: string,
  reason?: string,
): Promise<void> {
  // 1. Find the entry across the pending feed's pages
  const entry = await findPendingEntry(seriesId, pendingId);
  if (!entry) throw new Error("Pending claim not found");

  // 2. Download pending ticket to get edition number
  const ticketJson = await downloadFromBytes(entry.claimedRef);
  const pendingTicket = JSON.parse(ticketJson) as ClaimedTicket;
  const editionNumber = pendingTicket.edition;

  // 3. Clear the reserved slot in claims feed (makes it available again), but
  //    ONLY while it still holds this request's reserved ticket. If the slot has
  //    moved on — an approve that stamped the approved ref before its pending
  //    entry was marked decided, leaving a phantom "pending" record — zeroing it
  //    would revoke an issued ticket AND put the edition back up for sale.
  //    A page that won't read is likewise never rewritten: the lenient reader
  //    returns null for a transient error too, and writing a fresh zeroed page
  //    would erase every other claim on it.
  const { page: claimPage, slot: claimSlot } = editionToPageSlot(editionNumber);
  const claimsPageData = await readClaimsPageStrict(seriesId, claimPage);
  if (!claimsPageData) {
    // Absent, yet the claim reserved a slot on it — the feed is inconsistent.
    throw new Error("Could not read the claims feed — try again");
  }
  const slotRef = decode4096Claims(claimsPageData)[claimSlot];
  if (slotRef.toLowerCase() !== entry.claimedRef.toLowerCase()) {
    console.error(
      `[reject] slot ${seriesId}#${editionNumber} holds ${slotRef || "(empty)"}, not the reserved ${entry.claimedRef} — refusing to clear it`,
    );
    throw new Error("This request has already been decided");
  }
  const claimsData = new Uint8Array(claimsPageData);
  claimsData.set(new Uint8Array(32), claimSlot * 32); // zero out the slot
  await writeFeedPage(topicClaims(seriesId, claimPage), claimsData);
  console.log(`[reject] Cleared slot page ${claimPage}, slot ${claimSlot} for edition ${editionNumber}`);

  // 4. Mark entry as rejected (queued + re-read — see the approve path)
  const marked = await enqueuePendingOp(seriesId, () =>
    markPendingDecided(seriesId, pendingId, {
      status: "rejected",
      decidedAt: new Date().toISOString(),
      ...(reason ? { rejectionReason: reason } : {}),
    }),
  );
  if (!marked) {
    // The slot is already freed; only the audit entry is missing.
    console.error(`[reject] Pending entry ${pendingId} vanished before the decision was recorded`);
  }
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

/**
 * Per-series serialisation for claimers feed writes. Separate from the slot-
 * allocation queue in `routes/claims.ts` (`seriesQueues`) so the buyer-facing
 * path doesn't wait on the claimers read-modify-write — but two consecutive
 * claims still write claimers entries in order (preventing the read-stale,
 * overwrite-newer race that a naïve fire-and-forget would introduce).
 *
 * Trade-off: an entry whose write is still queued when the process crashes
 * is lost. The CLAIM itself remains durable (claims feed is the source of
 * truth — written synchronously inside the slot-allocation queue), and
 * dashboard data can be reconstructed from each `claimedRef`. Order data
 * attachment via `/api/stripe/save-order` already polls with backoff for
 * the entry to appear, so eventual consistency is the existing contract.
 */
const claimersTail = new Map<string, Promise<void>>();

/**
 * Serialise ANY claimers-feed mutation on the per-series chain. The paged
 * feed is a read-modify-write over multiple pages, so every writer — claim
 * appends AND save-order attaches — must go through here or interleaved
 * writers lose entries. (save-order previously rewrote the feed on the
 * slot-allocation queue, racing this chain; routing it here closes that.)
 */
function enqueueClaimersOp<T>(seriesId: string, op: () => Promise<T>): Promise<T> {
  const prev = claimersTail.get(seriesId) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined) // never let one failure poison the chain
    .then(op);
  // Tail keeps the chain alive but absorbs errors so subsequent .then()s run
  claimersTail.set(
    seriesId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/**
 * Serialise ANY pending-claims mutation on a per-series chain, for the same
 * reason as the claimers chain: the paged feed is a read-modify-write over
 * multiple pages. Here the interleaving writers sit on DIFFERENT outer queues —
 * claim-time appends run on the slot-allocation queue (`queueSeriesClaim`, and
 * not even that for the agent rail), organiser decisions on the approvals
 * queue — so this chain is the only thing that orders them against each other.
 *
 * Never awaited from inside `queueSeriesClaim`-held code that this chain in
 * turn waits on: pending ops only touch the pending feed, so no cycle exists.
 */
const pendingTail = new Map<string, Promise<void>>();

function enqueuePendingOp<T>(seriesId: string, op: () => Promise<T>): Promise<T> {
  const prev = pendingTail.get(seriesId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(op);
  pendingTail.set(
    seriesId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

function enqueueClaimersUpdate(seriesId: string, entry: ClaimerEntry): Promise<void> {
  return enqueueClaimersOp(seriesId, () => appendClaimerEntry(seriesId, entry));
}

/**
 * Attach an orderRef to every entry of `claimerKey` (raw lowercase address or
 * "email:{hash}") that lacks one. Returns the number of entries updated.
 */
export function enqueueClaimersAttach(
  seriesId: string,
  claimerKey: string,
  orderRef: string,
): Promise<number> {
  return enqueueClaimersOp(seriesId, () =>
    attachOrderRefToClaimers(
      seriesId,
      (c) => claimHandleMatches(c.claimerAddress, claimerKey, seriesId),
      orderRef,
    ),
  );
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
