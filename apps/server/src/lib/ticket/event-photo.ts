/**
 * The event photo for a ticket email: the hero image and the photo on each
 * ticket image. Read once per email from the same content gateways the ticket
 * page uses.
 *
 * NEVER THROWS and never waits long: the email this decorates is a ticket
 * someone paid for. A missing, slow, oversized or unrecognised image returns
 * null and the ticket goes out without it.
 */

import { TICKET_IMAGE_GATEWAYS } from "@woco/shared";

export interface EventPhoto {
  bytes: Buffer;
  mime: "image/jpeg" | "image/png" | "image/gif";
}

/** Per-gateway wait. Two gateways at most, so a dead image costs ~8 s in all. */
export const PHOTO_TIMEOUT_MS = 4_000;
/** Larger images are skipped: each ticket image embeds the photo, and the email has a size limit. */
export const PHOTO_MAX_BYTES = 1_500_000;

const HASH_RE = /^[0-9a-f]{64}$/;

/** What the bytes are, from their first bytes; null for anything else. */
export function sniffPhoto(bytes: Uint8Array): EventPhoto["mime"] | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  return null;
}

/** The body, or null as soon as it passes `max` bytes: a missing or false
 *  Content-Length must not let a response be buffered whole. */
async function readCapped(res: Response, max: number): Promise<Buffer | null> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Decoding costs ~4 bytes a pixel whatever the file size: a small file can
 *  claim a huge image. Above these, no photo. */
export const PHOTO_MAX_PIXELS = 24_000_000;
export const PHOTO_MAX_SIDE = 6000;

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** Width and height from the file header, or null when they cannot be read. */
export function photoDimensions(bytes: Uint8Array, mime: EventPhoto["mime"]): { width: number; height: number } | null {
  const u16be = (i: number) => (bytes[i] << 8) | bytes[i + 1];
  if (mime === "image/png") {
    if (bytes.length < 24) return null;
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: v.getUint32(16), height: v.getUint32(20) };
  }
  if (mime === "image/gif") {
    if (bytes.length < 10) return null;
    return { width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) };
  }
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    if (SOF.has(marker)) {
      if (i + 8 >= bytes.length) return null;
      return { height: u16be(i + 5), width: u16be(i + 7) };
    }
    i += 2 + u16be(i + 2);
  }
  return null;
}

export interface EventPhotoDeps {
  fetch: typeof fetch;
}

export async function fetchEventPhoto(
  hash: string | undefined,
  preferredGateway: number,
  deps: EventPhotoDeps = { fetch },
): Promise<EventPhoto | null> {
  if (!hash || !HASH_RE.test(hash) || /^0+$/.test(hash)) return null;
  const order = [preferredGateway, ...TICKET_IMAGE_GATEWAYS.keys()].filter(
    (g, i, all) => g >= 0 && g < TICKET_IMAGE_GATEWAYS.length && all.indexOf(g) === i,
  );
  for (const g of order) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PHOTO_TIMEOUT_MS);
    try {
      const res = await deps.fetch(`${TICKET_IMAGE_GATEWAYS[g]}/bytes/${hash}`, { signal: ctrl.signal });
      if (!res.ok) continue;
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (declared > PHOTO_MAX_BYTES) return null;
      const bytes = await readCapped(res, PHOTO_MAX_BYTES);
      if (!bytes) return null;
      if (bytes.length === 0) continue;
      const mime = sniffPhoto(bytes);
      if (!mime) return null;
      const dims = photoDimensions(bytes, mime);
      if (!dims || dims.width < 1 || dims.height < 1) return null;
      if (dims.width > PHOTO_MAX_SIDE || dims.height > PHOTO_MAX_SIDE || dims.width * dims.height > PHOTO_MAX_PIXELS) return null;
      return { bytes, mime };
    } catch {
      // timeout or network: try the next gateway
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}
