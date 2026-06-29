/**
 * On-chain event-id resolver — CHAIN is the source of truth; this holds only an
 * in-memory cache (NO persistent file).
 *
 * `WoCoEventV2.registerEvent` sets `eventId = keccak256(abi.encode(msg.sender,
 * organiserNonce[msg.sender]++))` — a function of the SPONSOR WALLET's nonce, not
 * recomputable from the manifest. The money path detects a v2 (on-chain) series via
 * `swarmManifestRef && onChainEventId`, but reading `onChainEventId` only from the
 * organiser's client-signed event SOC is fragile (the browser re-sign silently fails),
 * which made every paid purchase fall to the dead v1 path → "Series not found" → refund.
 *
 * So the server resolves `onChainEventId` from the CHAIN and caches it in memory:
 *   - HOT PATH: populated at registration time (`recordOnChainEventId`, called from
 *     confirmSeriesOnChain) → zero chain calls during normal create→buy.
 *   - COLD MISS (e.g. after a restart): rebuild from chain by enumerating the sponsor's
 *     registrations (`organiserNonce` + the deterministic eventId derivation + `getEvent`),
 *     matching each on-chain `manifestRef` to the series' `manifestRef`. Throttled + cached.
 *
 * No `.data` file: the cache is a pure, rebuildable projection of the chain (same
 * philosophy as the likes projection). The server owns no authoritative state here and
 * never signs the user's event feed — it only remembers an id the contract assigned.
 */

import { AbiCoder, keccak256 } from "ethers";
import type { EventFeed } from "@woco/shared";
import { getActiveChainId, getDeployedContract, getOnChainEvent } from "../chain/event-contract.js";
import { getSponsorAddress } from "../chain/sponsor-wallet.js";

/** `${eventId}|${seriesId}` → onChainEventId — the fast path, filled at registration. */
const byEventSeries = new Map<string, string>();
/** lowercased on-chain manifestRef → onChainEventId — the chain projection (rebuilt). */
const byManifestRef = new Map<string, string>();

let lastReconcileAt = 0;
let reconcileInFlight: Promise<void> | null = null;
const RECONCILE_THROTTLE_MS = 15_000;

function key(eventId: string, seriesId: string): string {
  return `${eventId}|${seriesId}`;
}

/** Record the id the contract assigned to a series (called right after the tx). */
export function recordOnChainEventId(eventId: string, seriesId: string, onChainEventId: string): void {
  byEventSeries.set(key(eventId, seriesId), onChainEventId);
}

/** Deterministic eventId for the sponsor's nth registration — mirrors the contract. */
function deriveEventId(sponsor: string, nonce: number): string {
  return keccak256(AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [sponsor, nonce]));
}

/**
 * Rebuild `byManifestRef` from the chain by walking the sponsor's registrations.
 * Bounded by `organiserNonce` (exact count), batched, throttled. One-time after a
 * restart in practice — the hot path is filled by recordOnChainEventId.
 */
async function reconcileFromChain(): Promise<void> {
  if (reconcileInFlight) return reconcileInFlight;
  if (Date.now() - lastReconcileAt < RECONCILE_THROTTLE_MS) return;
  reconcileInFlight = (async () => {
    try {
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
        const events = await Promise.all(ids.map((id) => getOnChainEvent(id, chainId).catch(() => null)));
        for (let i = 0; i < ids.length; i++) {
          const ev = events[i];
          if (ev?.manifestRef) byManifestRef.set(ev.manifestRef.toLowerCase(), ids[i]);
        }
      }
      console.log(`[onchain-resolver] reconciled ${byManifestRef.size} on-chain events from chain`);
    } catch (err) {
      console.error("[onchain-resolver] reconcile failed:", err);
    } finally {
      lastReconcileAt = Date.now();
      reconcileInFlight = null;
    }
  })();
  return reconcileInFlight;
}

/**
 * Fill each series' `onChainEventId` from the chain projection when the signed feed
 * lacks it. Only fills when ABSENT — never overrides a value already in the feed.
 * Hot path (registration-cached) does NO chain work; a cold miss triggers ONE throttled
 * reconcile. Mutates and returns `feed`.
 */
export async function applyOnChainEventIds(feed: EventFeed): Promise<EventFeed> {
  const missing = feed.series.filter((s) => !s.onChainEventId && s.manifestRef);
  if (missing.length === 0) return feed;

  // Fast path: per-(event,series) cache filled at registration.
  for (const s of missing) {
    const cached = byEventSeries.get(key(feed.eventId, s.seriesId));
    if (cached) s.onChainEventId = cached as typeof s.onChainEventId;
  }
  let stillMissing = missing.filter((s) => !s.onChainEventId);
  if (stillMissing.length === 0) return feed;

  // Cold path: rebuild from chain, then match by manifestRef.
  const allKnown = stillMissing.every((s) => byManifestRef.has(s.manifestRef!.toLowerCase()));
  if (!allKnown) await reconcileFromChain();

  for (const s of stillMissing) {
    const id = byManifestRef.get(s.manifestRef!.toLowerCase());
    if (id) {
      s.onChainEventId = id as typeof s.onChainEventId;
      byEventSeries.set(key(feed.eventId, s.seriesId), id); // promote to fast path
    }
  }
  return feed;
}
