import { FeedIndex, type Topic } from "@ethersphere/bee-js";
import zlib from "node:zlib";
import { getBee, getPlatformSigner, getPlatformOwner, requirePostageBatch } from "../../config/swarm.js";
import { BEE_CALL_TIMEOUT_MS, beeUploadSem, withTimeout } from "./upload-queue.js";
import type { BatchSelection } from "../etherna/batch-router.js";
import { writeEthernaFeedPage } from "../etherna/upload.js";
import { decideFeedWriteRetry } from "./feed-write-retry.js";
import { feedSources, firstFreeIndex, readFeedUpdate, type FeedDest } from "./feed-index.js";
import { ethernaSource, wocoBeeSource } from "./soc-read.js";

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
// Feed index cache — eliminates the lookup round-trip on most writes
// ---------------------------------------------------------------------------
//
// A feed lookup (`GET /feeds/{owner}/{topic}`) is the dominant cost of a write
// (1.5–4.5s observed in production logs), so we cache each topic's next write
// index and pass it explicitly to the upload.
//
// The cache must never move BACKWARDS on a read (#186). A lookup is a lower
// bound (`feed-index.ts`): our bee sees a new update late - seconds to minutes
// for an Etherna write - and in that window reports the previous one. A read
// that lowered the cache made the next write land on a taken index, which keeps
// the old bytes and answers 201: the edit was lost with success reported. Taking
// the higher of the two would be wrong the other way: if our last write really
// was lost, every later one would land past a hole the lookup never walks over.
// So a lower read only DISPUTES the entry, and the next write checks at the
// destination whether our last write is there before trusting it.
//
// Per-topic mutex serialises writes. Server restart loses the cache; the first
// write per topic resolves its index from the destination. Another process
// writing the same feeds with the same key (a dev server on the production bee)
// is caught by the read-back after each write, not by this cache.
interface FeedIndexEntry {
  next: bigint;
  /** The destination a write or a resolution there confirmed `next` at; null =
   *  only a read of our bee said so, which may be behind. */
  confirmedAt: FeedDest | null;
  /** A read reported a lower next index. Checked before the next write. */
  disputed: boolean;
}
const feedNextIndex = new Map<string, FeedIndexEntry>();
const feedTopicLock = new Map<string, Promise<unknown>>();

/**
 * Read-your-writes (#186). A read-modify-write that builds on bee's lagging copy
 * erases the edit made just before it, even when the write lands at the right
 * index. So for a while after writing, a read that bee answers with an older
 * update - or not at all - gets the page this server wrote. Generalises the
 * site events index's own copy (#824, `lib/site/events-index.ts`), same window.
 */
export const READ_YOUR_WRITES_MS = 120_000;
const writtenPages = new Map<string, { index: bigint; page: Uint8Array; at: number }>();
let now = () => Date.now();

let feedWriteBaseBackoffMs = 500;

/** Tests only — collapse the retry backoff, pin the clock, and read/clear the caches. */
export const __feedWriteTestHooks = {
  setBaseBackoffMs(ms: number): void {
    feedWriteBaseBackoffMs = ms;
  },
  setClock(fn: (() => number) | null): void {
    now = fn ?? (() => Date.now());
  },
  cachedNextIndex(topic: Topic): bigint | undefined {
    return feedNextIndex.get(topicKey(topic))?.next;
  },
  cachedEntry(topic: Topic): Readonly<FeedIndexEntry> | undefined {
    const e = feedNextIndex.get(topicKey(topic));
    return e ? { ...e } : undefined;
  },
  clearCache(): void {
    feedNextIndex.clear();
    writtenPages.clear();
  },
};

function topicKey(topic: Topic): string {
  return topic.toHex();
}

function platformOwnerHex(): string {
  return getPlatformOwner().toHex().replace(/^0x/, "").toLowerCase();
}

/** A read saw `next` as the next index: fill or raise, never lower (see above). */
function noteReadIndex(key: string, next: bigint): void {
  const e = feedNextIndex.get(key);
  if (!e || next > e.next) feedNextIndex.set(key, { next, confirmedAt: null, disputed: false });
  else if (next < e.next) e.disputed = true;
}

/** The page this server wrote within the window, or null. */
function freshWrittenPage(key: string): { index: bigint; page: Uint8Array } | null {
  const w = writtenPages.get(key);
  if (!w) return null;
  if (now() - w.at >= READ_YOUR_WRITES_MS) {
    writtenPages.delete(key);
    return null;
  }
  return w;
}

function rememberWrittenPage(key: string, index: bigint, page: Uint8Array): void {
  if (writtenPages.size >= 512) {
    for (const [k, w] of writtenPages) if (now() - w.at >= READ_YOUR_WRITES_MS) writtenPages.delete(k);
  }
  writtenPages.set(key, { index, page: page.slice(), at: now() });
}

type FeedLookup =
  /** `index`/`next` are absent only when bee sent no index headers (bee-js always
   *  sets them; a test double may not). Unknown is never noted, never preferred. */
  | { status: "ok"; data: Uint8Array; index?: bigint; next?: bigint }
  | { status: "absent" }
  | { status: "error"; error: Error };

function errorStatus(err: unknown): number | undefined {
  const e = err as { status?: number; response?: { status?: number } } | undefined;
  return e?.status ?? e?.response?.status;
}

/** Bee's JSON error message from a bee-js response error, or "". */
function beeErrorMessage(err: unknown): string {
  const body = (err as { responseBody?: unknown } | undefined)?.responseBody;
  let text = "";
  if (typeof body === "string") text = body;
  else if (body instanceof ArrayBuffer) text = new TextDecoder().decode(body);
  else if (body instanceof Uint8Array) text = new TextDecoder().decode(body);
  else if (body && typeof body === "object") return String((body as { message?: unknown }).message ?? "");
  try {
    const m = (JSON.parse(text) as { message?: unknown }).message;
    return typeof m === "string" ? m : "";
  } catch {
    return "";
  }
}

/**
 * `GET /feeds` on our bee, three answers. Bee answers 404 both for a feed with no
 * update ("no update found") and for a walk that FAILED ("lookup at failed",
 * `pkg/api/feed.go`). Only the first is absent: reading the second as absent let
 * a bee hiccup bootstrap an empty index over a live one. Any other 404 is checked
 * against index 0 directly, so a reworded message costs a read, never a wipe.
 */
async function lookupFeed(topic: Topic, ownerHex: string): Promise<FeedLookup> {
  try {
    const reader = getBee().makeFeedReader(topic, ownerHex);
    const result = await withTimeout(reader.downloadPayload(), BEE_CALL_TIMEOUT_MS, `feed read ${topic.toHex().slice(0, 16)}`);
    const r = result as { feedIndex?: FeedIndex; feedIndexNext?: FeedIndex };
    const bytes = toBytes(result);
    if (!bytes) return { status: "error", error: new Error("Feed payload empty or unparseable") };
    return { status: "ok", data: bytes, index: r.feedIndex?.toBigInt(), next: r.feedIndexNext?.toBigInt() };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (errorStatus(err) !== 404) return { status: "error", error };
    if (beeErrorMessage(err) === "no update found") return { status: "absent" };
    const first = await readFeedUpdate(ownerHex, topic, 0n, feedSources("woco"));
    return first.status === "absent" ? { status: "absent" } : { status: "error", error };
  }
}

/** A read of our bee: note the index it saw, and prefer what we just wrote. */
async function readFeedForCaller(topic: Topic): Promise<FeedLookup> {
  const key = topicKey(topic);
  const res = await lookupFeed(topic, platformOwnerHex());
  if (res.status === "ok" && res.next !== undefined) noteReadIndex(key, res.next);
  else if (res.status === "absent") noteReadIndex(key, 0n);
  const mine = freshWrittenPage(key);
  if (mine && (res.status !== "ok" || (res.index !== undefined && res.index < mine.index))) {
    return { status: "ok", data: mine.page.slice(), index: mine.index, next: mine.index + 1n };
  }
  return res;
}

export async function readFeedPage(topic: Topic): Promise<Uint8Array | null> {
  try {
    const res = await readFeedForCaller(topic);
    return res.status === "ok" ? res.data : null;
  } catch {
    return null;
  }
}

/**
 * Discriminated result for write-path reads.
 *  - "ok":     payload returned, safe to use as the prior state of the feed.
 *  - "absent": feed has never been written (bee "no update found"). Safe to bootstrap.
 *  - "error":  anything else (transient network, 5xx, a failed lookup, parse
 *              failure). The caller MUST NOT proceed to a write that would
 *              overwrite the feed's prior contents — doing so would clobber
 *              every entry the read failed to retrieve. Throw, retry later, abort.
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
    const res = await readFeedForCaller(topic);
    return res.status === "ok" ? { status: "ok", data: res.data } : res;
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err : new Error(String(err)) };
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
  // 423 = Etherna/Bee per-bucket postage-stamp lock held by a concurrent write
  // to the same batch — clears when the contending write releases (see bytes.ts).
  if (status === 429 || status === 423) return true;
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
  /** Caller knows this topic has never been written to. Skips index resolution
   *  and writes directly at index 0 — saves the lookup-then-404 round-trip
   *  on every fresh-feed write (event creation, new editions pages). If index 0
   *  turns out to hold another update, the write throws. */
  fresh?: boolean;
  /** Sent as `swarm-deferred-upload`. Bee 2.7.1 ignores it on `/soc`, which every
   *  feed update uses: the upload is pushed to its storer before the 201 either
   *  way (`pkg/api/soc.go`). Kept for the callers that state they need a write
   *  readable on the next request. Ignored for an Etherna dest. */
  deferred?: boolean;
  /** Routes which batch PAYS for this page (docs/PLATFORM_SIGNER_AUDIT.md
   *  § batch routing). `target:"etherna"` writes the update SOC via the Etherna
   *  gateway with `dest.batchId`; absent/wocoBee ⇒ local bee + platform batch,
   *  unchanged. Signing (always the platform key) and READS (always our own
   *  bee — stamped chunks propagate to the public net) are unaffected. Only for
   *  COLD single-page feeds: never purchase-path feeds (claims, collections,
   *  directory) and never paged feeds (pages 0..N-1 would keep the old batch
   *  and die with it — the audit's straddle landmine).
   *
   *  OUTSIDE the content-feed family table (#657): these are platform-signed
   *  bee FEEDS, not versioned content feeds, and their reads ask our bee only.
   *  So an Etherna dest has the window a moved family has - our bee sees the
   *  newest update seconds to minutes late - during which a read returns the
   *  previous update. The index cache and read-your-writes above are what keep
   *  that window from losing an edit (#186). */
  dest?: BatchSelection;
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
  // An update's payload is its page, inline. A larger one would be wrapped by
  // bee-js and could never match its own read-back.
  if (page.length > 4096) throw new Error(`feed page is ${page.length} bytes, max 4096`);
  const etherna = options.dest?.target === "etherna";
  const dest: FeedDest = etherna ? "etherna" : "woco";
  const owner = platformOwnerHex();
  // Always an explicit index. bee-js's own discovery (`findNextIndex`) answers 0
  // for ANY bee error, 5xx included, and a write at a taken 0 is silently kept.
  let index = options.fresh ? 0n : await resolveWriteIndex(topic, key, dest);

  const MAX_ATTEMPTS = 5;
  let delay = feedWriteBaseBackoffMs;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const release = await beeUploadSem.acquire();
      try {
        if (etherna) {
          await withTimeout(
            writeEthernaFeedPage({
              topic,
              index,
              payload: page,
              batchId: options.dest!.batchId,
              signer: getPlatformSigner(),
              ownerHex: owner,
            }),
            BEE_CALL_TIMEOUT_MS,
            `etherna feed write ${key.slice(0, 16)}`,
          );
        } else {
          const writer = getBee().makeFeedWriter(topic, getPlatformSigner());
          await withTimeout(
            writer.uploadPayload(requirePostageBatch(), page, {
              index: FeedIndex.fromBigInt(index),
              deferred: options.deferred ?? true,
            }),
            BEE_CALL_TIMEOUT_MS,
            `feed write ${key.slice(0, 16)}`,
          );
        }
      } finally {
        release();
      }
    } catch (err: unknown) {
      const status = errorStatus(err);
      const decision = decideFeedWriteRetry({
        status,
        transient: isTransientFeedError(err),
        attempt,
        maxAttempts: MAX_ATTEMPTS,
        etherna,
        fresh: !!options.fresh,
      });
      switch (decision.action) {
        case "retry-transient": {
          const reason = (err as any)?.message ?? (err as any)?.code ?? status;
          console.log(`[swarm] Feed write transient error (${reason}), retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS})...`);
          await new Promise((r) => setTimeout(r, delay));
          delay = Math.min(delay * 2, 5000);
          continue;
        }
        case "rediscover-index":
          console.warn(`[swarm] Feed write 409 conflict — re-discovering index for ${key.slice(0, 16)}...`);
          feedNextIndex.delete(key);
          index = await resolveFeedNextIndex(topic, owner, dest);
          await new Promise((r) => setTimeout(r, delay));
          delay = Math.min(delay * 2, 5000);
          continue;
        case "throw":
          throw err;
      }
    }

    // Read back what is at the index now. A 201 is not evidence our bytes are
    // there: a taken index keeps the update already on it (another process
    // writing these feeds with the same key, or a lookup that read behind).
    // Outside the upload semaphore - a read must not hold up other uploads.
    const landed = await readFeedUpdate(owner, topic, index, etherna ? [ethernaSource] : [wocoBeeSource]);
    if (landed.status === "found" && !sameBytes(landed.soc.payload, page)) {
      if (options.fresh) throw new Error(`feed ${key.slice(0, 16)}: written as fresh but index 0 already holds an update`);
      console.warn(`[swarm] Feed ${key.slice(0, 16)}: index ${index} already held another update — writing past it`);
      feedNextIndex.delete(key);
      index = await firstFreeIndex(owner, topic, index + 1n, feedSources(dest));
      continue;
    }
    // Found with our bytes: confirmed. Not found or not askable: the upload was
    // accepted, so take it, and have the next write check it is still there.
    feedNextIndex.set(key, { next: index + 1n, confirmedAt: dest, disputed: landed.status !== "found" });
    rememberWrittenPage(key, index, page);
    return;
  }
  throw new Error(`feed ${key.slice(0, 16)}: no free index after ${MAX_ATTEMPTS} attempts`);
}

/** The cached index when this destination confirmed it and no read disputes it;
 *  a disputed one when our last write is still where we put it; else resolve. */
async function resolveWriteIndex(topic: Topic, key: string, dest: FeedDest): Promise<bigint> {
  const e = feedNextIndex.get(key);
  if (e && e.confirmedAt === dest) {
    if (!e.disputed) return e.next;
    if (e.next > 0n) {
      const last = await readFeedUpdate(platformOwnerHex(), topic, e.next - 1n, feedSources(dest));
      if (last.status === "found") {
        e.disputed = false;
        return e.next;
      }
    }
    // Gone (our write was lost: refill the hole, not past it) or cannot tell.
  }
  return resolveFeedNextIndex(topic, platformOwnerHex(), dest);
}

/**
 * The next free index of `owner`'s feed at `dest`: our bee's lookup as the start,
 * then forward to the first index nothing holds (`feed-index.ts`). Throws when
 * the lookup or a chunk read cannot answer; callers refuse rather than guess.
 * Exported for the client-owned site pointer feed (`routes/sites.ts`).
 */
export async function resolveFeedNextIndex(topic: Topic, ownerHex: string, dest: FeedDest): Promise<bigint> {
  const owner = ownerHex.replace(/^0x/, "").toLowerCase();
  const head = await lookupFeed(topic, owner);
  if (head.status === "error") throw head.error;
  return firstFreeIndex(owner, topic, head.status === "ok" ? head.next ?? 0n : 0n, feedSources(dest));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
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
