/**
 * A sealed order as fetched from a gateway, checked before anything trusts it (#965).
 *
 * The order's root is the Swarm content address of its exact bytes, and the
 * server's misattribution argument rests on that (apps/server/src/lib/stripe/order-ref.ts):
 * the box's sealing context binds only the event and the series, so a box served
 * under ANOTHER root of the same series would open fine and show one buyer's
 * details on another buyer's ticket. Hashing the bytes back to the root is what
 * makes "the box for this ticket" true whatever served it - a gateway, a CDN, a
 * cache, or a bundle (Fable consult 2026-11-02).
 *
 * A mismatch is "unavailable", not "unreadable": what a source SERVED was wrong,
 * which says nothing about the order itself - another fetch may serve it right.
 */
import { bytesTreeRoot } from "@woco/shared/swarm/bytes-tree";
import type { SealedBoxV2 } from "@woco/shared/crypto/sealed-box-shape";
import type { FetchResult } from "./detail-queue.js";

/** A sealed order is at most 16 KB of JSON (MAX_ORDER_BOX_JSON); anything far past it is not one. */
export const MAX_BOX_BYTES = 64 * 1024;

const decoder = new TextDecoder("utf-8", { fatal: true });

/** The order at `root` from these bytes, or why not. Never throws. */
export function boxFromBytes(root: string, bytes: Uint8Array): FetchResult {
  if (bytes.length === 0 || bytes.length > MAX_BOX_BYTES) return { kind: "unreadable" };
  let address: string;
  try {
    address = bytesTreeRoot(bytes);
  } catch {
    return { kind: "unreadable" };
  }
  if (address !== root.toLowerCase()) return { kind: "unavailable" };
  try {
    const box = JSON.parse(decoder.decode(bytes)) as { enc?: unknown; ct?: unknown };
    return typeof box.enc === "string" && typeof box.ct === "string"
      ? { kind: "ok", box: box as unknown as SealedBoxV2 }
      : { kind: "unreadable" };
  } catch {
    return { kind: "unreadable" };
  }
}
