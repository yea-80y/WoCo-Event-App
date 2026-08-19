/**
 * Single-Owner-Chunk (SOC) primitives shared between the client SOC writer and
 * the server stamp+upload endpoint.
 *
 * Phase A (CLIENT_FEED_SIGNER_HANDOVER.md) lets a client SIGN a SOC locally and
 * have the server STAMP+UPLOAD it. The server must independently re-derive the
 * content-addressed chunk (CAC) address from the submitted span+payload to verify
 * the client's signature commits to exactly those bytes — otherwise it would
 * stamp a chunk whose signature recovers to a different owner. Both ends MUST
 * compute the BMT address byte-identically, so the algorithm lives here.
 *
 * The implementation mirrors bee-js@11 `chunk/bmt.js#calculateChunkAddress`
 * (verified against the installed package): the chunk address is
 * `keccak256( span(8) || bmtRoot(payload) )`, where `bmtRoot` is the binary
 * Merkle tree root over the payload zero-padded to 4096 bytes, in 32-byte
 * segments, reduced pairwise with keccak256. We re-implement it with keccak only
 * (no bee-js dep) so `@woco/shared` stays free of the Bee SDK.
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import type { RecoveryEnvelope } from "../recovery/types.js";

/** Max SOC/CAC payload (bytes). */
export const SOC_MAX_PAYLOAD_SIZE = 4096;
/** BMT segment size (bytes). */
const SEGMENT_SIZE = 32;
/** Swarm span field width (bytes) — little-endian uint64 payload length. */
export const SOC_SPAN_SIZE = 8;
/** secp256k1 signature length on a SOC (bytes). */
export const SOC_SIGNATURE_SIZE = 65;
/** SOC identifier length (bytes). */
export const SOC_IDENTIFIER_SIZE = 32;

/**
 * Split a SOC as it is STORED — `identifier(32) || signature(65) || span(8) ||
 * payload(1..4096)` — or null if the bytes are too short to be one.
 *
 * Here rather than at a call site because it is a wire layout, and two readers
 * disagreeing about where the payload starts is the kind of bug that surfaces
 * as garbled JSON rather than as an error. Both a server-side gateway read and
 * a browser-side spot-check of an evidence leaf need it.
 *
 * Returns views over the input, not copies: callers only read.
 */
export function splitStoredSoc(
  raw: Uint8Array,
): { identifier: Uint8Array; signature: Uint8Array; span: Uint8Array; payload: Uint8Array } | null {
  const headerSize = SOC_IDENTIFIER_SIZE + SOC_SIGNATURE_SIZE + SOC_SPAN_SIZE;
  if (raw.length < headerSize + 1) return null;
  return {
    identifier: raw.subarray(0, SOC_IDENTIFIER_SIZE),
    signature: raw.subarray(SOC_IDENTIFIER_SIZE, SOC_IDENTIFIER_SIZE + SOC_SIGNATURE_SIZE),
    span: raw.subarray(SOC_IDENTIFIER_SIZE + SOC_SIGNATURE_SIZE, headerSize),
    payload: raw.subarray(headerSize),
  };
}

/** Encode a payload length as the 8-byte little-endian Swarm span. */
export function encodeSpan(length: number): Uint8Array {
  const span = new Uint8Array(SOC_SPAN_SIZE);
  let n = BigInt(length);
  for (let i = 0; i < SOC_SPAN_SIZE; i++) {
    span[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return span;
}

/**
 * BMT root over a chunk payload: zero-pad to 4096, split into 32-byte segments,
 * then reduce adjacent pairs with keccak256 until a single 32-byte hash remains.
 */
function bmtRootHash(payload: Uint8Array): Uint8Array {
  if (payload.length > SOC_MAX_PAYLOAD_SIZE) {
    throw new Error(`payload ${payload.length} exceeds max chunk size ${SOC_MAX_PAYLOAD_SIZE}`);
  }
  const input = new Uint8Array(SOC_MAX_PAYLOAD_SIZE);
  input.set(payload);

  let level: Uint8Array[] = [];
  for (let off = 0; off < SOC_MAX_PAYLOAD_SIZE; off += SEGMENT_SIZE) {
    level.push(input.subarray(off, off + SEGMENT_SIZE));
  }
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(keccak_256(concatBytes(level[i], level[i + 1])));
    }
    level = next;
  }
  return level[0];
}

/**
 * Content-addressed chunk (CAC) address for `span || payload` — the value a SOC
 * signature commits to (alongside the identifier). `span` MUST be the 8-byte
 * encoding of `payload.length` (see {@link encodeSpan}).
 */
export function calculateCacAddress(span: Uint8Array, payload: Uint8Array): Uint8Array {
  if (span.length !== SOC_SPAN_SIZE) throw new Error("span must be 8 bytes");
  return keccak_256(concatBytes(span, bmtRootHash(payload)));
}

/**
 * The SOC's own Swarm address (where it is stored/read): `keccak256(identifier || owner)`.
 * `owner` is the 20-byte Ethereum address; `identifier` is 32 bytes.
 */
export function calculateSocAddress(identifier: Uint8Array, owner: Uint8Array): Uint8Array {
  if (identifier.length !== SOC_IDENTIFIER_SIZE) throw new Error("identifier must be 32 bytes");
  if (owner.length !== 20) throw new Error("owner must be 20 bytes");
  return keccak_256(concatBytes(identifier, owner));
}

/** The digest a SOC owner signs: `concat(identifier, cacAddress)`. */
export function socSignDigest(identifier: Uint8Array, cacAddress: Uint8Array): Uint8Array {
  return concatBytes(identifier, cacAddress);
}

// ---------------------------------------------------------------------------
// Cross-device recovery portability envelope (CROSS_DEVICE_RECOVERY.md §3)
// ---------------------------------------------------------------------------

/**
 * Fixed input hashed (keccak256) into the SOC identifier for the recovery
 * portability envelope. A constant identifier makes the envelope overwrite-in-
 * place (same owner+identifier) and discoverable on any device without feed-index
 * logic — it is read by computed chunk address, never via `/feeds` (Etherna-safe).
 */
export const PORTABILITY_SOC_IDENTIFIER_INPUT = "woco/recovery/portability/v1";

/**
 * Domain-separation tags for the two keys derived from the passkey PRF secret.
 * Distinct domains so neither derived key reveals the other (handover step 3).
 */
export const PORTABILITY_SOC_OWNER_DOMAIN = "woco/recovery/portability/soc-owner/v1";
export const PORTABILITY_HPKE_DOMAIN = "woco/recovery/portability/hpke/v1";

/**
 * Current portability-envelope payload version.
 * v2 (2026-06-21) closed the privacy leak: `preservedKernelAddress` moved from
 * cleartext into the sealed bundle, and the envelope is sealed under the public
 * PRF-derived `socOwnerAddress` (not the real Kernel) so nothing on the chunk
 * links the pseudonymous SOC owner to the user's real Kernel account. v1 SOCs no
 * longer parse → the login back-fill rewrites them (no real users → no migration).
 */
export const PORTABILITY_ENVELOPE_VERSION = 2 as const;

/**
 * The plaintext stored (sealed) inside the portability SOC. `envelope` is the
 * SAME audited `RecoveryEnvelope` produced by `recovery-escrow.ts`, sealed to one
 * extra HPKE recipient (a PRF-derived X25519 key) AND bound (AAD + its cleartext
 * `kernelAddress` field) to the PRF-derived `socOwnerAddress` pseudonym — never
 * the real Kernel. The sealed bundle inside `envelope` carries
 * `{ preservedKernelAddress, podSeed[, feedSignerPrivKey] }`: the new device reads
 * the preserved Kernel post-decrypt and verifies it on-chain before applying any
 * override. The optional `feedSignerPrivKey` rides the same sealed bundle.
 */
export interface PortabilityEnvelope {
  v: typeof PORTABILITY_ENVELOPE_VERSION;
  envelope: RecoveryEnvelope;
}

/** keccak256 of the fixed portability identifier input → the 32-byte SOC identifier. */
export function portabilitySocIdentifier(): Uint8Array {
  return keccak_256(utf8ToBytes(PORTABILITY_SOC_IDENTIFIER_INPUT));
}

/**
 * Content-feed topic STRING for a passkey account's recovery-escrow envelope
 * (`woco/recovery/{kernelAddress}`). §13: the sealed envelope moves off the
 * platform-signed feed onto a GUARDIAN-owned SOC — the client signs it with a
 * signer derived from the backup wallet, so the platform can no longer forge or
 * withhold it. The SOC identifier is `contentFeedSocIdentifier` of THIS string;
 * the OWNER is the guardian-derived SOC address (computed locally at protect and
 * recover time), never the platform. The string mirrors the legacy bee-js
 * `topicRecovery`, but the two address different Swarm locations (owner-addressed
 * SOC vs sequential feed), so there is no collision — the shared string is only a
 * naming convention.
 */
export function recoveryContentTopic(kernelAddress: string): string {
  return `woco/recovery/${kernelAddress.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Client-owned content feeds (Phase B — CLIENT_FEED_SIGNER_HANDOVER.md Task 2)
// ---------------------------------------------------------------------------

/**
 * Domain for deriving a user's content-feed SIGNING key from their root login
 * secret (Web3Auth secp256k1 key / passkey PRF output). Domain-separated from the
 * POD seed and the recovery/portability keys so the feed signer is an INDEPENDENT
 * identity: rotating or leaking it never exposes POD, encryption, or funds.
 *
 * The derived secp256k1 key's ADDRESS is the OWNER of every content SOC the user
 * writes (`keccak256(identifier || ownerAddress)`), so the USER — not the platform
 * — owns the feed. The platform only lends postage (stamps) at write time; this is
 * a swappable transport (per-user batch / browser-Bee later) that does not touch
 * ownership. Derivation only SEEDS a new signer; the key is then persisted +
 * ESCROWED (`feed-signer-store.ts`, recovery + portability bundles) so a rotated
 * passkey credential — which would derive a divergent key — cannot orphan the
 * user's feeds. The stored/escrowed copy is authoritative, not re-derivation.
 */
export const CONTENT_FEED_SIGNER_DOMAIN = "woco/feed-signer/v1";

/**
 * SOC identifier for a content feed addressed by its stable topic string
 * (e.g. `"woco/profile/data/0xabc…"` or a paged `"…/p1"`). `keccak256(topic)` →
 * an overwrite-in-place SOC owned by the user's content-feed-signer address, read
 * by computed chunk address (Etherna-safe — never `/feeds`). Replaces the
 * sequential bee-js feed index for single-writer content: a SOC at a fixed
 * (owner, identifier) is mutable in place, so no per-topic index bookkeeping.
 */
export function contentFeedSocIdentifier(topic: string): Uint8Array {
  return keccak_256(utf8ToBytes(topic));
}

/**
 * Multi-chunk content feeds. A single SOC payload is capped at 4096 bytes, so a
 * content feed larger than that pages across multiple SOCs (like the directory /
 * editions feeds). The base SOC (at `topic`) then holds a small MANIFEST instead
 * of the raw JSON; the data lives at `topic/p1 … /pN`, read by computed address
 * (inline payloads only — Etherna-safe, never a ref-style SOC). A feed that fits
 * in one chunk keeps the base SOC = raw JSON, so small feeds are unchanged.
 */
export const CONTENT_FEED_MC_MARKER = "_woco_mc" as const;

/** Page-0 manifest for a multi-chunk content feed. Tiny — always fits one chunk. */
export interface ContentFeedManifest {
  /** Discriminator (always 1). Distinguishes a manifest from a real feed payload. */
  [CONTENT_FEED_MC_MARKER]: 1;
  /** Number of data pages at `{topic}/p1` … `{topic}/pN`. */
  pages: number;
  /** Total byte length of the concatenated JSON (integrity check). */
  len: number;
}

/** Topic string for data page `page` (1-based) of a multi-chunk content feed. */
export function contentFeedPageTopic(topic: string, page: number): string {
  return `${topic}/p${page}`;
}

/** uint64 BIG-ENDIAN (8 bytes) — bee's feed-index byte order. Throws on non-int/negative. */
function uint64BE(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0) throw new Error(`invalid feed index: ${n}`);
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), false);
  return b;
}

/**
 * Versioned SOC identifier: `keccak256(baseIdentifier || uint64BE(version))`.
 *
 * A SOC is IMMUTABLE — re-uploading at the same (owner, identifier) with new bytes
 * is silently discarded by Bee (dedupe by chunk address; 201 returned, OLD payload
 * kept). So a fixed-identifier content feed only ever landed its FIRST write; every
 * edit was lost. Mutability on Swarm comes from writing update N at a NEW identifier
 * and resolving "latest" — a standard single-owner sequence feed. This derives that
 * per-version identifier. When `baseIdentifier = contentFeedSocIdentifier(topic) =
 * keccak(topic)`, the result is BYTE-IDENTICAL to bee's own feed-update identifier
 * (see {@link beeFeedUpdateIdentifier}), so the versioned feed is resolvable by
 * computed chunk address (Etherna-safe — never `/feeds`). Kept generic so a
 * fixed-identifier feed (the recovery/portability envelope) gains the same version
 * dimension off ITS base identifier.
 */
export function versionedSocIdentifier(baseIdentifier: Uint8Array, version: number): Uint8Array {
  if (baseIdentifier.length !== SOC_IDENTIFIER_SIZE) throw new Error("base identifier must be 32 bytes");
  return keccak_256(concatBytes(baseIdentifier, uint64BE(version)));
}

/**
 * Page identifier for page `page` (1-based) of `version` of a versioned, multi-chunk
 * feed: `keccak256(baseIdentifier || uint64BE(version) || uint64BE(page))`. The
 * version is folded into the identifier so a reader of version n can never see
 * version n+1's pages (no torn read across a concurrent update). The 48-byte input
 * (vs the base's 40) also guarantees no collision with the base version SOC.
 */
export function versionedPageIdentifier(baseIdentifier: Uint8Array, version: number, page: number): Uint8Array {
  if (baseIdentifier.length !== SOC_IDENTIFIER_SIZE) throw new Error("base identifier must be 32 bytes");
  if (!Number.isInteger(page) || page < 1) throw new Error(`invalid page: ${page}`);
  return keccak_256(concatBytes(baseIdentifier, uint64BE(version), uint64BE(page)));
}

/**
 * SOC identifier for a bee SEQUENCE-FEED update — byte-identical to bee-js@11
 * `makeFeedIdentifier` (verified against the installed package + `bee-feed-identifier.test.ts`):
 * `keccak256( keccak256(utf8(topicString)) || uint64BE(index) )`. Used where a
 * client-owned feed must stay resolvable by bee's own feed machinery (gateway
 * `/bzz/{feedManifestHash}` resolution — e.g. the per-site multisite pointer
 * feed), which `contentFeedSocIdentifier`'s flat keccak(topic) scheme is not.
 * The update SOC's payload is the collection ROOT CHUNK's data (span stripped),
 * matching bee-js `uploadPayload`'s wrapped-chunk form for payloads ≤ 4096 B.
 *
 * This is exactly {@link versionedSocIdentifier} with `baseIdentifier = keccak(topic)`,
 * i.e. `versionedSocIdentifier(contentFeedSocIdentifier(topic), index)` — so a
 * versioned content feed IS a bee sequence feed with topic = the content topic.
 */
export function beeFeedUpdateIdentifier(topicString: string, index: number): Uint8Array {
  return versionedSocIdentifier(keccak_256(utf8ToBytes(topicString)), index);
}

/** True if a decoded base-SOC payload is a multi-chunk manifest (vs a real feed). */
export function isContentFeedManifest(o: unknown): o is ContentFeedManifest {
  return (
    !!o && typeof o === "object" &&
    (o as Record<string, unknown>)[CONTENT_FEED_MC_MARKER] === 1 &&
    typeof (o as Record<string, unknown>).pages === "number" &&
    typeof (o as Record<string, unknown>).len === "number"
  );
}

/**
 * Canonical content-feed topic STRING for an event's detail feed
 * (`woco/event/{eventId}`). Both the client SOC writer and the server SOC reader
 * MUST derive `contentFeedSocIdentifier()` from THIS exact string, so it lives in
 * shared to prevent drift (the server's bee-js `topicEvent` builds the same
 * string for the legacy platform-signed feed). Phase B: when an organiser owns a
 * client feed signer, the event detail feed is a SOC at this topic owned by their
 * signer address (carried in the directory entry — see `creatorFeedSigner`).
 */
export function eventContentTopic(eventId: string): string {
  return `woco/event/${eventId}`;
}

/**
 * Canonical content-feed topic STRINGS for a user's profile feeds
 * (`woco/profile/data/{address}` and `woco/profile/avatar/{address}`). Phase B:
 * when a user owns a content-feed signer, these become SOCs at these topics owned
 * by their signer address. The feed is keyed by the user's IDENTITY address (so
 * the topic is derivable from the address alone), but SIGNED by their derived
 * content-feed signer (the SOC owner) — readers resolve the signer from a carrier
 * (e.g. an event's `creatorFeedSigner`, which is the SAME signer that owns this
 * user's profile). MUST byte-match the server's bee-js `topicProfileData` /
 * `topicProfileAvatar` strings so both ends address the same chunk.
 */
export function profileDataContentTopic(address: string): string {
  return `woco/profile/data/${address.toLowerCase()}`;
}

export function profileAvatarContentTopic(address: string): string {
  return `woco/profile/avatar/${address.toLowerCase()}`;
}

// `editionsContentTopic` (woco/pod/editions/{seriesId}) was deleted with the
// v1 claim rail — nothing writes or reads the editions feed; the WoCoEventV2
// contract is the supply ledger.

// ---------------------------------------------------------------------------
// Versioned content-feed READ (probe latest, reassemble, legacy fallback)
//
// Shared by the client (`content-feed.ts`, gateway-first `probeSoc`) and the server
// (`soc-upload.ts`, `readSocPayload`) so both ends resolve "latest" identically.
// Each end supplies its own chunk reader; the derivation + probing algorithm live
// here to prevent drift.
// ---------------------------------------------------------------------------

/**
 * The outcome of ONE chunk probe. Three states, not two: a reader that collapses
 * "the network said there is no such chunk" into the same `null` as "the network
 * did not answer" makes every caller unsound. A writer computes the next version
 * off it (a wrong answer silently dedupes the write against an existing immutable
 * SOC — old payload kept, 201 returned); a login caches "this account was never
 * recovered" off it. Both need `absent` to MEAN absent.
 *
 * `unavailable` carries an optional human `reason` for diagnosis only — no caller
 * branches on it.
 */
export type SocReadOutcome =
  | { status: "found"; bytes: Uint8Array }
  | { status: "absent" }
  | { status: "unavailable"; reason?: string };

/** Probes one SOC by identifier. See {@link SocReadOutcome} — three states. */
export type SocChunkProbe = (identifier: Uint8Array) => Promise<SocReadOutcome>;

/**
 * Highest version returned for a feed that has NO versioned chunk yet but does have
 * a pre-versioning fixed-identifier chunk (written before this fix). Below 0.
 */
export const LEGACY_CONTENT_FEED_VERSION = -1;

/**
 * Versions probed per round-trip (parallel). Deliberately SMALL: a probe past the
 * latest version is a bee network search for a chunk that does not exist — the
 * single most expensive read on Swarm (seconds, and it queues behind every other
 * retrieval on the node). A window of 8 fired 7+ such searches on EVERY read of
 * every feed and melted the bee node (2026-07-06). With 2, the common case
 * (accurate hint, or a feed at version 0) costs exactly ONE missing-chunk search;
 * existing-version reads are local and cheap, so extra rounds for a stale hint
 * are fine.
 */
const VERSION_PROBE_WINDOW = 2;

/** A resolved feed read: the bytes plus the version they came from. */
export type VersionedFeedRead =
  | { status: "found"; bytes: Uint8Array; /** Resolved version, or {@link LEGACY_CONTENT_FEED_VERSION}. */ version: number }
  | { status: "absent" }
  | { status: "unavailable"; reason?: string };

export interface SocVersionResolution {
  /** Highest version confirmed PRESENT, or null if none was found. */
  latest: number | null;
  /**
   * Whether a hint was supplied, and whether the scan ACTUALLY started there.
   *
   * These exist because the previous instrument could not tell them apart: it
   * counted whether a hint EXISTED, while this function silently restarts from
   * 0 when the hinted version does not resolve. A "hint hit" could therefore be
   * a full scan from zero, which is the one cost this design must not have and
   * the exact thing the measurement was meant to reveal. `hintGiven && !hintValidated`
   * is the signal worth alarming on: it means a version this device believes it
   * wrote read as absent — the whitelist-lag pathology, not a cold device.
   */
  hintGiven: boolean;
  hintValidated: boolean;
  /** The version the forward scan actually started from. */
  scannedFrom: number;
  /**
   * True only when every probe answered definitively. When false, `latest` is a
   * lower bound and nothing may be concluded from the scan STOPPING where it did —
   * in particular a write MUST NOT target `latest + 1`, because the version it
   * could not read may exist and the write would silently dedupe against it.
   */
  clean: boolean;
}

/**
 * Resolve the highest existing version by probing `read(baseIdFor(v))` FORWARD from
 * `hint`. Versions are contiguous from 0 and immutable (a version once written can
 * never disappear), so `hint` is a valid lower bound; a stale/wrong hint (its
 * version absent) falls back to a full scan from 0.
 *
 * An `unavailable` probe ends the scan like an absent one — the read path still gets
 * the best lower bound available — but clears `clean`, so a caller that needs
 * certainty (any WRITER) can refuse instead of guessing.
 */
export async function resolveLatestSocVersion(
  read: SocChunkProbe,
  baseIdFor: (version: number) => Uint8Array,
  hint = 0,
): Promise<SocVersionResolution> {
  let clean = true;
  const exists = async (v: number): Promise<boolean> => {
    const outcome = await read(baseIdFor(v));
    if (outcome.status === "unavailable") clean = false;
    return outcome.status === "found";
  };

  const hintGiven = hint > 0;
  let start = hintGiven ? hint : 0;
  let hintValidated = false;
  if (start > 0) {
    hintValidated = await exists(start);
    if (!hintValidated) start = 0; // hint unreliable → full scan
  }

  let latest = -1;
  for (let cursor = start; ; cursor += VERSION_PROBE_WINDOW) {
    const flags = await Promise.all(
      Array.from({ length: VERSION_PROBE_WINDOW }, (_, i) => exists(cursor + i)),
    );
    let ended = false;
    for (let i = 0; i < VERSION_PROBE_WINDOW; i++) {
      if (flags[i]) latest = cursor + i;
      else { ended = true; break; }
    }
    if (ended) break;
  }
  return { latest: latest >= 0 ? latest : null, clean, hintGiven, hintValidated, scannedFrom: start };
}

/** Where a banded head lives: which band, and the latest version inside it. */
export interface BandedHeadResolution {
  /** The highest OPENED band. 0 when the feed does not exist yet. */
  band: number;
  /** Highest version present in {@link band}, or null when nothing exists at all. */
  latest: number | null;
  /** False if any probe was inconclusive — a WRITER must refuse rather than guess. */
  clean: boolean;
}

/**
 * Resolve the head of a BANDED feed: `(band, latest version in band)`.
 *
 * Why this exists: an unbanded statement feed accumulates one SOC version per
 * write, so finding its head cost a probe per write — measured at 25 probes and
 * 7925ms on a NINE-lap account, growing forever. Banding caps the in-band scan
 * at {@link STATEMENT_BAND_SIZE}; this resolves which band to scan.
 *
 * TWO PHASES, deliberately, because collapsing them is quadratic. Phase 1 walks
 * only band OPENERS (version 0 of each band) to find the highest opened band —
 * one probe per band, all cheap hits, windowed for parallelism. Phase 2 scans
 * versions inside that one band. Cost is O(bands + band size), NOT
 * O(bands × band size), which is what resolving each band in turn would cost.
 *
 * Phase 1 is sound ONLY because of the full-band invariant (see
 * `statement/discipline.ts`): bands are contiguous from 0 and a band opens only
 * once its predecessor is full, so the first absent opener ends the walk. This
 * is also why a caller needs no carrier for the band — the social subject index
 * has no partition rule and nothing read before it, and finds its band this way.
 *
 * `hintBand` is a lower bound, not a promise: if its opener is absent the walk
 * restarts from 0, exactly as a stale version hint does. Pass the band recorded
 * in a subject index (credits) or 0 (social, cold devices).
 *
 * An `unavailable` probe ends a walk like an absent one but clears `clean`, so a
 * writer can refuse instead of writing at a version that may already exist —
 * where Bee would silently dedupe and drop the edit.
 */
export interface OpenBandResolution {
  /** The highest OPENED band. */
  band: number;
  /** False when band 0 does not exist — the feed has never been written. */
  exists: boolean;
  /** False if any probe was inconclusive — a WRITER must refuse rather than guess. */
  clean: boolean;
}

/**
 * PHASE 1 alone: which band is open, walking only band OPENERS (version 0 of
 * each band).
 *
 * Exported separately because the two callers want different things. A credits
 * read already learns the band from the subject index — the partition rule
 * forces that read anyway, so the band rides free — and needs no walk at all.
 * The SOCIAL subject index has no partition rule and nothing read before it, so
 * it discovers its band exactly here, which is the case the full-band invariant
 * was frozen to make possible.
 *
 * Sound only under that invariant: bands are contiguous from 0 and one opens
 * only once its predecessor is full, so the first absent opener ends the walk.
 * `hintBand` is a lower bound, not a promise — an unopened hint restarts from 0.
 */
export async function resolveOpenBand(
  read: SocChunkProbe,
  topicForBand: (band: number) => string,
  hintBand = 0,
): Promise<OpenBandResolution> {
  let clean = true;
  const openerExists = async (band: number): Promise<boolean> => {
    const base = contentFeedSocIdentifier(topicForBand(band));
    const outcome = await read(versionedSocIdentifier(base, 0));
    if (outcome.status === "unavailable") clean = false;
    return outcome.status === "found";
  };

  // TRIPWIRE. A `topicForBand` that ignores its argument makes every opener
  // probe address the SAME chunk, so if that chunk exists the walk below can
  // never find an absent opener and loops forever. This is not hypothetical: the
  // social indexer passed `() => likeStatementTopic(subject)` — correct for a
  // type pinned to band 0 — and hung on the first like it tried to tally.
  // A type pinned to a constant band must not be band-walked at all; it should
  // read its fixed topic directly.
  if (topicForBand(0) === topicForBand(1)) {
    throw new Error(
      "resolveOpenBand requires a topic family that varies with band; " +
        "a band-pinned feed must be read at its fixed topic instead",
    );
  }

  let band = Number.isSafeInteger(hintBand) && hintBand > 0 ? hintBand : 0;
  if (band > 0 && !(await openerExists(band))) band = 0; // hint unreliable → full walk
  if (band === 0 && !(await openerExists(0))) return { band: 0, exists: false, clean };

  for (;;) {
    const flags = await Promise.all(
      Array.from({ length: VERSION_PROBE_WINDOW }, (_, i) => openerExists(band + 1 + i)),
    );
    let advanced = 0;
    for (let i = 0; i < VERSION_PROBE_WINDOW; i++) {
      if (!flags[i]) break;
      advanced = i + 1;
    }
    band += advanced;
    if (advanced < VERSION_PROBE_WINDOW) break; // hit an absent opener — bands are contiguous
  }
  return { band, exists: true, clean };
}

export async function resolveBandedHead(
  read: SocChunkProbe,
  topicForBand: (band: number) => string,
  hintBand = 0,
): Promise<BandedHeadResolution> {
  const open = await resolveOpenBand(read, topicForBand, hintBand);
  if (!open.exists) return { band: 0, latest: null, clean: open.clean };

  // Phase 2 — latest version inside that one band.
  const base = contentFeedSocIdentifier(topicForBand(open.band));
  const inBand = await resolveLatestSocVersion(read, (v) => versionedSocIdentifier(base, v), 0);
  return { band: open.band, latest: inBand.latest, clean: open.clean && inBand.clean };
}

/**
 * Read + reassemble ONE version's payload: a single-chunk feed is the base SOC's
 * raw bytes; a multi-chunk feed is a {@link ContentFeedManifest} in the base SOC
 * plus `pages` data SOCs. `baseId`/`pageIdFor` select versioned vs legacy identifiers.
 *
 * Only an absent BASE chunk is `absent`. A manifest whose pages are missing, out of
 * range, or don't add up to the length it declares is a torn/corrupt write — real
 * bytes exist at this identifier, so reporting `absent` would let a caller cache
 * "nothing was ever here". That is `unavailable`.
 *
 * The `len` check is the only thing standing between a half-written version and
 * SILENT corruption (#170), and the write-side refusal added for #154 cannot help
 * here. Pages upload BEFORE the manifest, so an attempt that lands its pages then
 * fails leaves version N with pages but no base. The next write probes N, finds its
 * base genuinely absent — a CLEAN answer, so nothing refuses — targets N again, and
 * its page uploads dedupe against the failed attempt's chunks (a SOC is immutable:
 * 201 returned, old bytes kept) while the fresh manifest describes the new payload.
 * Assembling that yields the OLD bytes under the NEW manifest. `len` is the one
 * field that disagrees, so it is the only thing that can catch it.
 */
export async function assembleContentFeed(
  read: SocChunkProbe,
  baseId: Uint8Array,
  pageIdFor: (page: number) => Uint8Array,
): Promise<SocReadOutcome> {
  const base = await read(baseId);
  if (base.status !== "found") return base;
  const raw = base.bytes;

  let head: unknown;
  try {
    head = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return base; // not JSON (shouldn't happen for our feeds) — hand back as-is
  }
  if (!isContentFeedManifest(head)) return base; // single-chunk feed
  if (head.pages < 1 || head.pages > 256) {
    return { status: "unavailable", reason: `manifest page count out of range: ${head.pages}` };
  }

  const parts: Uint8Array[] = [];
  for (let i = 1; i <= head.pages; i++) {
    const page = await read(pageIdFor(i));
    if (page.status !== "found") {
      return { status: "unavailable", reason: `multi-chunk page ${i}/${head.pages} ${page.status}` };
    }
    parts.push(page.bytes);
  }
  const full = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { full.set(p, off); off += p.length; }
  if (full.length !== head.len) {
    return {
      status: "unavailable",
      reason: `multi-chunk length mismatch: assembled ${full.length} B, manifest declares ${head.len} B`,
    };
  }
  return { status: "found", bytes: full };
}

/**
 * Read the latest version of a TOPIC-addressed client content feed via `read`.
 * Probes versioned identifiers first; if none exist, falls back to the legacy
 * pre-versioning fixed identifier (`contentFeedSocIdentifier(topic)` + its
 * `topic/pN` pages) — so a feed written before this fix stays READABLE, and its
 * first edit (which writes version 0) then wins over the legacy chunk with NO
 * re-publish.
 *
 * `absent` is only ever returned when the version scan was CLEAN and found nothing
 * and the legacy identifier is definitively absent too — i.e. the one answer a
 * caller may cache.
 *
 * A `found` under a DIRTY scan may be a stale version (a higher one existed but
 * could not be read). That is the normal best-effort read contract — the bytes are
 * genuinely this feed's, just possibly not its newest. Callers for which staleness
 * is unsafe must verify out-of-band; the recovery paths verify on-chain.
 */
export interface VersionedReadOptions {
  /**
   * Skip the pre-versioning legacy fallback. Set for feeds that were BORN
   * versioned — statement rails, which postdate versioning entirely — where a
   * legacy chunk cannot exist and probing for one burns a guaranteed
   * missing-chunk network search on every clean-absent read, forever, for
   * nothing.
   */
  skipLegacy?: boolean;
  /** Receives the scan diagnostics, so a caller can count what actually happened. */
  onScan?: (d: Pick<SocVersionResolution, "hintGiven" | "hintValidated" | "scannedFrom">) => void;
}

export async function readVersionedContentFeed(
  read: SocChunkProbe,
  topic: string,
  hint = 0,
  opts: VersionedReadOptions = {},
): Promise<VersionedFeedRead> {
  const base = contentFeedSocIdentifier(topic);
  const baseIdFor = (v: number): Uint8Array => versionedSocIdentifier(base, v);

  const { latest, clean, hintGiven, hintValidated, scannedFrom } =
    await resolveLatestSocVersion(read, baseIdFor, hint);
  opts.onScan?.({ hintGiven, hintValidated, scannedFrom });
  if (latest !== null) {
    const asm = await assembleContentFeed(
      read,
      baseIdFor(latest),
      (page) => versionedPageIdentifier(base, latest, page),
    );
    if (asm.status === "found") return { status: "found", bytes: asm.bytes, version: latest };
    // The probe just confirmed this version PRESENT, so an absent re-read is a
    // contradiction (a vanished chunk / a reader disagreeing with itself), never
    // evidence that the feed does not exist.
    return asm.status === "absent"
      ? { status: "unavailable", reason: `version ${latest} vanished between probe and read` }
      : asm;
  }

  // A dirty scan found nothing — but it never asked every question, so "nothing
  // exists" is not a conclusion that can be drawn (and the legacy probe below
  // would answer for the wrong identifier anyway).
  if (!clean) return { status: "unavailable", reason: "version probe inconclusive" };

  if (opts.skipLegacy) return { status: "absent" };

  // Legacy fallback: the pre-versioning fixed identifier + its topic-string pages.
  const legacy = await assembleContentFeed(
    read,
    base,
    (page) => contentFeedSocIdentifier(contentFeedPageTopic(topic, page)),
  );
  return legacy.status === "found"
    ? { status: "found", bytes: legacy.bytes, version: LEGACY_CONTENT_FEED_VERSION }
    : legacy;
}
