import { FeedIndex, type Topic } from "@ethersphere/bee-js";
import zlib from "node:zlib";
import { getBee, getPlatformSigner, getPlatformOwner, requirePostageBatch } from "../../config/swarm.js";
import { ensureEthernaToken } from "../etherna/auth.js";
import { beeUploadSem } from "./upload-queue.js";

// ---------------------------------------------------------------------------
// Binary packing (128 slots x 32 bytes = 4096 bytes)
// ---------------------------------------------------------------------------

function hexToBytes32(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytes32ToHex(bytes: Uint8Array, offset: number): string {
  let h = "";
  for (let j = 0; j < 32; j++) h += bytes[offset + j].toString(16).padStart(2, "0");
  return h;
}

function isZeroSlot(bytes: Uint8Array, offset: number): boolean {
  for (let j = 0; j < 32; j++) if (bytes[offset + j] !== 0) return false;
  return true;
}

/** Pack hex refs into a 4096-byte binary page. */
export function pack4096(refs: string[]): Uint8Array {
  const page = new Uint8Array(4096);
  const count = Math.min(refs.length, 128);
  for (let i = 0; i < count; i++) page.set(hexToBytes32(refs[i]), i * 32);
  return page;
}

/** Decode binary page to hex refs. Stops at first zero slot. */
export function decode4096(page: Uint8Array): string[] {
  const refs: string[] = [];
  for (let i = 0; i < 128; i++) {
    const off = i * 32;
    if (isZeroSlot(page, off)) break;
    refs.push(bytes32ToHex(page, off));
  }
  return refs;
}

/** Decode claims page - returns all 128 slots (empty string if zero). */
export function decode4096Claims(page: Uint8Array): string[] {
  const refs: string[] = [];
  for (let i = 0; i < 128; i++) {
    const off = i * 32;
    refs.push(isZeroSlot(page, off) ? "" : bytes32ToHex(page, off));
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Bee-js response helper
// ---------------------------------------------------------------------------

/** Extract Uint8Array from bee-js response (handles multiple formats). */
function toBytes(res: unknown): Uint8Array | null {
  if (!res) return null;
  if (res instanceof Uint8Array) return res;
  if (typeof res !== "object") return null;

  const r = res as Record<string, unknown>;

  // payload.toBytes() / payload.bytes / payload as Uint8Array
  const payload = r["payload"];
  if (payload instanceof Uint8Array) return payload;
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    if (typeof p["toBytes"] === "function") return (p["toBytes"] as () => Uint8Array)();
    if (p["bytes"] instanceof Uint8Array) return p["bytes"] as Uint8Array;
  }

  // Direct data / bytes properties
  if (r["data"] instanceof Uint8Array) return r["data"] as Uint8Array;
  if (r["bytes"] instanceof Uint8Array) return r["bytes"] as Uint8Array;

  return null;
}

// ---------------------------------------------------------------------------
// Feed read / write
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Feed index cache — eliminates findNextIndex round-trip on every write
// ---------------------------------------------------------------------------
//
// Every `writeFeedPage` call without a hint forces bee-js to call
// `findNextIndex`, which does `GET /feeds/{owner}/{topic}` against Bee. That
// lookup is the dominant cost of a write (1.5–4.5s observed in production
// logs — same path that surfaces "lookup at failed" warnings in bee-node).
//
// All feeds are written by the single platform signer, so we control all
// index increments. We cache the next-write index per topic and pass it
// explicitly to `uploadPayload({ index })`, skipping the lookup entirely.
//
// Cache is primed for free by `readFeedPage` (every read returns the current
// index in headers). Per-topic mutex serialises concurrent writes so the
// cached value never races with itself. Server restart loses the cache; the
// next read or first write rebuilds it. If multiple writers ever sign the
// same feed (Swarm ID), this cache must be revisited per-signer.
const feedNextIndex = new Map<string, bigint>();
const feedTopicLock = new Map<string, Promise<unknown>>();

function topicKey(topic: Topic): string {
  return topic.toHex();
}

function rememberNextIndex(topic: Topic, next: FeedIndex | bigint | undefined): void {
  if (next === undefined) return;
  const value = typeof next === "bigint" ? next : next.toBigInt();
  feedNextIndex.set(topicKey(topic), value);
}

export async function readFeedPage(topic: Topic): Promise<Uint8Array | null> {
  try {
    await ensureEthernaToken();
    const reader = getBee().makeFeedReader(topic, getPlatformOwner());
    const result = await reader.downloadPayload();
    // Prime the write-index cache from the read response so subsequent writes
    // skip findNextIndex.
    const next = (result as { feedIndexNext?: FeedIndex })?.feedIndexNext;
    if (next) rememberNextIndex(topic, next);
    return toBytes(result);
  } catch {
    return null;
  }
}

/**
 * Discriminated result for write-path reads.
 *  - "ok":     payload returned, safe to use as the prior state of the feed.
 *  - "absent": feed has never been written (Bee 404). Safe to bootstrap.
 *  - "error":  anything else (transient network, 5xx, parse failure). The
 *              caller MUST NOT proceed to a write that would overwrite the
 *              feed's prior contents — doing so would clobber every entry
 *              the read failed to retrieve. Throw, retry later, abort.
 *
 * `readFeedPage` (above) collapses all three into `null`, which is fine for
 * read endpoints that fall through to "show nothing" UX. Write paths that
 * read-modify-write a directory MUST use the strict variant.
 */
export type FeedReadStrictResult =
  | { status: "ok"; data: Uint8Array }
  | { status: "absent" }
  | { status: "error"; error: Error };

export async function readFeedPageStrict(topic: Topic): Promise<FeedReadStrictResult> {
  try {
    await ensureEthernaToken();
    const reader = getBee().makeFeedReader(topic, getPlatformOwner());
    const result = await reader.downloadPayload();
    const next = (result as { feedIndexNext?: FeedIndex })?.feedIndexNext;
    if (next) rememberNextIndex(topic, next);
    const bytes = toBytes(result);
    if (!bytes) {
      return { status: "error", error: new Error("Feed payload empty or unparseable") };
    }
    return { status: "ok", data: bytes };
  } catch (err) {
    const status = (err as { status?: number; response?: { status?: number } })?.status
      ?? (err as { status?: number; response?: { status?: number } })?.response?.status;
    // Only 404 from the feed lookup means "feed has never been written".
    // Anything else (5xx, network, parse) is indistinguishable from a
    // transient failure — treating it as absent would let a hiccup wipe
    // the directory on the next write.
    if (status === 404) return { status: "absent" };
    return {
      status: "error",
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

export async function readFeedPageWithRetry(
  topic: Topic,
  maxRetries = 5,
  initialDelayMs = 1000,
): Promise<Uint8Array | null> {
  let delay = initialDelayMs;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await readFeedPage(topic);
    if (result) return result;
    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, 5000);
    }
  }
  return null;
}

// TODO(swarm-id): writeFeedPage is the single choke point for all feed writes.
// Today every feed is signed by the platform signer (FEED_PRIVATE_KEY). When
// Swarm ID lands, the organiser's per-event signer (derived via BIP-44 from a
// dedicated account — NEVER the parent wallet that holds funds) will be passed
// in here. Accept an optional `signer` argument and default to the platform
// signer for back-compat. All callers above (events, claims, profile, etc.)
// need to thread the signer through from the auth layer.
function isTransientFeedError(err: unknown): boolean {
  const e = err as any;
  const status: number | undefined = e?.status ?? e?.response?.status;
  if (status === 429) return true;
  if (status && status >= 500) return true;
  if (status === undefined) {
    const msg = String(e?.message ?? "").toLowerCase();
    const code = String(e?.code ?? "").toUpperCase();
    if (msg.includes("socket hang up") || msg.includes("network") || msg.includes("timeout")) return true;
    if (["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNABORTED", "ECONNREFUSED", "EPIPE"].includes(code)) return true;
  }
  return false;
}

export interface WriteFeedPageOptions {
  /** Caller knows this topic has never been written to. Skips findNextIndex
   *  and writes directly at index 0 — saves the lookup-then-404 round-trip
   *  on every fresh-feed write (event creation, new editions pages). */
  fresh?: boolean;
}

export async function writeFeedPage(
  topic: Topic,
  page: Uint8Array,
  options: WriteFeedPageOptions = {},
): Promise<void> {
  // Serialise per-topic so the cached next-index never races. Errors are
  // absorbed in the chain so one failure doesn't poison the next caller.
  const key = topicKey(topic);
  const prev = feedTopicLock.get(key) ?? Promise.resolve();
  const task = prev
    .catch(() => undefined)
    .then(() => doWriteFeedPage(topic, key, page, options));
  feedTopicLock.set(key, task.catch(() => undefined));
  return task;
}

async function doWriteFeedPage(
  topic: Topic,
  key: string,
  page: Uint8Array,
  options: WriteFeedPageOptions,
): Promise<void> {
  await ensureEthernaToken();
  // Resolve the next index without paying for findNextIndex when avoidable.
  let nextIndex: bigint | undefined;
  if (options.fresh) {
    // Application asserts this is a brand-new topic. Skip the round-trip.
    nextIndex = 0n;
  } else {
    nextIndex = feedNextIndex.get(key);
    // Cache miss: fall through to bee-js's internal findNextIndex on first
    // call (uploadPayload without an index). Subsequent writes will hit the
    // cache because we record the index post-upload.
  }

  let delay = 500;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const writer = getBee().makeFeedWriter(topic, getPlatformSigner());
      const uploadOpts: { index?: FeedIndex; deferred?: boolean } = {
        // `swarm-deferred-upload: true` — Bee buffers locally and pushes to
        // the network in the background. Without this, the upload blocks
        // until the chunk has been pushed to neighbourhood peers, which
        // turns every feed write into a wait for network sync.
        deferred: true,
      };
      if (nextIndex !== undefined) {
        uploadOpts.index = FeedIndex.fromBigInt(nextIndex);
      }
      const release = await beeUploadSem.acquire();
      try {
        await writer.uploadPayload(requirePostageBatch(), page, uploadOpts);
      } finally {
        release();
      }
      // Record the next index to write — successor of what we just wrote.
      const used = nextIndex ?? 0n; // if cache miss + fresh-feed, bee-js wrote at 0
      feedNextIndex.set(key, used + 1n);
      return;
    } catch (err: unknown) {
      const status = (err as any)?.status ?? (err as any)?.response?.status;
      if (isTransientFeedError(err) && attempt < 4) {
        const reason = (err as any)?.message ?? (err as any)?.code ?? status;
        console.log(`[swarm] Feed write transient error (${reason}), retrying in ${delay}ms (attempt ${attempt + 1}/5)...`);
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 5000);
        continue;
      }
      // 404 from the feed chunk lookup (rare) — drop the cache and retry at
      // index 0. Stops a stale cached index from permanently breaking writes.
      if (status === 404 && attempt === 0) {
        console.warn(`[swarm] Feed chunk missing (404), resetting feed at index 0...`);
        feedNextIndex.delete(key);
        nextIndex = 0n;
        continue;
      }
      // Conflict (409 = chunk already exists at this index) — cache went
      // stale (e.g. first write since restart used a wrong cached value).
      // Clear cache so the next call re-discovers via findNextIndex.
      if (status === 409) {
        console.warn(`[swarm] Feed write 409 conflict — clearing cached index for ${key.slice(0, 16)}...`);
        feedNextIndex.delete(key);
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// JSON feed helpers (pad to 4096, trim nulls on read)
// ---------------------------------------------------------------------------

/**
 * Encode JSON data into a 4096-byte feed page.
 * MUST stay at exactly 4096 bytes — bee-js uses a broken upload→download
 * path for data > 4096 that fails on some Bee node configurations.
 *
 * Format:
 *  - First byte 0x7b ('{') or 0x5b ('[') → uncompressed JSON, null-padded (legacy).
 *  - First byte 0x01 → gzipped JSON. Bytes 1-2: BE uint16 payload length.
 *    Bytes 3..3+len: gzip stream. Used only when raw JSON exceeds 4096 bytes,
 *    so existing small feeds remain plain-text inspectable on the gateway.
 */
const COMPRESSED_MAGIC = 0x01;

export function encodeJsonFeed(data: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(data));
  const page = new Uint8Array(4096);

  if (json.length <= 4096) {
    page.set(json);
    return page;
  }

  const compressed = zlib.gzipSync(Buffer.from(json), { level: 9 });
  const maxPayload = 4096 - 3;
  if (compressed.length > maxPayload) {
    throw new RangeError(
      `JSON feed data still exceeds 4096 bytes after gzip (raw=${json.length}, gzipped=${compressed.length}). Reduce entries before encoding.`,
    );
  }
  page[0] = COMPRESSED_MAGIC;
  page[1] = (compressed.length >> 8) & 0xff;
  page[2] = compressed.length & 0xff;
  page.set(compressed, 3);
  return page;
}

export function decodeJsonFeed<T>(page: Uint8Array): T | null {
  try {
    if (page.length === 0) return null;
    if (page[0] === COMPRESSED_MAGIC) {
      const len = (page[1] << 8) | page[2];
      if (len <= 0 || len > page.length - 3) return null;
      const compressed = page.subarray(3, 3 + len);
      const json = zlib.gunzipSync(Buffer.from(compressed), { maxOutputLength: 1 << 20 });
      return JSON.parse(json.toString("utf8"));
    }
    let end = page.length;
    for (let i = 0; i < page.length; i++) {
      if (page[i] === 0) { end = i; break; }
    }
    return JSON.parse(new TextDecoder().decode(page.subarray(0, end)));
  } catch {
    return null;
  }
}
