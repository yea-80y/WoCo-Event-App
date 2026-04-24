import type { Topic } from "@ethersphere/bee-js";
import { getBee, getPlatformSigner, getPlatformOwner, requirePostageBatch } from "../../config/swarm.js";

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

export async function readFeedPage(topic: Topic): Promise<Uint8Array | null> {
  try {
    const reader = getBee().makeFeedReader(topic, getPlatformOwner());
    const result = await reader.downloadPayload();
    return toBytes(result);
  } catch {
    return null;
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
export async function writeFeedPage(topic: Topic, page: Uint8Array): Promise<void> {
  let delay = 500;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const writer = getBee().makeFeedWriter(topic, getPlatformSigner());
      await writer.uploadPayload(requirePostageBatch(), page);
      return;
    } catch (err: unknown) {
      const status = (err as any)?.status ?? (err as any)?.response?.status;
      if (status === 429 && attempt < 4) {
        console.log(`[swarm] Feed write rate limited, retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 5000);
        continue;
      }
      // If the feed's current chunk is missing (404), try writing at index 0 (fresh)
      if (status === 404 && attempt === 0) {
        console.warn(`[swarm] Feed chunk missing (404), resetting feed at index 0...`);
        try {
          const writer2 = getBee().makeFeedWriter(topic, getPlatformSigner());
          await writer2.uploadPayload(requirePostageBatch(), page, { index: 0 });
          return;
        } catch (resetErr) {
          console.error(`[swarm] Feed reset also failed:`, resetErr instanceof Error ? resetErr.message : resetErr);
        }
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
 */
export function encodeJsonFeed(data: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(data));
  if (json.length > 4096) {
    throw new RangeError(`JSON feed data exceeds 4096 bytes (${json.length}). Reduce entries before encoding.`);
  }
  const page = new Uint8Array(4096);
  page.set(json);
  return page;
}

export function decodeJsonFeed<T>(page: Uint8Array): T | null {
  try {
    let end = page.length;
    for (let i = 0; i < page.length; i++) {
      if (page[i] === 0) { end = i; break; }
    }
    return JSON.parse(new TextDecoder().decode(page.subarray(0, end)));
  } catch {
    return null;
  }
}
