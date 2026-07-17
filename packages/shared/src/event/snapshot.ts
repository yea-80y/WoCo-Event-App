import type { Hex0x, Hex64 } from "../types.js";
import type { EventTag, EventGeo } from "./types.js";

/**
 * Directory read model (#37). The event directory is a three-layer split:
 *   1. TRUTH   = the on-chain `Registered` log (per ticket-series). Append-only,
 *                dedup'd, free, rebuildable by anyone.
 *   2. CONTENT = Swarm (event SOC + series manifests), unchanged.
 *   3. SPEED   = ONE immutable snapshot blob + a platform-signed pointer feed.
 *                A list paint = 1 pointer-feed read + 1 blob fetch, regardless of
 *                event count. The blob is immutable ⇒ hard CDN caching.
 *
 * The snapshot is a CACHE, NOT TRUTH — rebuildable from the chain log + Swarm, or
 * (honestly) "from any surviving snapshot forward": the chain's `manifestRef` is a
 * keccak digest, not a Swarm address, so the `onChainEventId → content` mapping is
 * NOT in the chain log. Each snapshot therefore EMBEDS that mapping (the resolution
 * table) so snapshot + chain log is self-verifying and the next snapshot builds
 * from this one. Same "cache, not truth" pattern as the EAS likes projection.
 */

/**
 * One listing card. Fields are COPIED + NORMALISED from creator-signed event
 * content at build time (tags via normaliseTags). Everything a listing needs to
 * paint + filter client-side lives here, so discovery costs 0 extra requests.
 */
export interface SnapshotCard {
  /** WoCo eventId (server-minted). One card per event, even for multi-series events. */
  eventId: string;
  title: string;
  tagline?: string;
  imageHash: Hex64;
  startDate: string;
  endDate?: string;
  location: string;
  creatorAddress: Hex0x;
  /** Phase B discovery carrier — lets a reader resolve the event SOC with no registry. */
  creatorFeedSigner?: Hex0x;
  seriesCount: number;
  totalTickets: number;
  createdAt: string;
  /** Normalised, controlled-vocab facet tags for client-side filtering. */
  tags: EventTag[];
  /** Normalised structured location for client-side filtering (country/coords)
   *  + display (city/venue). Absent when the event carries no usable geo. */
  geo?: EventGeo;
  /** Federated (self-hosted) organisers only: base URL to fetch event data / route
   *  claims to. Absent for WoCo-hosted events. */
  apiUrl?: string;
}

/**
 * onChainEventId → content resolution, embedded in every snapshot. One entry PER
 * SERIES registration (a 3-tier event contributes 3 entries sharing a wocoEventId),
 * because the enumeration unit is a `Registered` log line, not an event. This is the
 * chain→content bridge the `Registered` log cannot provide on its own.
 */
export interface SnapshotResolutionEntry {
  /** 0x bytes32 event id from the WoCoEventV2 `Registered` log. */
  onChainEventId: string;
  /** WoCo eventId the on-chain registration belongs to. */
  wocoEventId: string;
  /** Series that was registered. */
  seriesId: string;
  /** Discovery carrier for resolving the event SOC (absent for legacy events). */
  creatorFeedSigner?: Hex0x;
}

/** The immutable snapshot blob — the read model. Uploaded to Swarm bytes; the
 *  pointer feed names its ref. */
export interface EventsSnapshot {
  v: 1;
  /** ISO build time. */
  builtAt: string;
  /** Count of registration entries covered (= resolution.length). A coverage/
   *  telemetry counter, NOT a chain-log cursor — a future rebuild-from-chain must
   *  not treat it as an `organiserNonce` to resume from. */
  registrationCount: number;
  /** Listing cards, newest-first (createdAt desc). */
  cards: SnapshotCard[];
  /** onChainEventId → content mapping (see SnapshotResolutionEntry). */
  resolution: SnapshotResolutionEntry[];
}

/**
 * Payload of the platform-signed pointer feed at `woco/event/directory/snapshot`.
 * The ONLY centralised piece of the directory — deliberately swappable (multi-writer
 * Swarm chunk updates / community moderation later) without touching truth or content.
 */
export interface EventsSnapshotPointer {
  v: 1;
  /** Swarm ref (bytes) to the current EventsSnapshot blob. */
  snapshotRef: Hex64;
  builtAt: string;
  /** Card count — cheap telemetry / sanity signal. */
  count: number;
}
