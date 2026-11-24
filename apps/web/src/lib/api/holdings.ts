/**
 * `/api/holdings` - collecting a ticket receipt from the server's copy, and erasing that
 * copy (spec-receipt-note 5.2; server `routes/holdings.ts`).
 *
 * Pickup and erase are UNAUTHENTICATED on purpose: no session headers, so neither links
 * an account to the ticket. Knowing the order's secret is the only authority - the pickup
 * id and the erase signature both come from it. The pickup id travels in the body, never
 * the URL, which reaches access logs. `mineHoldings` is the one signed call (5.1): the
 * account's own signed-in sales, already linked to it.
 *
 * Only the route's own `code` says "not found" or "refused" (`HOLDING_API_CODES`): a bare
 * 404 or 403 - a proxy, a CDN error page, a server that predates the route - is "later".
 * Each call gives up after `TIMEOUT_MS`, so a stalled connection never leaves a screen
 * waiting for ever.
 */
import type { SealedBoxV2 } from "@woco/shared/crypto/sealed-box-shape";
import { isSealedBoxV2 } from "@woco/shared/crypto/sealed-box-shape";
import { HOLDING_API_CODES } from "@woco/shared/holding/api-codes";
import { post } from "./http.js";

const ROOT_RE = /^[0-9a-f]{64}$/;
const TIMEOUT_MS = 20_000;

export type PickupResult =
  /** `box` only while the server still waits to store it; otherwise read it from Swarm by `boxRoot`. */
  | { kind: "ok"; boxRoot: string; box?: SealedBoxV2 }
  /** No receipt with that id: never one, not paid, or erased. */
  | { kind: "not-found" }
  /** Could not ask now (offline, busy, or the server could not read its records). */
  | { kind: "later" };

export async function pickupHolding(pickupId: string): Promise<PickupResult> {
  let res;
  try {
    res = await post<{ boxRoot?: unknown; box?: unknown }>("/api/holdings/pickup", { pickupId }, undefined, { timeoutMs: TIMEOUT_MS });
  } catch {
    return { kind: "later" };
  }
  if (res.status === 404 && res.code === HOLDING_API_CODES.NOT_FOUND) return { kind: "not-found" };
  const d = res.data;
  if (!res.ok || !d || typeof d.boxRoot !== "string" || !ROOT_RE.test(d.boxRoot)) return { kind: "later" };
  if (d.box !== undefined && !isSealedBoxV2(d.box)) return { kind: "later" };
  return d.box === undefined ? { kind: "ok", boxRoot: d.boxRoot } : { kind: "ok", boxRoot: d.boxRoot, box: d.box as SealedBoxV2 };
}

export type EraseResult =
  /** The server's copy is gone (or going: an erase is resumable, and the server finishes it). */
  | "erased"
  /** Nothing there to erase: already erased, never paid, or never ours. */
  | "gone"
  /** The receipt is being saved on the server right now: try again in a minute. */
  | "busy"
  /** The signature was refused - most often this device's clock is more than 5 minutes out. */
  | "refused"
  /** Could not erase now: try again later. */
  | "later";

/** One of the signed-in account's own sales the server still holds a receipt for. */
export interface MineHolding {
  pickupId: string;
  /** The order's secret, sealed to the account's order key when it was bought. */
  sealedR: SealedBoxV2;
  boxRoot: string;
  /** Only while the box waits on the server to be stored; otherwise read it from Swarm by `boxRoot`. */
  box?: SealedBoxV2;
}

export type MineResult =
  /** `complete` false: the server could not read every record, so the list may be short. */
  | { kind: "ok"; holdings: MineHolding[]; complete: boolean }
  | { kind: "later" };

/**
 * The account's own signed-in sales whose receipts are still on the server
 * (`POST /api/holdings/mine`). Session-signed - the one receipt call that is: the server
 * already links these sales to the account (it was signed in when it bought), so
 * asking adds nothing. Never starts a sign-in: no session here = "later". A row that is
 * not well formed is dropped and the list called incomplete. `send`: a test seam.
 */
export async function mineHoldings(send: SignedPost = signedPost): Promise<MineResult> {
  let res;
  try {
    res = await withTimeout(send("/api/holdings/mine"));
  } catch {
    return { kind: "later" };
  }
  const d = res.ok ? res.data : undefined;
  if (!d || !Array.isArray(d.holdings) || typeof d.complete !== "boolean") return { kind: "later" };
  let complete = d.complete;
  const holdings: MineHolding[] = [];
  for (const row of d.holdings as Record<string, unknown>[]) {
    const ok =
      !!row && typeof row === "object" &&
      typeof row.pickupId === "string" && ROOT_RE.test(row.pickupId) &&
      typeof row.boxRoot === "string" && ROOT_RE.test(row.boxRoot) &&
      isSealedBoxV2(row.sealedR) &&
      (row.box === undefined || isSealedBoxV2(row.box));
    if (!ok) {
      complete = false;
      continue;
    }
    holdings.push({
      pickupId: row.pickupId as string,
      sealedR: row.sealedR as SealedBoxV2,
      boxRoot: row.boxRoot as string,
      ...(row.box === undefined ? {} : { box: row.box as SealedBoxV2 }),
    });
  }
  return { kind: "ok", holdings, complete };
}

type SignedPost = (path: string) => Promise<{ ok: boolean; data?: { holdings?: unknown; complete?: unknown } }>;

/** Session-signed, and never a new sign-in. Loaded on use: the Keep page's calls carry no session. */
const signedPost: SignedPost = async (path) => {
  const { authPost } = await import("./client.js");
  return authPost<{ holdings?: unknown; complete?: unknown }>(path, {}, undefined, { establish: false });
};

/** `authPost` has no timeout of its own: a stalled call must not hold a background job for ever. */
function withTimeout<T>(p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), TIMEOUT_MS);
    p.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export async function erasePickup(pickupId: string, issuedAt: number, sig: string): Promise<EraseResult> {
  let res;
  try {
    res = await post<{ erased?: unknown }>("/api/holdings/pickup/erase", { pickupId, issuedAt, sig }, undefined, { timeoutMs: TIMEOUT_MS });
  } catch {
    return "later";
  }
  if (res.ok && res.data?.erased === true) return "erased";
  if (res.status === 404 && res.code === HOLDING_API_CODES.NOT_FOUND) return "gone";
  if (res.status === 409 && res.code === HOLDING_API_CODES.STORING) return "busy";
  if (res.status === 403 && res.code === HOLDING_API_CODES.ERASE_REFUSED) return "refused";
  return "later";
}
