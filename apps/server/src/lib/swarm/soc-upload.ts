/**
 * Client-signed Single-Owner-Chunk (SOC) stamp+upload + read (Phase A of
 * CLIENT_FEED_SIGNER_HANDOVER.md).
 *
 * The client OWNS the SOC key and signs the chunk locally; the server only holds
 * the postage batch, so it STAMPS and UPLOADS the pre-signed chunk. Before
 * stamping, the server independently re-derives the content-addressed (CAC)
 * address from the submitted span+payload and verifies the client's signature
 * recovers to the claimed owner over `concat(identifier, cacAddress)` — so it can
 * never be tricked into stamping bytes the owner didn't sign. Bee re-validates the
 * signature on upload too (defence in depth).
 *
 * Authorization rule: ANY authenticated user may stamp their OWN validly-signed
 * SOC. The SOC owner is a key the client controls (for the recovery envelope, a
 * PRF-derived key that is NOT the parent address), so we cannot bind owner ==
 * authenticated parent. Abuse is bounded by (a) auth-gating the endpoint, (b) the
 * signature-must-verify check, and (c) postage cost. Reads are unauthenticated —
 * SOCs are public on Swarm and the envelope payload is HPKE-sealed (useless
 * without the passkey).
 *
 * Etherna-safe by construction: the payload is carried INLINE (never a ref-style
 * SOC), and reads resolve by COMPUTED CHUNK ADDRESS (GET /chunks/{addr}, through
 * the verified reader in soc-read.ts), never via /feeds (which 401s anonymously
 * on Etherna). The read shape works identically on both stores.
 */

import { Signature } from "@ethersphere/bee-js";
import {
  calculateCacAddress,
  calculateSocAddress,
  socSignDigest,
  encodeSpan,
  readVersionedContentFeed,
  type VersionedFeedRead,
  assembleContentFeed,
  contentFeedSocIdentifier,
  resolveOpenBand,
  LAST_VERSION_IN_BAND,
  contentFeedPageTopic,
  versionedSocIdentifier,
  versionedPageIdentifier,
  LEGACY_CONTENT_FEED_VERSION,
  FEED_FAMILY_STORES,
  type FeedFamily,
  type FeedStore,
  type SocChunkProbe,
  type SocReadOutcome,
  SOC_IDENTIFIER_SIZE,
  SOC_SIGNATURE_SIZE,
  SOC_MAX_PAYLOAD_SIZE,
} from "@woco/shared";
import { BEE_URL, requirePostageBatch } from "../../config/swarm.js";
import { BEE_CALL_TIMEOUT_MS, beeUploadSem, withTimeout } from "./upload-queue.js";
import { whitelistHashes } from "./whitelist.js";
import { markHealed, readVerifiedSoc } from "./soc-read.js";
import { ensureEthernaToken, getCachedEthernaToken } from "../etherna/auth.js";
import { registerEthernaOffer } from "../etherna/upload.js";
import { observeStatementBytes } from "../social/participants.js";
import { ETHERNA_FETCH_BASE } from "../etherna/gateway.js";

const ETHERNA_GW = ETHERNA_FETCH_BASE;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const HEX_RE = /^[0-9a-fA-F]+$/;

function hexToBytes(hex: string, expectedLen?: number): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length === 0 || clean.length % 2 !== 0 || !HEX_RE.test(clean)) {
    throw new Error("invalid hex");
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  if (expectedLen !== undefined && bytes.length !== expectedLen) {
    throw new Error(`expected ${expectedLen} bytes, got ${bytes.length}`);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export interface SignedSocInput {
  /** Owner Ethereum address (hex, 20 bytes; with or without 0x). */
  owner: string;
  /** SOC identifier (hex, 32 bytes). */
  identifier: string;
  /** secp256k1 SOC signature (hex, 65 bytes). */
  signature: string;
  /** Little-endian uint64 span (hex, 8 bytes) — MUST equal encodeSpan(payload.length). */
  span: string;
  /** Inline chunk payload (hex, 1..4096 bytes). */
  payload: string;
}

export interface SocReference {
  /** Lowercased owner address (no 0x). */
  owner: string;
  /** SOC identifier (hex, no 0x). */
  identifier: string;
  /** The SOC's own Swarm address keccak256(identifier||owner) (hex, no 0x). */
  address: string;
}

/** Where a validated client-signed SOC gets stamped (default: WoCo platform batch). */
export interface SocUploadDestination {
  target: "wocoBee" | "etherna";
  batchId: string;
}

/**
 * Validate a client-signed SOC and, if sound, stamp + upload it. Destination
 * defaults to our Bee + platform batch; an Etherna destination posts the SAME
 * wire format (`POST /soc/{owner}/{id}?sig=`, body = span||payload — verified by
 * `writeEthernaFeedUpdate`) to the Etherna gateway with a bearer token + the
 * routed (per-user) batch. Validation is destination-independent: the signature
 * gate runs before any postage is spent either way.
 * Throws `Error` with a `status` field for client-side (400) validation faults.
 */
/**
 * Whitelist a SOC address on the read proxy, and REFUSE THE WRITE if we cannot.
 *
 * Retries because the proxy shares a compose stack with bee and a transient
 * blip should not fail a rider's lap. Gives up loudly rather than quietly: a
 * write we cannot make readable is a write we should not claim succeeded.
 */
async function whitelistBeforeUpload(socAddress: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await whitelistHashes([socAddress]);
      return;
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  const err = new Error(
    `Could not whitelist ${socAddress} for public reads — refusing the write, because an ` +
    `unwhitelisted chunk reads as ABSENT to clients and an absent read is indistinguishable ` +
    `from an empty feed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  ) as Error & { status?: number };
  err.status = 503;
  throw err;
}

export async function uploadSignedSoc(input: SignedSocInput, dest?: SocUploadDestination): Promise<SocReference> {
  let owner: Uint8Array, identifier: Uint8Array, signature: Uint8Array, span: Uint8Array, payload: Uint8Array;
  try {
    owner = hexToBytes(input.owner, 20);
    identifier = hexToBytes(input.identifier, SOC_IDENTIFIER_SIZE);
    signature = hexToBytes(input.signature, SOC_SIGNATURE_SIZE);
    span = hexToBytes(input.span, 8);
    payload = hexToBytes(input.payload);
  } catch (e) {
    const err = new Error(`Invalid SOC field: ${(e as Error).message}`) as Error & { status: number };
    err.status = 400;
    throw err;
  }

  if (payload.length < 1 || payload.length > SOC_MAX_PAYLOAD_SIZE) {
    const err = new Error(`SOC payload must be 1..${SOC_MAX_PAYLOAD_SIZE} bytes`) as Error & { status: number };
    err.status = 400;
    throw err;
  }
  // Span MUST describe the payload length — otherwise the signed CAC address
  // wouldn't match the bytes we upload, and the chunk would be unreadable.
  if (bytesToHex(span) !== bytesToHex(encodeSpan(payload.length))) {
    const err = new Error("SOC span does not match payload length") as Error & { status: number };
    err.status = 400;
    throw err;
  }

  // Re-derive the CAC address and verify the signature recovers to `owner` over
  // concat(identifier, cacAddress). This is the gate: a mismatched owner/payload
  // is rejected before any postage is spent.
  const cacAddress = calculateCacAddress(span, payload);
  const digest = socSignDigest(identifier, cacAddress);
  let recovered: string;
  try {
    recovered = new Signature(signature).recoverPublicKey(digest).address().toHex().toLowerCase();
  } catch {
    const err = new Error("SOC signature is malformed") as Error & { status: number };
    err.status = 400;
    throw err;
  }
  const ownerHex = bytesToHex(owner).toLowerCase();
  if (recovered.replace(/^0x/, "") !== ownerHex) {
    const err = new Error("SOC signature does not match owner") as Error & { status: number };
    err.status = 400;
    throw err;
  }

  const socAddress = bytesToHex(calculateSocAddress(identifier, owner));

  // WHITELIST BEFORE UPLOAD, AND FATALLY. Both halves are load-bearing.
  //
  // BEFORE, because the client may now treat a whitelist refusal as "this chunk
  // does not exist" (the proxy tags its denial; see gate-denial.ts). If the
  // chunk lands first and the whitelist call then fails, we have published a
  // chunk that every non-thorough reader will read as ABSENT — and an absent
  // read is `clean`, so it sails past every `scanClean`/`bandClean` guard and a
  // read-modify-write erases the snapshot it could not see. Whitelisting first
  // inverts the failure: the leftover is a whitelisted address with no chunk,
  // which reaches bee and yields a genuine, already-trusted 404.
  //
  // FATALLY, because it used to be a `console.warn` justified by "the server
  // read endpoint covers a whitelist lag" — the exact fallback the client no
  // longer takes. On 2026-08-20 that swallow hid 50 rate-limited failures in
  // six hours, and those chunks were readable only because a server-fallback
  // read repaired each one on the way past. That repair path is now rare.
  //
  // NOT after the upload with a throw, which was the tempting shape: that mints
  // an ORPHAN (chunk exists, client told "failed"), the client retries, its
  // thorough probe finds the orphan as latest, and the rider gets two laps for
  // one ride.
  await whitelistBeforeUpload(socAddress);

  // Body = span || payload (the CAC bytes); signature rides in the ?sig= query.
  const body = new Uint8Array(span.length + payload.length);
  body.set(span);
  body.set(payload, span.length);
  const identifierHex = bytesToHex(identifier);
  const sigHex = bytesToHex(signature);
  const etherna = dest?.target === "etherna";
  const gwBase = etherna ? ETHERNA_GW : BEE_URL;
  const url = `${gwBase}/soc/${ownerHex}/${identifierHex}?sig=${sigHex}`;

  let ethernaToken: string | null = null;
  if (etherna) {
    await ensureEthernaToken();
    ethernaToken = getCachedEthernaToken();
    if (!ethernaToken) throw new Error("Etherna token unavailable");
  }

  let delay = 500;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      // Hold the semaphore only for the HTTP call, never across the back-off
      // sleep below (mirrors bytes.ts so a throttled slot frees immediately).
      const release = await beeUploadSem.acquire();
      let resp: Response;
      try {
        resp = await withTimeout(
          fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/octet-stream",
              "Swarm-Postage-Batch-Id": dest?.batchId ?? requirePostageBatch(),
              ...(etherna
                ? { Authorization: `Bearer ${ethernaToken}` }
                : {
                    // Buffer locally + push in the BACKGROUND, returning immediately —
                    // exactly like the legacy feed/bytes writes (bytes.ts, feeds.ts).
                    // Without this, Bee defaults to a SYNCHRONOUS upload that blocks
                    // until the chunk is pushed to the network (~25-30s observed),
                    // which was the entire publish-step-1→2 regression. The chunk is
                    // readable from this node immediately, so server-side reads
                    // (register-on-chain) and the whitelisted gateway read still work.
                    // Etherna manages its own upload pipeline, so it's WoCo-only.
                    "Swarm-Deferred-Upload": "true",
                  }),
            },
            body,
          }),
          BEE_CALL_TIMEOUT_MS,
          "soc upload",
        );
      } finally {
        release();
      }
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        const e = new Error(`Bee SOC upload ${resp.status}: ${text.slice(0, 200)}`) as Error & { status?: number };
        // 429 / 5xx are transient; surface other 4xx immediately as a 502.
        if (!(resp.status === 429 || resp.status >= 500)) e.status = 502;
        throw e;
      }
      // Already whitelisted above, before the upload. Only the read path's
      // bookkeeping is updated here, so its self-heal does not re-ask.
      markHealed("wocoBee", socAddress);
      if (etherna) {
        // Etherna gates anonymous reads behind an OFFER (else 402). Register one for
        // the SOC's chunk address so any device can read it from Etherna's own
        // gateway. Non-fatal — the chunk is stored regardless; a missing offer only
        // blocks anonymous reads there, and the next server read of it retries.
        try {
          await registerEthernaOffer(socAddress);
          markHealed("etherna", socAddress);
        } catch (e) {
          console.warn("[swarm] Etherna SOC offer failed (non-fatal):", e);
        }
      }
      // Learn who to read later. The identifier is a hash, so the topic cannot
      // be inverted from it — but a PUBLIC statement's payload names its own
      // format and subject, which is everything needed to recompute the topic.
      // Sealed payloads are refused there by an explicit shape check, NOT by
      // being unreadable: a SealedBox is ordinary JSON and parses fine (see
      // `looksSealed`). Bookkeeping for a view-plane cache — never awaited, and
      // it must never fail a user's write.
      observeStatementBytes(ownerHex, payload);
      return { owner: ownerHex, identifier: identifierHex, address: socAddress };
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string; status?: number };
      const transient =
        e?.status === undefined &&
        (e?.code === "ETIMEDOUT" ||
          /429|socket hang up|network|timeout/i.test(String(e?.message ?? "")) ||
          ["ECONNRESET", "ECONNABORTED", "EAI_AGAIN"].includes(String(e?.code ?? "")));
      // 429/5xx errors are thrown without a `status` (only true 4xx get status=502).
      const beeTransient = /\b(429|5\d\d)\b/.test(String(e?.message ?? "")) && e?.status === undefined;
      if ((transient || beeTransient) && attempt < 4) {
        await wait(delay);
        delay = Math.min(delay * 2, 5000);
        continue;
      }
      throw err;
    }
  }
  throw new Error("SOC upload failed after retries");
}

/**
 * The probe every server scan uses: the verified reader, asked the sources the
 * caller's FAMILY names in the shared table (#657). Tri-state all the way down -
 * a source that cannot answer is `unavailable`, which clears the scan's `clean`
 * flag instead of ending it on a false "absent". Only a malformed owner or
 * identifier throws.
 */
function scanProbe(ownerHex: string, family: FeedFamily): SocChunkProbe {
  return async (id) => {
    const res = await readVerifiedSoc(ownerHex, bytesToHex(id), { family });
    return res.status === "found" ? { status: "found", bytes: res.soc.payload } : res;
  };
}

/** Version 0 of a topic, read exactly - for the write-once slots the campaign
 *  issuer treats as the record. */
export async function readVersion0(ownerHex: string, topic: string, family: FeedFamily): Promise<SocReadOutcome> {
  return scanProbe(ownerHex, family)(versionedSocIdentifier(contentFeedSocIdentifier(topic), 0));
}

// ---------------------------------------------------------------------------
// Latest-version cache for content-feed reads.
//
// Resolving "latest" ends with a probe of a version that does NOT exist — a bee
// network search that takes seconds and queues behind every other retrieval.
// Versions are immutable and contiguous, so a recently-resolved version is safe
// to read EXACTLY (worst case: stale by the TTL — same freshness contract as the
// directory cache). Absent feeds get a much shorter TTL so a publish-then-read
// flow (client signs SOC v0, then register-on-chain reads it back) isn't blocked
// by a stale negative.
//
// Keyed by STORE as well as feed: a verdict reached without asking Etherna says
// nothing about what Etherna holds, so it must never answer a read that would
// have asked it.
// ---------------------------------------------------------------------------

const CFV_TTL_MS = 30_000;
const CFV_ABSENT_TTL_MS = 5_000;

/** version: >=0 versioned, LEGACY_CONTENT_FEED_VERSION legacy chunk, null absent. */
const cfvCache = new Map<string, { version: number | null; at: number }>();

function cfvKey(store: FeedStore, ownerHex: string, baseTopic: string): string {
  return `${store}:${ownerHex.toLowerCase().replace(/^0x/, "")}:${baseTopic}`;
}

/**
 * Banded variant: resolve which band of a feed family is open, then read its
 * head. This is the indexer's half of the banding scheme — an independent
 * indexer has to derive band topics the same way a rider does, or it addresses
 * the wrong chunks.
 *
 * No band cache of its own. Band openers are cheap HITS (a band opens only when
 * its predecessor is full, so every opener below the head exists), and the
 * per-band version cache below still applies once the band is known. If a rider
 * ever accumulates enough bands for the walk to matter, cache the band the same
 * way `cfvCache` caches the version.
 */
export async function readBandedContentFeedJsonResult(
  ownerHex: string,
  topicForBand: (band: number) => string,
  family: FeedFamily,
): Promise<VersionedFeedRead & { band: number }> {
  const open = await resolveOpenBand(scanProbe(ownerHex, family), topicForBand);
  // A walk that could not ask every opener has not shown the band is empty.
  if (!open.exists) {
    return open.clean
      ? { status: "absent", band: open.band }
      : { status: "unavailable", reason: "band walk inconclusive", band: open.band };
  }
  // Statement feeds postdate versioning, so a legacy chunk cannot exist. The
  // indexer walks every participant, and an absent participant would otherwise
  // cost one guaranteed missing-chunk search EACH.
  // The ceiling matters more here than on a client: the indexer reads EVERY
  // participant's feed on every pass, so probing v64/v65 of each full band cost
  // two missing-chunk searches per participant per pass — on the shared node.
  // Versions above the last slot cannot exist in a banded feed by construction.
  const res = await readContentFeedJsonResult(ownerHex, topicForBand(open.band), family, {
    skipLegacy: true,
    maxVersion: LAST_VERSION_IN_BAND,
  });
  // A walk that stopped early may have stopped below the open band, so the head
  // it read is a lower bound however clean its own scan was.
  if (res.status === "found" && !open.clean) return { ...res, scanClean: false, band: open.band };
  return { ...res, band: open.band };
}

/**
 * Read a content feed by owner + topic STRING, resolving the latest VERSION of
 * the single-owner sequence feed and reassembling the multi-chunk paged form when
 * present (mirrors the client `readContentFeed`). Probes versioned identifiers
 * first, then falls back to the legacy pre-versioning fixed identifier so feeds
 * written before the versioning fix stay readable.
 *
 * Three answers, never two. Absent means the feed holds nothing; unavailable
 * means a source could not be asked. The difference points opposite ways for an
 * AUTHORISATION gate (absent: the caller may claim the name; unavailable: refuse,
 * #181) and for a WRITER (absent: write version 0; unavailable: the next version
 * cannot be known). A `found` from a scan that could not ask every question
 * carries `scanClean: false`: its version is a lower bound, not the head.
 *
 * `family` is REQUIRED: it decides which sources are asked (#657). A read of an
 * Etherna-stamped family that skips Etherna misses a version still on its way to
 * our bee and resolves the one before it as current.
 *
 * `versionHint` is an optional lower bound (e.g. a directory-carried
 * feedVersion); the read still probes forward from it, so a stale-low hint only
 * costs a few reads.
 */
export async function readContentFeedJsonResult(
  ownerHex: string,
  baseTopic: string,
  family: FeedFamily,
  /** `skipLegacy` / `maxVersion`: statement rails only — see
   *  {@link readBandedContentFeedJsonResult}. Events, profiles and sites predate
   *  versioning and DO have legacy chunks, so this must stay opt-in rather than
   *  becoming the default.
   *
   *  `fresh`: never answer from the cached version, only start the scan there.
   *  For a read whose result someone will SIGN as the next version (#657): a
   *  write relayed since the cache entry - the organiser's own client re-signing
   *  a moment ago - does not invalidate it, so the cached "clean" version can be
   *  one behind, and a feed built on it erases the one in between. */
  opts: { versionHint?: number; skipLegacy?: boolean; maxVersion?: number; fresh?: boolean } = {},
): Promise<VersionedFeedRead> {
  const read = scanProbe(ownerHex, family);
  const key = cfvKey(FEED_FAMILY_STORES[family], ownerHex, baseTopic);
  const base = contentFeedSocIdentifier(baseTopic);

  const cached = cfvCache.get(key);
  if (cached && !opts.fresh) {
    const ttl = cached.version === null ? CFV_ABSENT_TTL_MS : CFV_TTL_MS;
    if (Date.now() - cached.at < ttl) {
      if (cached.version === null) return { status: "absent" };
      // Exact-version read: existing chunks only — zero missing-chunk searches.
      const asm =
        cached.version === LEGACY_CONTENT_FEED_VERSION
          ? await assembleContentFeed(read, base, (p) =>
              contentFeedSocIdentifier(contentFeedPageTopic(baseTopic, p)))
          : await assembleContentFeed(read, versionedSocIdentifier(base, cached.version), (p) =>
              versionedPageIdentifier(base, cached.version as number, p));
      // `scanClean: true` is honest here ONLY because a dirty scan is never
      // cached (see below). No scan ran on this path — the version is read
      // exactly — so the flag reports the resolution that produced the cached
      // version, not a fresh verdict.
      if (asm.status === "found") {
        return { status: "found", bytes: asm.bytes, version: cached.version, scanClean: true };
      }
      // Cached version unexpectedly unreadable — drop it and re-probe below.
      cfvCache.delete(key);
    }
  }

  // Probe forward from the best lower bound we have (caller hint vs cached).
  const hint = Math.max(opts.versionHint ?? 0, cached?.version ?? 0);
  const res = await readVersionedContentFeed(read, baseTopic, hint, {
    skipLegacy: opts.skipLegacy,
    maxVersion: opts.maxVersion,
  });
  // Only a definitive answer may be cached. Caching an `unavailable` as absent
  // would serve "this feed does not exist" for the whole TTL off one bad read.
  //
  // And only a CLEAN scan's version, for the same reason one step further in: a
  // dirty scan's latest is a lower BOUND, not the latest. Caching it would serve
  // a stale version for the whole TTL and — worse — the exact-version path above
  // would hand it back flagged clean, laundering "could not ask" into a verdict.
  if (res.status === "found" && res.scanClean) cfvCache.set(key, { version: res.version, at: Date.now() });
  else if (res.status === "absent") cfvCache.set(key, { version: null, at: Date.now() });
  return res;
}

/**
 * Drop the cached latest-version for a topic — called after a same-process write
 * lands a new version so the next read re-probes instead of serving the TTL-stale
 * predecessor. Every store's entry, since the write may be read by any route.
 */
export function invalidateContentFeedVersion(ownerHex: string, baseTopic: string): void {
  for (const store of ["etherna", "woco"] as const satisfies readonly FeedStore[]) {
    cfvCache.delete(cfvKey(store, ownerHex, baseTopic));
  }
}
