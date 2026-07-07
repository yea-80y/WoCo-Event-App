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
 * SOC), and reads resolve by COMPUTED CHUNK ADDRESS via makeSOCReader (GET
 * /chunks/{addr}), never via /feeds (which 401s anonymously on Etherna). Phase A
 * stays on our own Bee (getBee); the read shape works identically on both.
 */

import { Signature } from "@ethersphere/bee-js";
import {
  calculateCacAddress,
  calculateSocAddress,
  socSignDigest,
  encodeSpan,
  readVersionedContentFeed,
  assembleContentFeed,
  contentFeedSocIdentifier,
  contentFeedPageTopic,
  versionedSocIdentifier,
  versionedPageIdentifier,
  LEGACY_CONTENT_FEED_VERSION,
  type SocChunkReader,
  SOC_IDENTIFIER_SIZE,
  SOC_SIGNATURE_SIZE,
  SOC_MAX_PAYLOAD_SIZE,
} from "@woco/shared";
import { BEE_URL, getBee, requirePostageBatch } from "../../config/swarm.js";
import { BEE_CALL_TIMEOUT_MS, beeUploadSem, withTimeout } from "./upload-queue.js";
import { whitelistHashes } from "./whitelist.js";
import { ensureEthernaToken, getCachedEthernaToken } from "../etherna/auth.js";
import { registerEthernaOffer } from "../etherna/upload.js";

const ETHERNA_GW = process.env.ETHERNA_GATEWAY_URL || "https://gateway.etherna.io";

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
      const socAddress = bytesToHex(calculateSocAddress(identifier, owner));
      // Whitelist the SOC address on the read proxy so ANY device can read it
      // directly from the gateway (GET /chunks/{addr}) — the client reads
      // gateway-first, server-fallback. Non-fatal: the chunk is uploaded
      // regardless, and the server read endpoint covers a whitelist lag.
      if (!etherna) {
        try {
          await whitelistHashes([socAddress]);
          whitelistedSocs.add(socAddress);
        } catch (e) {
          console.warn("[swarm] SOC whitelist failed (non-fatal, server-read fallback covers it):", e);
        }
      } else {
        // Etherna gates anonymous reads behind an OFFER (else 402). Register one for
        // the SOC's chunk address so any device can read it via /chunks/{addr} (and
        // so a feed dereference over this update chunk resolves). Non-fatal — the
        // chunk is stored regardless; a missing offer only blocks anonymous reads.
        // NOTE: no WoCo-gateway whitelist here — Etherna's Beehive cluster does
        // not propagate chunks to the public net our bee retrieves from (verified
        // 2026-07-07: /chunks 200 on Etherna, 404 via our bee), so a whitelist
        // would only convert the gateway's fast 403 into a slow futile search.
        // Reads of Etherna-stamped SOCs resolve via readSocPayload's Etherna
        // fallback below.
        try {
          await registerEthernaOffer(socAddress);
        } catch (e) {
          console.warn("[swarm] Etherna SOC offer failed (non-fatal):", e);
        }
      }
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
 * SOC addresses this process has confirmed whitelisted on the read proxy —
 * dedupes the self-healing whitelist below so hot chunks don't re-POST the
 * proxy admin endpoint on every read.
 */
const whitelistedSocs = new Set<string>();

/**
 * Read a SOC's inline payload by computed chunk address (Etherna-safe). Returns
 * the raw payload bytes, or null if the chunk is not found.
 *
 * SELF-HEALING WHITELIST: a successful read proves the chunk exists and is
 * publicly readable, so we (fire-and-forget) whitelist its address on the
 * gateway proxy. This repairs chunks whose write-time whitelist call failed
 * (it's non-fatal there) — without it those chunks 403 on the gateway forever
 * and every client read pays the server fallback.
 */
export async function readSocPayload(ownerHex: string, identifierHex: string): Promise<Uint8Array | null> {
  let owner: string, identifier: string;
  try {
    owner = bytesToHex(hexToBytes(ownerHex, 20));
    identifier = bytesToHex(hexToBytes(identifierHex, SOC_IDENTIFIER_SIZE));
  } catch {
    const err = new Error("Invalid owner or identifier") as Error & { status: number };
    err.status = 400;
    throw err;
  }
  try {
    const soc = await getBee().makeSOCReader(owner).download(identifier);
    const address = bytesToHex(calculateSocAddress(hexToBytes(identifier), hexToBytes(owner)));
    if (!whitelistedSocs.has(address)) {
      whitelistHashes([address])
        .then(() => whitelistedSocs.add(address))
        .catch(() => undefined);
    }
    return soc.payload.toUint8Array();
  } catch (err: unknown) {
    const status = (err as { status?: number })?.status ?? (err as { response?: { status?: number } })?.response?.status;
    const msg = String((err as Error)?.message ?? "").toLowerCase();
    const bodyMsg = String(
      (err as { responseBody?: Buffer })?.responseBody?.toString() ?? "",
    ).toLowerCase();
    const notFound =
      status === 404 ||
      msg.includes("not found") || msg.includes("404") ||
      // Bee returns 500 "read chunk failed" for chunks that don't exist yet
      (status === 500 && bodyMsg.includes("read chunk failed"));
    if (!notFound) throw err;
    // Etherna-stamped SOCs never reach our bee (Beehive doesn't propagate to the
    // public net) — try Etherna's gateway before declaring the chunk absent.
    return readSocFromEtherna(owner, identifier);
  }
}

/**
 * Read a SOC from the Etherna gateway by computed chunk address, with a bearer
 * token (bypasses the anonymous-read offer gate). The response is UNTRUSTED raw
 * chunk bytes, so the SOC signature is re-verified against the claimed owner and
 * the identifier is checked before the payload is returned. On success the
 * chunk's OFFER is (re-)registered fire-and-forget — self-heals SOCs whose
 * write-time offer failed (non-fatal there), which otherwise 402 for every
 * anonymous reader forever. Returns null when Etherna is unconfigured, the
 * chunk is absent, or verification fails.
 */
async function readSocFromEtherna(ownerHex: string, identifierHex: string): Promise<Uint8Array | null> {
  try {
    await ensureEthernaToken();
  } catch {
    return null;
  }
  const token = getCachedEthernaToken();
  if (!token) return null;

  const ownerBytes = hexToBytes(ownerHex, 20);
  const identifier = hexToBytes(identifierHex, SOC_IDENTIFIER_SIZE);
  const address = bytesToHex(calculateSocAddress(identifier, ownerBytes));

  let raw: Uint8Array;
  try {
    const r = await fetch(`${ETHERNA_GW}/chunks/${address}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    raw = new Uint8Array(await r.arrayBuffer());
  } catch {
    return null;
  }

  // Stored SOC layout: identifier(32) || signature(65) || span(8) || payload(1..4096).
  if (raw.length < SOC_IDENTIFIER_SIZE + SOC_SIGNATURE_SIZE + 8 + 1) return null;
  const id = raw.subarray(0, SOC_IDENTIFIER_SIZE);
  const sig = raw.subarray(SOC_IDENTIFIER_SIZE, SOC_IDENTIFIER_SIZE + SOC_SIGNATURE_SIZE);
  const span = raw.subarray(SOC_IDENTIFIER_SIZE + SOC_SIGNATURE_SIZE, SOC_IDENTIFIER_SIZE + SOC_SIGNATURE_SIZE + 8);
  const payload = raw.subarray(SOC_IDENTIFIER_SIZE + SOC_SIGNATURE_SIZE + 8);
  if (bytesToHex(id) !== bytesToHex(identifier)) return null;
  try {
    const digest = socSignDigest(id, calculateCacAddress(span, payload));
    const recovered = new Signature(sig).recoverPublicKey(digest).address().toHex().toLowerCase();
    if (recovered.replace(/^0x/, "") !== bytesToHex(ownerBytes).toLowerCase()) return null;
  } catch {
    return null;
  }

  registerEthernaOffer(address).catch(() => undefined);
  return payload;
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
// ---------------------------------------------------------------------------

const CFV_TTL_MS = 30_000;
const CFV_ABSENT_TTL_MS = 5_000;

/** version: >=0 versioned, LEGACY_CONTENT_FEED_VERSION legacy chunk, null absent. */
const cfvCache = new Map<string, { version: number | null; at: number }>();

/**
 * Read a client-owned content feed by owner + topic STRING, resolving the latest
 * VERSION of the single-owner sequence feed and reassembling the multi-chunk paged
 * form when present (mirrors the client `readContentFeed`). Probes versioned
 * identifiers first, then falls back to the legacy pre-versioning fixed identifier
 * so feeds written before the versioning fix stay readable. Returns the raw JSON
 * bytes, or null if absent / a page is missing.
 *
 * `versionHint` is an optional lower bound (e.g. a directory-carried feedVersion);
 * the read still probes forward from it, so a stale-low hint only costs a few reads.
 */
export async function readContentFeedJson(
  ownerHex: string,
  baseTopic: string,
  versionHint = 0,
): Promise<Uint8Array | null> {
  const read: SocChunkReader = (id) => readSocPayload(ownerHex, bytesToHex(id));
  const key = `${ownerHex.toLowerCase().replace(/^0x/, "")}:${baseTopic}`;
  const base = contentFeedSocIdentifier(baseTopic);

  const cached = cfvCache.get(key);
  if (cached) {
    const ttl = cached.version === null ? CFV_ABSENT_TTL_MS : CFV_TTL_MS;
    if (Date.now() - cached.at < ttl) {
      if (cached.version === null) return null;
      // Exact-version read: existing chunks only — zero missing-chunk searches.
      const bytes =
        cached.version === LEGACY_CONTENT_FEED_VERSION
          ? await assembleContentFeed(read, base, (p) =>
              contentFeedSocIdentifier(contentFeedPageTopic(baseTopic, p)))
          : await assembleContentFeed(read, versionedSocIdentifier(base, cached.version), (p) =>
              versionedPageIdentifier(base, cached.version as number, p));
      if (bytes) return bytes;
      // Cached version unexpectedly unreadable — drop it and re-probe below.
      cfvCache.delete(key);
    }
  }

  // Probe forward from the best lower bound we have (caller hint vs cached).
  const hint = Math.max(versionHint, cached?.version ?? 0);
  const res = await readVersionedContentFeed(read, baseTopic, hint);
  cfvCache.set(key, { version: res ? res.version : null, at: Date.now() });
  return res?.bytes ?? null;
}

/**
 * Drop the cached latest-version for a topic — called after a same-process write
 * lands a new version so the next read re-probes instead of serving the TTL-stale
 * predecessor.
 */
export function invalidateContentFeedVersion(ownerHex: string, baseTopic: string): void {
  cfvCache.delete(`${ownerHex.toLowerCase().replace(/^0x/, "")}:${baseTopic}`);
}
