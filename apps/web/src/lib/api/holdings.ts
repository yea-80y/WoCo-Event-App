/**
 * `/api/holdings` - collecting a ticket receipt from the server's copy, and erasing that
 * copy (spec-receipt-note 5.2; server `routes/holdings.ts`).
 *
 * Both calls are UNAUTHENTICATED on purpose: no session headers, so neither links an
 * account to the ticket. Knowing the order's secret is the only authority - the pickup id
 * and the erase signature both come from it. The pickup id travels in the body, never the
 * URL, which reaches access logs.
 */
import type { SealedBoxV2 } from "@woco/shared/crypto/sealed-box-shape";
import { isSealedBoxV2 } from "@woco/shared/crypto/sealed-box-shape";
import { post } from "./http.js";

const ROOT_RE = /^[0-9a-f]{64}$/;

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
    res = await post<{ boxRoot?: unknown; box?: unknown }>("/api/holdings/pickup", { pickupId });
  } catch {
    return { kind: "later" };
  }
  if (res.status === 404) return { kind: "not-found" };
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

export async function erasePickup(pickupId: string, issuedAt: number, sig: string): Promise<EraseResult> {
  let res;
  try {
    res = await post<{ erased?: unknown }>("/api/holdings/pickup/erase", { pickupId, issuedAt, sig });
  } catch {
    return "later";
  }
  if (res.ok && res.data?.erased === true) return "erased";
  if (res.status === 404) return "gone";
  if (res.status === 409) return "busy";
  if (res.status === 403) return "refused";
  return "later";
}
