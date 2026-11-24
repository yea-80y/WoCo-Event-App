/**
 * Keeping a receipt in the buyer's account, then erasing the server's copy
 * (spec-receipt-note 5.1-5.2). The one rule this file exists for: the server's copy is
 * erased ONLY after the account's own copy has READ BACK from Swarm. A save that could
 * not be confirmed leaves the server's copy where it is, and a later visit finishes it.
 *
 * The erase is signed by the order's pickup key (from the secret), never sent with a
 * session, so it links no account to the ticket.
 */
import type { HoldingBoxV1 } from "@woco/shared/holding/box";
import type { EraseResult } from "../api/holdings.js";
import { saveHoldingCopy, type HoldingFeedIO, type HoldingGenKeys, type SaveResult } from "./account-copy.js";

export interface KeepDeps {
  io: HoldingFeedIO;
  erase(pickupId: string, issuedAt: number, sig: string): Promise<EraseResult>;
  /** Milliseconds. */
  now(): number;
}

export interface KeepOutcome {
  saved: SaveResult;
  /** "not-yet": the save did not read back, so nothing was asked of the server. */
  erase: EraseResult | "not-yet";
}

/** The live I/O, loaded on first use. */
export async function liveKeepDeps(): Promise<KeepDeps> {
  const [{ liveHoldingFeedIO }, { erasePickup }] = await Promise.all([import("./holding-io.js"), import("../api/holdings.js")]);
  return { io: liveHoldingFeedIO, erase: erasePickup, now: () => Date.now() };
}

/** Save the order's receipts under `keys` (the account's CURRENT generation), then erase the server's copy. */
export async function keepInAccount(keys: HoldingGenKeys, r: Uint8Array, box: HoldingBoxV1, deps: KeepDeps): Promise<KeepOutcome> {
  // Throws for a box that is not this order's (`saveHoldingCopy` checks it): nothing erased.
  const saved = await saveHoldingCopy(keys, r, box, deps.io);
  if (saved !== "saved") return { saved, erase: "not-yet" };
  return { saved, erase: await eraseServerCopy(r, deps) };
}

/** Ask the server to erase its copy, signed by the order's pickup key. */
export async function eraseServerCopy(r: Uint8Array, deps: Pick<KeepDeps, "erase" | "now">): Promise<EraseResult> {
  const [{ holdingPickupId, holdingPickupSigner }, { signErasePickup }] = await Promise.all([
    import("@woco/shared/holding/derive"),
    import("@woco/shared/holding/pickup"),
  ]);
  const pickupId = holdingPickupId(r);
  const issuedAt = Math.floor(deps.now() / 1000);
  const key = holdingPickupSigner(r).privateKey;
  try {
    return await deps.erase(pickupId, issuedAt, signErasePickup(pickupId, issuedAt, key));
  } finally {
    key.fill(0);
  }
}
