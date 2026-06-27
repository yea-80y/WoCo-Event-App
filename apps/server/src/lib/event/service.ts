import type {
  Hex64, Hex0x, EventFeed, EventDirectoryEntry, SeriesSummary,
  OrderField, ClaimMode, SeriesManifestBlob,
  SignedManifestV1, PodV2Body,
} from "@woco/shared";
import { verifySignedManifest, buildPodTree, manifestDigest, bytesToHex0x, eventContentTopic } from "@woco/shared";
import { uploadToBytes } from "../swarm/bytes.js";
import { batchForDeploy } from "../etherna/batch-router.js";
import { readContentFeedJson } from "../swarm/soc-upload.js";
import { whitelistHashes } from "../swarm/whitelist.js";
import { getActiveChainId } from "../chain/event-contract.js";
import { validatePodGate } from "../pod/gate-check.js";
import { upsertCreatorPod } from "../pod/directory.js";
import {
  readFeedPage,
  readFeedPageStrict,
  readFeedPageWithRetry,
  writeFeedPage,
  encodeJsonFeed,
  decodeJsonFeed,
} from "../swarm/feeds.js";
import {
  topicEventDirectory,
  topicCreatorDirectory,
  topicEvent,
} from "../swarm/topics.js";

// ---------------------------------------------------------------------------
// Create event (v2 — manifest-based, on-chain)
// ---------------------------------------------------------------------------

export interface CreateProgress {
  type: "progress";
  phase: string;
  current: number;
  total: number;
  message: string;
}

export async function createEventV2(opts: {
  eventId: string;
  title: string;
  tagline?: string;
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
    signedManifest: SignedManifestV1;
    podBodies: PodV2Body[];
    approvalRequired?: boolean;
    wave?: string;
    saleStart?: string;
    saleEnd?: string;
    payment?: import("@woco/shared").PaymentConfig;
    gate?: import("@woco/shared").PodGate | import("@woco/shared").PodGateGroup;
  }>;
  encryptionKey?: string;
  orderFields?: OrderField[];
  claimMode?: ClaimMode;
  skipAutoList?: boolean;
  /** Phase B: organiser's content-feed-signer address (lowercased 0x). Present ⇒
   *  the detail feed is a client-signed SOC (this fn skips the platform write and
   *  returns the assembled feed for the client to sign); stamped into the directory
   *  entries as the discovery carrier. Absent ⇒ legacy platform-signed write. */
  creatorFeedSigner?: Hex0x;
  /** Builder's selected gateway (the builder IS the event creator). Etherna ⇒
   *  event content (image, pods, manifests) is stamped on the organiser's Etherna
   *  batch; otherwise the WoCo bee. The global directory always stays on WoCo. */
  gatewayUrl?: string;
  onProgress?: (p: CreateProgress) => void;
}): Promise<EventFeed> {
  const {
    eventId, title, tagline, description, startDate, endDate, location,
    creatorAddress, creatorPodKey, imageData, series,
    encryptionKey, orderFields, claimMode, skipAutoList, creatorFeedSigner, gatewayUrl, onProgress,
  } = opts;

  // Route all event-content uploads to the selected gateway's batch (events never
  // trigger a batch purchase — batchForDeploy falls back to the platform Etherna
  // batch when the organiser has none).
  const batchSelection = batchForDeploy({
    ownerAddress: creatorAddress,
    gatewayUrl: gatewayUrl ?? "",
    deployType: "event",
  });

  const emit = (phase: string, current: number, total: number, message: string) =>
    onProgress?.({ type: "progress", phase, current, total, message });

  const tStart = Date.now();
  const createdAt = new Date().toISOString();
  const totalPods = series.reduce((n, s) => n + s.totalSupply, 0);

  // ── Validate all manifests before touching Swarm ─────────────────────
  for (const s of series) {
    if (s.podBodies.length !== s.totalSupply) {
      throw new Error(`Series ${s.seriesId}: expected ${s.totalSupply} pod bodies, got ${s.podBodies.length}`);
    }
    if (!verifySignedManifest(s.signedManifest)) {
      throw new Error(`Series ${s.seriesId}: manifest signature invalid`);
    }
    const { root } = buildPodTree(s.podBodies);
    if (root.toLowerCase() !== s.signedManifest.body.metadataRoot.toLowerCase()) {
      throw new Error(`Series ${s.seriesId}: Merkle root mismatch — pod bodies don't match manifest`);
    }
    // Chain-validate any POD gate at the write boundary so enforcement can trust
    // the stored gate (manifestRef↔eventId binding verified on-chain). See
    // validatePodGate — closes the silent-wrong-POD gap.
    if (s.gate) {
      const v = await validatePodGate(s.gate);
      if (!v.ok) throw new Error(`Series ${s.seriesId}: invalid POD gate — ${v.error}`);
    }
  }

  // ── Phase 1: Upload image (start immediately) ─────────────────────────
  emit("image", 0, 1, "Uploading event image...");
  const imagePromise = uploadToBytes(imageData, batchSelection);
  // Real rejection is re-thrown at the awaited consumer below; the noop
  // catch only prevents Node from crashing as unhandledRejection if an
  // earlier phase throws before we reach the await.
  imagePromise.catch(() => {});

  // ── Phase 2: Upload pod bodies for all series ─────────────────────────
  emit("pods", 0, totalPods, "Uploading pod bodies...");
  let podsUploaded = 0;
  const BATCH = 40;

  const podRefsBySeries = new Map<string, Hex64[]>();
  for (const s of series) {
    const refs: Hex64[] = [];
    for (let i = 0; i < s.podBodies.length; i += BATCH) {
      const batch = s.podBodies.slice(i, i + BATCH);
      const batchRefs = await Promise.all(batch.map((p) => uploadToBytes(JSON.stringify(p), batchSelection)));
      refs.push(...batchRefs);
      podsUploaded += batchRefs.length;
      emit("pods", podsUploaded, totalPods, `Uploading pods: ${podsUploaded}/${totalPods}`);
    }
    podRefsBySeries.set(s.seriesId, refs);
  }

  const imageHash = await imagePromise;
  emit("image", 1, 1, "Image uploaded");
  void whitelistHashes([imageHash]).catch((err) =>
    console.warn("[event] image whitelist failed (non-critical):", err),
  );

  // ── Phase 3: Upload SeriesManifestBlob per series ─────────────────────
  emit("manifests", 0, series.length, "Uploading manifests...");

  const seriesSummaries: SeriesSummary[] = await Promise.all(
    series.map(async (s, i) => {
      const podRefs = podRefsBySeries.get(s.seriesId)!;
      const digestBytes = manifestDigest(s.signedManifest.body);
      const manifestDigestHex = bytesToHex0x(digestBytes);

      const blob: SeriesManifestBlob = {
        v: 2,
        signedManifest: s.signedManifest,
        podRefs,
        manifestDigestHex,
      };
      const swarmManifestRef = await uploadToBytes(JSON.stringify(blob), batchSelection);
      emit("manifests", i + 1, series.length, `Manifests: ${i + 1}/${series.length}`);

      return {
        seriesId: s.seriesId,
        name: s.name,
        description: s.description,
        totalSupply: s.totalSupply,
        price: s.payment ? parseFloat(s.payment.price) : 0,
        swarmManifestRef,
        manifestRef: manifestDigestHex,
        ...(s.approvalRequired ? { approvalRequired: true } : {}),
        ...(s.wave ? { wave: s.wave } : {}),
        ...(s.saleStart ? { saleStart: s.saleStart } : {}),
        ...(s.saleEnd ? { saleEnd: s.saleEnd } : {}),
        ...(s.payment ? { payment: s.payment } : {}),
        ...(s.gate ? { gate: s.gate } : {}),
      } as SeriesSummary;
    }),
  );

  // ── Phase 4: Write event feed ─────────────────────────────────────────
  const eventFeed: EventFeed = {
    v: 1,
    eventId,
    title,
    ...(tagline ? { tagline } : {}),
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
    ...(creatorFeedSigner ? { creatorFeedSigner } : {}),
  };

  // Phase B: when the organiser owns a content-feed signer, the detail feed is a
  // client-signed SOC. The server has no key to sign it — it returns the assembled
  // feed (the route streams it in `done`) for the client to sign + upload via
  // /api/swarm/soc. Legacy (no signer): platform-signed write as before.
  if (!creatorFeedSigner) {
    emit("finalize", 0, 1, "Writing event feed...");
    await writeFeedPage(topicEvent(eventId), encodeJsonFeed(eventFeed), { fresh: true });
  } else {
    emit("finalize", 0, 1, "Preparing event feed for signing...");
  }
  invalidateEventCache(eventId);

  // ── Update directories (fire-and-forget) ─────────────────────────────
  // creatorFeedSigner is the discovery carrier — stamped into BOTH the global and
  // creator directory entries (platform-signed) so a reader resolves the event SOC
  // with no global registry.
  const totalTickets = series.reduce((n, s) => n + s.totalSupply, 0);
  addToEventDirectory(
    { eventId, title, ...(tagline ? { tagline } : {}), imageHash, startDate, endDate, location, creatorAddress, seriesCount: series.length, totalTickets, createdAt, ...(creatorFeedSigner ? { creatorFeedSigner } : {}) },
    { skipPublicDirectory: !!skipAutoList },
  ).catch((err) => console.error("[event] Directory update failed (non-critical):", err));

  emit("finalize", 1, 1, "Event published!");
  console.log(`[event] v2 event created — ${eventId} (${series.length} series, ${totalPods} pods, ${Date.now() - tStart}ms)`);
  return eventFeed;
}

// ---------------------------------------------------------------------------
// Update on-chain registration for a series (called after registerEvent tx)
// ---------------------------------------------------------------------------

export async function confirmSeriesOnChain(
  eventId: string,
  seriesId: string,
  onChainEventId: string,
  signerHint?: string,
): Promise<EventFeed> {
  // Same as the register read (Fix B): a freshly client-signed event has no platform
  // feed and its directory carrier hasn't propagated, so getEvent() would stall on the
  // whole-directory lookup and then return null → throw. Read the client SOC directly
  // when the creator hands us their signer; fall back to the legacy read otherwise.
  let feed = signerHint ? await readEventFeedSoc(eventId, signerHint) : null;
  if (!feed) feed = await getEvent(eventId);
  if (!feed) throw new Error("Event not found");

  const updated: EventFeed = {
    ...feed,
    series: feed.series.map((s) =>
      s.seriesId === seriesId ? { ...s, onChainEventId } : s,
    ),
  };

  // Phase B: the event detail feed is the USER's client-signed SOC — the server has
  // no key for it and must never write it. The client merges onChainEventId into the
  // feed it owns and re-signs the SOC (see PublishButton). Legacy events: platform write.
  if (!feed.creatorFeedSigner) {
    await writeFeedPage(topicEvent(eventId), encodeJsonFeed(updated));
  }
  invalidateEventCache(eventId);

  // Surface this series as a `ticket` POD type in the creator's POD directory
  // (powers the #/creator/pods manager + <PodPicker>). Fire-and-forget: the
  // on-chain confirmation must not fail if the directory write hiccups. Keyed
  // by manifestRef, so the upsert also patches onChainEventId on re-confirm.
  const series = updated.series.find((s) => s.seriesId === seriesId);
  if (series?.manifestRef) {
    void upsertCreatorPod(updated.creatorAddress, {
      manifestRef: series.manifestRef,
      kind: "ticket",
      name: series.name,
      ...(updated.imageHash ? { image: updated.imageHash } : {}),
      ...(series.description ? { description: series.description } : {}),
      supply: series.totalSupply,
      eventId: onChainEventId,
      chainId: getActiveChainId(),
      createdAt: updated.createdAt,
      updatedAt: new Date().toISOString(),
    }).catch((err) =>
      console.error("[event] POD directory upsert failed (non-critical):", err),
    );
  }

  return updated;
}

/**
 * Stamp a sub-ENS label onto an event feed as a display hint. The label's
 * on-chain ownership MUST be verified by the caller (route) before this runs —
 * the feed field is presentation only; chain stays authoritative.
 */
export async function stampEventSubEns(
  eventId: string,
  label: string,
  parentAddress: string,
): Promise<EventFeed> {
  const feed = await getEvent(eventId);
  if (!feed) throw new Error("Event not found");
  if (feed.creatorAddress.toLowerCase() !== parentAddress.toLowerCase()) {
    throw new Error("Not the event creator");
  }
  if (feed.subEnsLabel === label) return feed; // idempotent

  const updated: EventFeed = { ...feed, subEnsLabel: label };
  // Phase B: client-owned feed — the client re-signs the SOC with the label (the
  // route returns `updated` for that). Legacy events: platform write here.
  if (!feed.creatorFeedSigner) {
    await writeFeedPage(topicEvent(eventId), encodeJsonFeed(updated));
  }
  invalidateEventCache(eventId);
  return updated;
}

// ---------------------------------------------------------------------------
// Read events
// ---------------------------------------------------------------------------

// 2-minute TTL cache — avoids repeat Swarm reads when multiple attendees
// hit create-checkout for the same event in a short window. Cache is
// explicitly invalidated on publish/update (see invalidateEventCache), so a
// longer TTL is safe and significantly reduces Swarm read pressure under
// bursty buy traffic.
const _eventCache = new Map<string, { feed: EventFeed; expiresAt: number }>();
const EVENT_CACHE_TTL_MS = 10 * 60_000;

/**
 * Read a client-owned event detail feed (Phase B) as a SOC owned by `signer`.
 * The payload is the raw EventFeed JSON the client signed (≤4096 bytes); decode
 * with the null-tolerant feed decoder. Returns null if the chunk is absent (e.g.
 * the client's SOC upload hasn't propagated yet) so callers fall back to legacy.
 */
export async function readEventFeedSoc(eventId: string, signer: string): Promise<EventFeed | null> {
  const payload = await readContentFeedJson(signer.replace(/^0x/, ""), eventContentTopic(eventId)).catch(() => null);
  if (!payload) return null;
  return decodeJsonFeed<EventFeed>(payload);
}

/**
 * Resolve the organiser's content-feed-signer for an event from the discovery
 * carrier — the global directory entry. Carrier-based, NOT a registry: the signer
 * is only known because the event is publicly listed. Returns null for legacy
 * (platform-signed) events and for events not in the global directory (those are
 * read by an explicit signer hint or via the legacy path).
 */
async function resolveCreatorFeedSigner(eventId: string): Promise<string | null> {
  try {
    const entries = await listEvents();
    return entries.find((e) => e.eventId === eventId)?.creatorFeedSigner ?? null;
  } catch {
    return null;
  }
}

/**
 * Money-path-safe event read. The result is CACHED by eventId and shared with the
 * claim/payment path, so `signerHint` MUST be a TRUSTED, server-resolved carrier
 * (the global directory, or a server-written `SiteEventsIndex` entry) — NEVER a
 * signer supplied in a client request. A client-supplied address must go through
 * {@link getEventForDisplay} instead, which never writes the cache. Passing an
 * untrusted hint here would let an attacker sign a fake event SOC under their own
 * key, prime this cache via the hint, and have a no-hint claim read serve the
 * forged price/recipient.
 *
 * @param signerHint  TRUSTED Phase B discovery carrier (directory / SiteEventsIndex).
 */
export async function getEvent(eventId: string, signerHint?: string): Promise<EventFeed | null> {
  const now = Date.now();
  const cached = _eventCache.get(eventId);
  if (cached && cached.expiresAt > now) return cached.feed;

  // Phase B: if the event has a known content-feed signer (hint or directory
  // carrier), read its client-signed SOC. Fall back to the legacy platform feed
  // when there is no signer (legacy event) or the SOC hasn't propagated yet.
  const signer = signerHint ?? (await resolveCreatorFeedSigner(eventId)) ?? undefined;
  let feed: EventFeed | null = signer ? await readEventFeedSoc(eventId, signer) : null;
  if (!feed) {
    const page = await readFeedPageWithRetry(topicEvent(eventId));
    feed = page ? decodeJsonFeed<EventFeed>(page) : null;
  }
  if (feed) {
    _eventCache.set(eventId, { feed, expiresAt: now + EVENT_CACHE_TTL_MS });
    for (const s of feed.series) {
      console.log(`[event] Read series "${s.name}" payment:`, s.payment ? JSON.stringify(s.payment) : "FREE");
    }
  }
  return feed;
}

/**
 * Display-only event read that MAY use an UNTRUSTED, client-supplied signer.
 * Tries the trusted/cached {@link getEvent} first (global directory + legacy
 * platform feed); only if that misses AND a client hint is supplied does it read
 * that SOC directly — WITHOUT writing the shared cache. So a forged hint can never
 * reach the money path: it can only shape this one display response. Use this for
 * any read whose signer originates in a client request (public `?signer=`,
 * a creator passing their own just-published signer, etc.).
 */
export async function getEventForDisplay(
  eventId: string,
  untrustedSigner?: string,
): Promise<EventFeed | null> {
  const trusted = await getEvent(eventId);
  if (trusted) return trusted;
  if (!untrustedSigner) return null;
  // Untrusted read — bypasses the cache entirely (no read-stale risk, no poison).
  return readEventFeedSoc(eventId, untrustedSigner);
}

/** Invalidate the event cache after a publish/update so the next read is fresh. */
export function invalidateEventCache(eventId: string): void {
  _eventCache.delete(eventId);
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

// ---------------------------------------------------------------------------
// In-memory directory cache
// ---------------------------------------------------------------------------
// Read-through cache with TTL. Avoids re-reading Swarm feeds on every
// GET /api/events while still healing from out-of-band writes (dev server
// writing via SSH tunnel, future client-side feed signers) within the TTL.
// Same-process writes prime the cache directly so the author sees their
// change immediately.

const DIR_CACHE_TTL_MS = 60_000;

let _dirCache: { at: number; data: EventDirectoryEntry[] } | null = null;
let _dirInFlight: Promise<EventDirectoryEntry[]> | null = null;

/** Read directory from Swarm (used on first call and cache miss). */
async function readDirectoryFromSwarm(): Promise<EventDirectoryEntry[]> {
  const page0 = await readFeedPage(topicEventDirectory());
  if (!page0) return [];
  const dir = decodeJsonFeed<EventDirectory>(page0);
  if (!dir) return [];

  const all = [...dir.entries];

  const totalPages = dir.pages ?? 0;
  for (let p = 1; p <= totalPages; p++) {
    const pageData = await readFeedPage(topicEventDirectory(p));
    if (!pageData) break;
    const overflow = decodeJsonFeed<EventDirectory>(pageData);
    if (overflow?.entries) all.push(...overflow.entries);
  }

  return all;
}

export async function listEvents(): Promise<EventDirectoryEntry[]> {
  if (_dirCache && Date.now() - _dirCache.at < DIR_CACHE_TTL_MS) {
    return _dirCache.data;
  }
  if (_dirInFlight) return _dirInFlight;

  _dirInFlight = (async () => {
    try {
      const data = await readDirectoryFromSwarm();
      // Only persist non-empty results. readFeedPage() swallows transient
      // Swarm errors into null (→ []); caching that would serve "no events"
      // until the next write or restart. Empty result falls through to the
      // last good cache if one exists.
      if (data.length > 0) {
        _dirCache = { at: Date.now(), data };
        return data;
      }
      return _dirCache?.data ?? data;
    } finally {
      _dirInFlight = null;
    }
  })();

  return _dirInFlight;
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
  if (e.endDate) compact.endDate = e.endDate;
  if (e.location) compact.location = e.location;
  if (e.apiUrl) compact.apiUrl = e.apiUrl;
  if (e.tagline) compact.tagline = e.tagline;
  // Discovery carrier — must survive compaction so readers can resolve the SOC.
  if (e.creatorFeedSigner) compact.creatorFeedSigner = e.creatorFeedSigner;
  return compact as unknown as EventDirectoryEntry;
}

/**
 * Returns true if the organiser has at least one event that has demonstrably
 * completed (endDate, or startDate as fallback, + 24 hours is in the past).
 * Used to decide whether to force escrow on new paid events.
 */
export async function isOrganiserTrusted(creatorAddress: string): Promise<boolean> {
  const events = await getCreatorEvents(creatorAddress);
  const now = Date.now();
  const twentyFourHoursMs = 24 * 60 * 60 * 1000;
  return events.some((e) => {
    const completionDate = e.endDate ?? e.startDate;
    const completionTime = new Date(completionDate).getTime();
    return completionTime + twentyFourHoursMs < now;
  });
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

/**
 * Strict directory read for the WRITE path. Returns the full prior contents
 * of a paged directory feed, OR throws if any page read failed transiently.
 * Bootstrap (status === "absent" on page 0) returns [] — safe to write the
 * first entry of a brand-new directory.
 *
 * MUST be used in place of the cached / null-on-error readers when the result
 * will be used as the basis for a directory rewrite. A transient Swarm read
 * failure that returned [] would otherwise cause the rewrite to overwrite
 * the directory with just the new entry, erasing every other organiser's
 * data. Better to abort the upsert (fire-and-forget caller logs a warning)
 * than to corrupt the directory irreversibly.
 */
async function readDirectoryStrict(
  topicFn: (page: number) => import("@ethersphere/bee-js").Topic,
): Promise<EventDirectoryEntry[]> {
  const page0 = await readFeedPageStrict(topicFn(0));
  if (page0.status === "error") {
    throw new Error(`Directory read failed (page 0) — refusing to write: ${page0.error.message}`);
  }
  if (page0.status === "absent") return [];

  const dir = decodeJsonFeed<EventDirectory>(page0.data);
  if (!dir) {
    throw new Error("Directory page 0 decoded to null — refusing to write");
  }

  const all = [...dir.entries];
  const totalPages = dir.pages ?? 0;
  for (let p = 1; p <= totalPages; p++) {
    const overflow = await readFeedPageStrict(topicFn(p));
    if (overflow.status === "error") {
      throw new Error(`Directory read failed (overflow page ${p}) — refusing to write: ${overflow.error.message}`);
    }
    if (overflow.status === "absent") break; // gap = end of pages, matches read-side behaviour
    const decoded = decodeJsonFeed<EventDirectory>(overflow.data);
    if (decoded?.entries) all.push(...decoded.entries);
  }
  return all;
}

async function addToEventDirectory(
  entry: EventDirectoryEntry,
  opts: { skipPublicDirectory?: boolean } = {},
): Promise<void> {
  // Write to global public directory (skipped for site-builder events until explicitly listed).
  if (!opts.skipPublicDirectory) {
    // Always strict-read at write time. The read-cache may be up to
    // DIR_CACHE_TTL_MS stale, and with dev-tunnel writes (and future
    // client-side feed signers) another writer may have appended entries
    // we don't know about — trusting a stale local view would clobber them.
    const allEntries = await readDirectoryStrict(topicEventDirectory);

    if (!allEntries.some((e) => e.eventId === entry.eventId)) {
      const updated = [entry, ...allEntries];
      _dirCache = { at: Date.now(), data: updated };
      const updatedAt = new Date().toISOString();
      await writeDirectoryPages(updated, updatedAt, topicEventDirectory);
      console.log(`[event] Directory updated: ${updated.length} events`);
    }
  }

  // Per-creator index (never removed from — listing status doesn't affect
  // organiser view). Same strict-read protection.
  const creatorEntries = await readDirectoryStrict(
    (p) => topicCreatorDirectory(entry.creatorAddress, p),
  );
  if (!creatorEntries.some((e) => e.eventId === entry.eventId)) {
    const updated = [entry, ...creatorEntries];
    const updatedAt = new Date().toISOString();
    await writeDirectoryPages(
      updated,
      updatedAt,
      (p) => topicCreatorDirectory(entry.creatorAddress, p),
    );
    invalidateCreatorEventsCache(entry.creatorAddress);
    console.log(`[event] Creator index updated for ${entry.creatorAddress}: ${updated.length} events`);
  }
}

// In-memory memo for getCreatorEvents — collapses repeated reads across
// page loads, tabs, and the burst when CreatorHome + DashboardIndex +
// EventsTab all fetch the same address in parallel. 5 minutes matches the
// SITE_EVENTS_FULL_TTL pattern used on the public bundled endpoint. Write
// paths (createEvent → invalidateCreatorEventsCache) clear the entry so a
// freshly published event appears immediately for its author.
const CREATOR_EVENTS_MEMO_TTL_MS = 5 * 60_000;
const _creatorEventsMemo = new Map<string, { at: number; data: EventDirectoryEntry[] }>();
const _creatorEventsInFlight = new Map<string, Promise<EventDirectoryEntry[]>>();

export function invalidateCreatorEventsCache(ethAddress: string): void {
  _creatorEventsMemo.delete(ethAddress.toLowerCase());
}

export async function getCreatorEvents(
  ethAddress: string,
  opts: { fresh?: boolean } = {},
): Promise<EventDirectoryEntry[]> {
  const key = ethAddress.toLowerCase();
  if (!opts.fresh) {
    const memo = _creatorEventsMemo.get(key);
    if (memo && Date.now() - memo.at < CREATOR_EVENTS_MEMO_TTL_MS) {
      return memo.data;
    }
    const inFlight = _creatorEventsInFlight.get(key);
    if (inFlight) return inFlight;
  }

  const load = (async () => {
    const page0 = await readFeedPage(topicCreatorDirectory(ethAddress));
    if (!page0) return [];
    const dir = decodeJsonFeed<EventDirectory>(page0);
    if (!dir) return [];

    const totalPages = dir.pages ?? 0;
    if (totalPages === 0) return [...dir.entries];

    // Read overflow pages in parallel — Swarm reads are the bottleneck here.
    const overflow = await Promise.all(
      Array.from({ length: totalPages }, (_, i) =>
        readFeedPage(topicCreatorDirectory(ethAddress, i + 1)),
      ),
    );
    const all = [...dir.entries];
    for (const pageData of overflow) {
      if (!pageData) break; // matches prior defensive behaviour
      const decoded = decodeJsonFeed<EventDirectory>(pageData);
      if (decoded?.entries) all.push(...decoded.entries);
    }
    return all;
  })();

  _creatorEventsInFlight.set(key, load);
  try {
    const data = await load;
    // Only memoize populated results. readFeedPage() collapses transient
    // Swarm errors into null (-> []) — caching that would pin an empty
    // response for CREATOR_EVENTS_MEMO_TTL_MS across every request.
    if (data.length > 0) {
      _creatorEventsMemo.set(key, { at: Date.now(), data });
    }
    return data;
  } finally {
    _creatorEventsInFlight.delete(key);
  }
}

export async function removeEventFromDirectory(eventId: string): Promise<void> {
  // Strict-read at write time — see addToEventDirectory for rationale.
  const allEntries = await readDirectoryStrict(topicEventDirectory);
  const before = allEntries.length;
  const filtered = allEntries.filter((e) => e.eventId !== eventId);
  if (filtered.length === before) return; // not in directory

  _dirCache = { at: Date.now(), data: filtered };
  const updatedAt = new Date().toISOString();
  await writeDirectoryPages(filtered, updatedAt, topicEventDirectory);
  console.log(`[event] Directory updated (removed ${eventId}): ${filtered.length} events`);
}
