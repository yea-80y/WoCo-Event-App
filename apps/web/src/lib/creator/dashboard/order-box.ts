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

/** Roots per bundled read (our gateway's POST /bytes-bundle refuses more). */
export const BUNDLE_MAX_ROOTS = 100;
const MAX_BUNDLE_HEADER = 64 * 1024;

/** The largest body a bundle of `n` roots can honestly be: refuse anything bigger unread. */
export function bundleBodyLimit(n: number): number {
  return 4 + MAX_BUNDLE_HEADER + n * MAX_BOX_BYTES;
}

const BUNDLE_STATUS = new Set(["ok", "not-whitelisted", "not-found", "too-large", "error"]);

/**
 * Each root's answer in a /bytes-bundle response body (u32be header length, header
 * JSON, blobs), or null when the body is not exactly an answer to `roots` - one item
 * per root, in order, every blob accounted for - in which case nothing in it is used.
 * An "ok" blob still has to hash to its root (`boxFromBytes`); a refused or failed
 * root is retried, a missing one is final.
 */
export function parseBundle(roots: readonly string[], body: Uint8Array): Map<string, FetchResult> | null {
  if (body.length < 4) return null;
  const headerLen = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0);
  if (headerLen > MAX_BUNDLE_HEADER || 4 + headerLen > body.length) return null;
  let header: { v?: unknown; items?: unknown };
  try {
    header = JSON.parse(decoder.decode(body.subarray(4, 4 + headerLen)));
  } catch {
    return null;
  }
  const items = header?.items;
  if (header?.v !== 1 || !Array.isArray(items) || items.length !== roots.length) return null;
  const out = new Map<string, FetchResult>();
  let off = 4 + headerLen;
  for (let i = 0; i < items.length; i++) {
    const it = items[i] as { root?: unknown; status?: unknown; len?: unknown } | null;
    if (!it || it.root !== roots[i] || typeof it.status !== "string" || !BUNDLE_STATUS.has(it.status)) return null;
    if (it.status === "ok") {
      const len = it.len;
      if (typeof len !== "number" || !Number.isInteger(len) || len < 0 || len > MAX_BOX_BYTES || off + len > body.length) return null;
      out.set(roots[i], boxFromBytes(roots[i], body.subarray(off, off + len)));
      off += len;
      continue;
    }
    if (it.len !== undefined) return null;
    out.set(
      roots[i],
      it.status === "not-found" ? { kind: "missing" } : it.status === "too-large" ? { kind: "unreadable" } : { kind: "unavailable" },
    );
  }
  return off === body.length ? out : null;
}

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
