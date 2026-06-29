/**
 * On-chain event-id registry — the server's record of its OWN sponsored
 * registerEvent receipts.
 *
 * `WoCoEventV2.registerEvent` derives `eventId = keccak256(abi.encode(msg.sender,
 * organiserNonce[msg.sender]++))` — a function of the SPONSOR WALLET's nonce, so it
 * is NOT recomputable from the manifest. The server (its sponsor wallet) is the
 * registrant and parses `onChainEventId` from the Registered event. We persist that
 * receipt here, keyed by `eventId|seriesId`, so the money path can detect a v2
 * (on-chain) series WITHOUT depending on the organiser's client SOC being re-signed
 * with `onChainEventId` (a fragile client step). The chain stays authoritative —
 * this is just the server remembering the id the contract handed it, the same
 * coordination pattern as the tx-hash registry. NOT user content: it never makes
 * the server an owner of the client-signed event feed.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { EventFeed } from "@woco/shared";

const DATA_DIR = join(process.cwd(), ".data");
const REGISTRY_FILE = join(DATA_DIR, "onchain-events.json");

/** key `${eventId}|${seriesId}` → onChainEventId (0x-prefixed bytes32). */
const map = new Map<string, string>();
let loaded = false;

function key(eventId: string, seriesId: string): string {
  return `${eventId}|${seriesId}`;
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = readFileSync(REGISTRY_FILE, "utf-8");
    const obj = JSON.parse(raw) as Record<string, string>;
    for (const [k, v] of Object.entries(obj)) map.set(k, v);
    console.log(`[onchain-registry] Loaded ${map.size} on-chain event ids from disk`);
  } catch {
    // File doesn't exist yet — fine.
  }
}

function persistToDisk(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(REGISTRY_FILE, JSON.stringify(Object.fromEntries(map)), "utf-8");
  } catch (err) {
    console.error("[onchain-registry] Failed to persist to disk:", err);
  }
}

/** Record the on-chain event id the contract assigned to a series. Idempotent. */
export function recordOnChainEventId(eventId: string, seriesId: string, onChainEventId: string): void {
  ensureLoaded();
  const k = key(eventId, seriesId);
  if (map.get(k) === onChainEventId) return;
  map.set(k, onChainEventId);
  persistToDisk();
}

/** Look up a recorded on-chain event id, or undefined. */
export function getOnChainEventId(eventId: string, seriesId: string): string | undefined {
  ensureLoaded();
  return map.get(key(eventId, seriesId));
}

/**
 * Patch a freshly-read event feed with any recorded on-chain event ids the feed
 * itself is missing. The server's recorded receipt is authoritative (it ran the
 * tx), so it fills a series whose SOC was never re-signed with `onChainEventId`.
 * Only fills when ABSENT — never overrides a value already in the signed feed.
 * Mutates and returns `feed`.
 */
export function applyOnChainEventIds(feed: EventFeed): EventFeed {
  ensureLoaded();
  if (map.size === 0) return feed;
  for (const s of feed.series) {
    if (s.onChainEventId) continue;
    const id = map.get(key(feed.eventId, s.seriesId));
    if (id) s.onChainEventId = id as typeof s.onChainEventId;
  }
  return feed;
}
