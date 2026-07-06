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

import { keccak_256 } from "@noble/hashes/sha3";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils";
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

/**
 * Canonical content-feed topic STRING for a series' EDITIONS feed
 * (`woco/pod/editions/{seriesId}` or paged `…/p{N}`). Phase B: the editions feed
 * is a SOC owned by the organiser's content-feed signer (the carrier), so the
 * server can only READ it (it never holds that key) and the platform signer never
 * writes editions. The 4096-byte `pack4096` page rides inline (Etherna-safe). MUST
 * byte-match the server's bee-js `topicEditions` strings so the legacy
 * platform-feed and the client SOC address the same logical feed. Page 0 = slot 0
 * meta + editions 1..127; pages 1+ = 128 editions each.
 */
export function editionsContentTopic(seriesId: string, page = 0): string {
  return page === 0
    ? `woco/pod/editions/${seriesId}`
    : `woco/pod/editions/${seriesId}/p${page}`;
}

// ---------------------------------------------------------------------------
// Versioned content-feed READ (probe latest, reassemble, legacy fallback)
//
// Shared by the client (`content-feed.ts`, gateway-first `readSoc`) and the server
// (`soc-upload.ts`, `readSocPayload`) so both ends resolve "latest" identically.
// Each end supplies its own chunk reader; the derivation + probing algorithm live
// here to prevent drift.
// ---------------------------------------------------------------------------

/** Reads one SOC's inline payload by identifier, or null if the chunk is absent. */
export type SocChunkReader = (identifier: Uint8Array) => Promise<Uint8Array | null>;

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

export interface VersionedFeedRead {
  bytes: Uint8Array;
  /** Resolved version, or {@link LEGACY_CONTENT_FEED_VERSION} for the legacy chunk. */
  version: number;
}

/**
 * Resolve the highest existing version by probing `read(baseIdFor(v))` FORWARD from
 * `hint`. Versions are contiguous from 0 and immutable (a version once written can
 * never disappear), so `hint` is a valid lower bound; a stale/wrong hint (its
 * version absent) falls back to a full scan from 0. Returns the highest version, or
 * `null` if no versioned chunk exists at all (⇒ caller tries the legacy identifier).
 */
export async function resolveLatestSocVersion(
  read: SocChunkReader,
  baseIdFor: (version: number) => Uint8Array,
  hint = 0,
): Promise<number | null> {
  const exists = async (v: number): Promise<boolean> => (await read(baseIdFor(v))) !== null;

  let start = hint > 0 ? hint : 0;
  if (start > 0 && !(await exists(start))) start = 0; // hint unreliable → full scan

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
  return latest >= 0 ? latest : null;
}

/**
 * Read + reassemble ONE version's payload: a single-chunk feed is the base SOC's
 * raw bytes; a multi-chunk feed is a {@link ContentFeedManifest} in the base SOC
 * plus `pages` data SOCs. Returns null if the base or any page is absent (a torn /
 * incomplete write). `baseId`/`pageIdFor` select versioned vs legacy identifiers.
 */
export async function assembleContentFeed(
  read: SocChunkReader,
  baseId: Uint8Array,
  pageIdFor: (page: number) => Uint8Array,
): Promise<Uint8Array | null> {
  const raw = await read(baseId);
  if (!raw) return null;

  let head: unknown;
  try {
    head = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return raw; // not JSON (shouldn't happen for our feeds) — hand back as-is
  }
  if (!isContentFeedManifest(head)) return raw; // single-chunk feed
  if (head.pages < 1 || head.pages > 256) return null; // bound the loop (≤ 1 MB)

  const parts: Uint8Array[] = [];
  for (let i = 1; i <= head.pages; i++) {
    const page = await read(pageIdFor(i));
    if (!page) return null; // a missing page ⇒ incomplete; treat as not-found
    parts.push(page);
  }
  const full = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { full.set(p, off); off += p.length; }
  return full;
}

/**
 * Read the latest version of a TOPIC-addressed client content feed via `read`.
 * Probes versioned identifiers first; if none exist, falls back to the legacy
 * pre-versioning fixed identifier (`contentFeedSocIdentifier(topic)` + its
 * `topic/pN` pages) — so a feed written before this fix stays READABLE, and its
 * first edit (which writes version 0) then wins over the legacy chunk with NO
 * re-publish. Returns the raw feed bytes + the resolved version, or null.
 */
export async function readVersionedContentFeed(
  read: SocChunkReader,
  topic: string,
  hint = 0,
): Promise<VersionedFeedRead | null> {
  const base = contentFeedSocIdentifier(topic);
  const baseIdFor = (v: number): Uint8Array => versionedSocIdentifier(base, v);

  const latest = await resolveLatestSocVersion(read, baseIdFor, hint);
  if (latest !== null) {
    const bytes = await assembleContentFeed(
      read,
      baseIdFor(latest),
      (page) => versionedPageIdentifier(base, latest, page),
    );
    return bytes ? { bytes, version: latest } : null;
  }

  // Legacy fallback: the pre-versioning fixed identifier + its topic-string pages.
  const legacy = await assembleContentFeed(
    read,
    base,
    (page) => contentFeedSocIdentifier(contentFeedPageTopic(topic, page)),
  );
  return legacy ? { bytes: legacy, version: LEGACY_CONTENT_FEED_VERSION } : null;
}
