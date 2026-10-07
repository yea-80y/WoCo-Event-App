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
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length === 0) continue;
      if (bytes.length > PHOTO_MAX_BYTES) return null;
      const mime = sniffPhoto(bytes);
      return mime ? { bytes, mime } : null;
    } catch {
      // timeout or network: try the next gateway
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}
