/**
 * On-chain event-id resolver. The CHAIN is the source of truth; this is a
 * rebuildable CACHE (not authoritative state) with three speed tiers:
 *
 *   1. in-memory map  — hot path, filled at registration → zero I/O on create→buy.
 *   2. .data cache    — write-through JSON, loaded on startup so a RESTART/DEPLOY
 *                       does NOT pay a chain rebuild. Pure cache: deletable, always
 *                       reconstructable from the chain.
 *   3. chain reconcile — slower fallback for a truly-cold miss (entry in neither
 *                       tier), then persisted so it's paid at most once.
 *
 * Why this exists: the money path detects a v2 (on-chain) series via
 * `swarmManifestRef && onChainEventId`. `WoCoEventV2.registerEvent` sets
 * `eventId = keccak256(abi.encode(msg.sender, organiserNonce[msg.sender]++))` — a
 * function of the SPONSOR WALLET's nonce, not recomputable from the manifest. Reading
 * `onChainEventId` only from the organiser's client-signed event SOC is fragile (the
 * browser re-sign silently fails), which made every paid purchase fall to the dead v1
 * path → "Series not found" → refund. So the server resolves it from the chain and
 * caches it. The server owns no truth here and never signs the user's feed — same
 * "cache, not truth" philosophy as the likes projection.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AbiCoder, keccak256 } from "ethers";
import type { EventFeed } from "@woco/shared";
import { writeJsonAtomic } from "../marketing/persist.js";
import { getActiveChainId, getDeployedContract, getOnChainEvent } from "../chain/event-contract.js";
import { getSponsorAddress } from "../chain/sponsor-wallet.js";

const DATA_DIR = join(process.cwd(), ".data");
const CACHE_FILE = join(DATA_DIR, "onchain-events.json");

/** `${eventId}|${seriesId}` → onChainEventId — the persisted hot-path cache. */
const byEventSeries = new Map<string, string>();
/** lowercased on-chain manifestRef → onChainEventId — transient chain projection. */
const byManifestRef = new Map<string, string>();

let loaded = false;
let dirty = false;
let lastReconcileAt = 0;
let reconcileInFlight: Promise<void> | null = null;
const RECONCILE_THROTTLE_MS = 15_000;

function key(eventId: string, seriesId: string): string {
  return `${eventId}|${seriesId}`;
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const obj = JSON.parse(readFileSync(CACHE_FILE, "utf-8")) as Record<string, string>;
    for (const [k, v] of Object.entries(obj)) byEventSeries.set(k, v);
    console.log(`[onchain-cache] Loaded ${byEventSeries.size} on-chain event ids from cache`);
  } catch {
    // No cache yet — it rebuilds from chain on demand.
  }
}

function persist(): void {
  if (!dirty) return;
  // Stays dirty on failure so the next record retries the whole map.
  if (writeJsonAtomic(CACHE_FILE, Object.fromEntries(byEventSeries), "onchain-cache")) {
    dirty = false;
  }
}

/** Record the id the contract assigned to a series (called right after the tx). */
export function recordOnChainEventId(eventId: string, seriesId: string, onChainEventId: string): void {
  ensureLoaded();
  const k = key(eventId, seriesId);
  if (byEventSeries.get(k) === onChainEventId) return;
  byEventSeries.set(k, onChainEventId);
  dirty = true;
  persist();
}

/**
 * Zero-I/O lookup of an already-recorded registration (tiers 1+2 ONLY — never
 * walks the chain). This is the exactly-once guard for `register-on-chain`:
 * `recordOnChainEventId` runs before the feed write in `confirmSeriesOnChain`, so
 * a registration whose tx landed but whose feed update then failed is still found
 * here — including after a restart, since the map is `.data`-backed. Reading the
 * feed alone is NOT sufficient: two of the route's three resolution tiers
 * (`peekEventCache`, `readEventFeedSoc`) hand back a feed with no on-chain id
 * merged in, and the contract does not dedupe (`registerEvent` keys the id off a
 * sponsor-nonce counter, not the manifest), so a missed guard mints a SECOND
 * on-chain event. `applyOnChainEventIds` cannot serve as the guard: on a
 * genuinely-first registration its tier-3 miss triggers a full chain walk, which
 * would land on the publish hot path.
 */
export function lookupOnChainEventId(eventId: string, seriesId: string): string | null {
  ensureLoaded();
  return byEventSeries.get(key(eventId, seriesId)) ?? null;
}

/**
 * Every known registration as a chain→content resolution entry (inverts the
 * persisted `${eventId}|${seriesId}` → onChainEventId map). The directory-snapshot
 * full-rebuild uses this: the platform sponsor registers ALL events, so this map is
 * a complete enumerator of onChainEventId → {wocoEventId, seriesId}. `creatorFeedSigner`
 * is filled by the builder from the resolved feed (this cache doesn't carry it).
 */
export function getAllResolutionEntries(): Array<{ onChainEventId: string; wocoEventId: string; seriesId: string }> {
  ensureLoaded();
  const out: Array<{ onChainEventId: string; wocoEventId: string; seriesId: string }> = [];
  for (const [k, onChainEventId] of byEventSeries) {
    const sep = k.indexOf("|");
    if (sep === -1) continue;
    out.push({ onChainEventId, wocoEventId: k.slice(0, sep), seriesId: k.slice(sep + 1) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pending-registration markers
// ---------------------------------------------------------------------------

/**
 * A registerEvent tx in its broadcast window, journalled in TWO phases (#318):
 *
 *  1. INTENT — written with the reserved nonce BEFORE the tx is handed to the
 *     node (`txHash` absent). This write is load-bearing: if it cannot reach
 *     disk the broadcast is REFUSED, because a disk that fails writes is
 *     exactly the disk that loses the marker when the process dies with it —
 *     and an unjournalled broadcast is what lets a restart mint a second
 *     on-chain event for the same series.
 *  2. UPGRADE — the same entry gains `txHash` the moment the tx is broadcast
 *     (before `tx.wait`), so a crash, timeout or organiser retry in the
 *     confirmation window can RESOLVE that tx instead of sending another.
 *
 * `nonce` is what makes both shapes decidable after a crash: a hash-carrying
 * marker resolves by receipt; a hash-less one resolves by whether the nonce
 * slot was consumed and whether the manifest ever registered
 * (lib/event/registration-intent.ts).
 */
export interface PendingRegistration {
  /** Absent while only the INTENT is journalled — nonce reserved, broadcast unproven. */
  txHash?: string;
  nonce: number;
  chainId: number;
  /** ISO timestamp of the journal write — diagnostics only. */
  at: string;
}

const PENDING_FILE = join(DATA_DIR, "pending-registrations.json");

/** `${eventId}|${seriesId}` → the in-flight tx. */
const pending = new Map<string, PendingRegistration>();
let pendingLoaded = false;

function ensurePendingLoaded(): void {
  if (pendingLoaded) return;
  pendingLoaded = true;
  try {
    const obj = JSON.parse(readFileSync(PENDING_FILE, "utf-8")) as Record<string, PendingRegistration>;
    for (const [k, v] of Object.entries(obj)) pending.set(k, v);
    if (pending.size > 0) {
      console.log(`[onchain-cache] Loaded ${pending.size} pending registration(s)`);
    }
  } catch {
    // No pending markers — the normal case.
  }
}

function persistPending(): boolean {
  return writeJsonAtomic(PENDING_FILE, Object.fromEntries(pending), "onchain-pending");
}

/**
 * Journal the INTENT to broadcast at `nonce` — phase 1 of the #318 contract.
 * THROWS when the journal cannot be written, and the caller MUST treat that as
 * "do not broadcast": the write is the only thing standing between a crash and
 * an untraceable in-flight registerEvent. `writeJsonAtomic` is atomic, so a
 * failed write leaves the file without the entry — the in-memory copy is
 * removed to match before throwing.
 */
export function recordRegistrationIntent(
  eventId: string,
  seriesId: string,
  intent: { nonce: number; chainId: number },
): void {
  ensurePendingLoaded();
  const k = key(eventId, seriesId);
  pending.set(k, { ...intent, at: new Date().toISOString() });
  if (!persistPending()) {
    pending.delete(k);
    throw new Error("registration journal unwritable — refusing to broadcast registerEvent");
  }
}

/**
 * Upgrade the marker with the broadcast tx's hash — phase 2. MUST be called
 * before the tx can mine. A persist failure here is loud but NOT fatal: the tx
 * is already out, the in-memory marker serves this process, and the durable
 * intent from phase 1 still covers a crash (the hash-less marker resolves via
 * registration-intent.ts).
 */
export function recordPendingRegistration(
  eventId: string,
  seriesId: string,
  tx: { txHash: string; nonce: number; chainId: number },
): void {
  ensurePendingLoaded();
  pending.set(key(eventId, seriesId), { ...tx, at: new Date().toISOString() });
  if (!persistPending()) {
    console.error(
      `[onchain-cache] pending-registration upgrade for ${eventId}/${seriesId} not journalled — ` +
        "in-memory only; a crash now leaves the intent marker, which the intent resolver handles",
    );
  }
}

export function lookupPendingRegistration(eventId: string, seriesId: string): PendingRegistration | null {
  ensurePendingLoaded();
  return pending.get(key(eventId, seriesId)) ?? null;
}

/** Drop the marker once the tx is resolved (confirmed, reverted, or replaced). */
export function clearPendingRegistration(eventId: string, seriesId: string): void {
  ensurePendingLoaded();
  if (!pending.delete(key(eventId, seriesId))) return;
  if (!persistPending()) {
    // Non-fatal: a stale marker on disk resolves harmlessly on the next boot
    // (step 2 of register-once finds the recorded id first).
    console.warn(`[onchain-cache] could not persist marker clear for ${eventId}/${seriesId}`);
  }
}

/** Deterministic eventId for the sponsor's nth registration — mirrors the contract. */
function deriveEventId(sponsor: string, nonce: number): string {
  return keccak256(AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [sponsor, nonce]));
}

/**
 * Walk EVERY sponsor registration on chain into `byManifestRef`. Bounded by
 * `organiserNonce` (exact count), batched. THROWS on any failure — a caller
 * that needs a definitive answer (the #318 intent resolver) must be able to
 * tell "walked and absent" from "could not walk"; only the lenient reconcile
 * wrapper below is allowed to swallow.
 */
async function walkChainRegistrations(): Promise<void> {
  const chainId = getActiveChainId();
  const deployed = getDeployedContract(chainId);
  if (!deployed || deployed.version !== "v2") return; // resolver only applies to V2
  const sponsor = getSponsorAddress();
  const { getOrganiserNonce } = await import("../chain/event-contract.js");
  const count = Number(await getOrganiserNonce(sponsor, chainId));
  const BATCH = 25;
  for (let start = 0; start < count; start += BATCH) {
    const ids = Array.from(
      { length: Math.min(BATCH, count - start) },
      (_, i) => deriveEventId(sponsor, start + i),
    );
    // No per-id catch: a dropped read here must fail the WALK, not read as an
    // absent registration (the intent resolver re-broadcasts on "absent").
    const events = await Promise.all(ids.map((id) => getOnChainEvent(id, chainId)));
    for (let i = 0; i < ids.length; i++) {
      const ev = events[i];
      if (ev?.manifestRef) byManifestRef.set(ev.manifestRef.toLowerCase(), ids[i]);
    }
  }
  console.log(`[onchain-cache] reconciled ${byManifestRef.size} on-chain events from chain`);
}

/**
 * Rebuild `byManifestRef` from the chain — throttled and best-effort. The
 * fallback tier for feed healing: the hot path + .data cache mean this rarely
 * runs (cold/uncached series only).
 */
async function reconcileFromChain(): Promise<void> {
  if (reconcileInFlight) return reconcileInFlight;
  if (Date.now() - lastReconcileAt < RECONCILE_THROTTLE_MS) return;
  reconcileInFlight = (async () => {
    try {
      await walkChainRegistrations();
    } catch (err) {
      console.error("[onchain-cache] reconcile failed:", err);
    } finally {
      lastReconcileAt = Date.now();
      reconcileInFlight = null;
    }
  })();
  return reconcileInFlight;
}

/**
 * Definitive "did a registration for this manifest ever land?" — the positive
 * arm of the #318 intent resolver. A cache hit answers immediately; otherwise
 * the FULL chain walk runs (no throttle, no swallowing) so that `null` means
 * "walked the sponsor's every registration and it is not there", never "the
 * walk didn't happen". Throws when the chain cannot be walked.
 */
export async function findOnChainEventIdByManifestRef(manifestRef: string): Promise<string | null> {
  const lc = manifestRef.toLowerCase();
  const hit = byManifestRef.get(lc);
  if (hit) return hit;
  await walkChainRegistrations();
  return byManifestRef.get(lc) ?? null;
}

/**
 * Fill each series' `onChainEventId` from cache/chain when the signed feed lacks it.
 * Only fills when ABSENT — never overrides a value already in the feed. Hot path
 * (cache hit) does NO chain work; a cold miss triggers ONE throttled reconcile whose
 * result is persisted. Mutates and returns `feed`.
 */
export async function applyOnChainEventIds(feed: EventFeed): Promise<EventFeed> {
  const missing = feed.series.filter((s) => !s.onChainEventId && s.manifestRef);
  if (missing.length === 0) return feed;
  ensureLoaded();

  // Tier 1/2: per-(event,series) cache (in-memory, backed by .data).
  for (const s of missing) {
    const cached = byEventSeries.get(key(feed.eventId, s.seriesId));
    if (cached) s.onChainEventId = cached as typeof s.onChainEventId;
  }
  const stillMissing = missing.filter((s) => !s.onChainEventId);
  if (stillMissing.length === 0) return feed;

  // Tier 3: rebuild from chain, then match by manifestRef + promote to the cache.
  const allKnown = stillMissing.every((s) => byManifestRef.has(s.manifestRef!.toLowerCase()));
  if (!allKnown) await reconcileFromChain();

  for (const s of stillMissing) {
    const id = byManifestRef.get(s.manifestRef!.toLowerCase());
    if (id) {
      s.onChainEventId = id as typeof s.onChainEventId;
      byEventSeries.set(key(feed.eventId, s.seriesId), id);
      dirty = true;
    }
  }
  persist();
  return feed;
}
