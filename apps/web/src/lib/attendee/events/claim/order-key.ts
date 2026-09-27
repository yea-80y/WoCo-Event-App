/**
 * The organiser's order key for checkout: fetched by the event's `encryptionKeyRef`
 * and verified against it (#642, `@woco/shared` event/order-key.ts).
 *
 * Read from the WoCo gateway only. Etherna sends no CORS headers, so a browser
 * cannot fetch from it; the key chunk is stamped on the WoCo batch at create even
 * for Etherna events, precisely so this read has somewhere to go.
 *
 * Cached per ref for the page's life: the chunk is content-addressed, so the bytes
 * behind a ref can never change. A failure is NOT cached — the next call retries.
 */

import { fetchOrderKey } from "@woco/shared";
import { WOCO_GATEWAY_URL } from "../../../swarm/gateways.js";

const cache = new Map<string, Promise<Uint8Array>>();

export function loadOrderKey(ref: string): Promise<Uint8Array> {
  let pending = cache.get(ref);
  if (!pending) {
    pending = fetchOrderKey(ref, WOCO_GATEWAY_URL);
    cache.set(ref, pending);
    pending.catch(() => {
      if (cache.get(ref) === pending) cache.delete(ref);
    });
  }
  return pending;
}
