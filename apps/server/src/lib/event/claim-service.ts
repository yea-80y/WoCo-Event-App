import { createHmac } from "node:crypto";
import type {
  Hex0x,
  ClaimedTicket,
  CollectionEntry,
  UserCollection,
} from "@woco/shared";
import { downloadFromBytes } from "../swarm/bytes.js";
import {
  readFeedPage,
  writeFeedPage,
  encodeJsonFeed,
  decodeJsonFeed,
} from "../swarm/feeds.js";
import { topicUserCollection } from "../swarm/topics.js";

// The v1 claim rail (editions/claims/claimers/pending-claims Swarm feeds,
// claimTicket, getClaimStatus, the approval flow) was deleted 2026-08-08 —
// the WoCoEventV2 contract is the only ticket ledger. What remains here is
// the identity hashing shared across the email subsystem and the passport
// collection feed, which is user-owned display state, not claim truth.

// ---------------------------------------------------------------------------
// Claim identifier (wallet or email)
// ---------------------------------------------------------------------------

export type ClaimIdentifier =
  | {
      type: "wallet";
      address: Hex0x;
      /** Optional secondary email identifier — set when a logged-in wallet user
       *  pays by Stripe with a customer email. Recorded for consent capture so
       *  the buyer's marketing answer keys on the email they actually used. */
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
