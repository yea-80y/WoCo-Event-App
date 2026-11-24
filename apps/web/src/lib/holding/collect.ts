/**
 * Collecting the account's own signed-in receipts (spec-receipt-note 5.1) - what the app
 * does by itself once the account's keys are on the device and confirmed. Never a prompt.
 *
 * For each sale the server still holds a receipt for (`POST /api/holdings/mine`):
 *  - the order's secret is opened with EVERY generation's order key this device holds (a
 *    sale bought before a passkey was removed is sealed to an older one), and must give
 *    the pickup id it is filed under;
 *  - the box comes from the answer while the server still waits to store it, else from
 *    Swarm by its root (`fetchHoldingBox`); checked against the secret and the ticket
 *    ledgers this build knows;
 *  - it is saved under the CONFIRMED-current generation and read back, and only then is
 *    the server's copy erased (`keepInAccount`).
 * A sale whose secret no key here opens is either already in the account - carried by an
 * upgrade to a passkey, which saves but never erases - and then takes the same path with
 * the secret its copy keeps (the copy re-saved and LISTED under the current generation
 * before any erase), or sealed to keys this device does not hold, and is left alone.
 *
 * Nothing is ever dropped: the server's copy stays until a save reads back, and a run that
 * could not finish is tried again at a later unlock.
 *
 * I/O is passed in; `collect-live.ts` binds it to the signed-in account.
 */
import type { HoldingBoxV1 } from "@woco/shared/holding/box";
import type { MineHolding, MineResult } from "../api/holdings.js";
import type { HoldingFeedIO, HoldingGenKeys, SavedHoldingCopies } from "./account-copy.js";
import type { BoxSourceResult } from "./box-source.js";
import type { KeepDeps } from "./keep.js";

export interface CollectDeps {
  mine(): Promise<MineResult>;
  /** Every generation's keys this device holds for the account, newest LAST. */
  gens: HoldingGenKeys[];
  /** The CONFIRMED-current generation's keys; null = not confirmed now, so nothing is saved. */
  current: HoldingGenKeys | null;
  /** The order's box from Swarm by its root, the pickup API as the fallback, opened and checked. */
  fetchBox(r: Uint8Array, boxRoot: string): Promise<BoxSourceResult>;
  io: HoldingFeedIO;
  keep: KeepDeps;
  /**
   * Asked right before EVERY save or erase: still this account, its keys still the
   * current ones (a fresh read, never only the verdict in memory - an erase cannot be
   * taken back), and no upgrade to a passkey begun meanwhile. The live one reads the
   * chain once per run and the rest each time.
   */
  stillCurrent(): Promise<boolean>;
}

export interface CollectReport {
  /** Saved in the account and read back - now, or by an earlier run or an upgrade. */
  saved: number;
  /** Of those, the server's copy now erased (or already gone). */
  erased: number;
  /** Not finished this time: tried again at a later run. */
  left: number;
  /** Never collectable here: a box refused or naming an unknown ledger, or a secret no key here opens. */
  skipped: number;
  /** Everything listed was dealt with, and the server's list was whole. */
  done: boolean;
}

/** The order's secret, opened with whichever generation's key it was sealed to; null when none here opens it. */
export async function openSaleSecret(row: Pick<MineHolding, "pickupId" | "sealedR">, gens: HoldingGenKeys[]): Promise<Uint8Array | null> {
  const [{ openBox, holdingSecretSealContext }, { holdingPickupId }] = await Promise.all([
    import("@woco/shared/crypto/sealed-box"),
    import("@woco/shared/holding/derive"),
  ]);
  const ctx = holdingSecretSealContext(row.pickupId);
  for (const keys of [...gens].reverse()) {
    let r: Uint8Array;
    try {
      r = await openBox(keys.orderSecretKey, row.sealedR, ctx);
    } catch {
      continue;
    }
    // Filed under the id its own secret gives, or it is not this sale's.
    if (r.length === 32 && holdingPickupId(r) === row.pickupId) return r;
    r.fill(0);
  }
  return null;
}

/** The sale's box: the server's own copy while it waits to be stored, else Swarm by its root. */
async function boxOf(r: Uint8Array, row: MineHolding, fetchBox: CollectDeps["fetchBox"]): Promise<BoxSourceResult> {
  if (row.box) {
    const { openHoldingBox, HoldingBoxRefusedError } = await import("@woco/shared/holding/open");
    try {
      return { kind: "ok", ...(await openHoldingBox(r, row.box)), boxRoot: row.boxRoot };
    } catch (e) {
      if (!(e instanceof HoldingBoxRefusedError)) throw e;
    }
  }
  return fetchBox(r, row.boxRoot);
}

async function knownLedger(box: HoldingBoxV1): Promise<boolean> {
  return (await import("./keep-flow.js")).isKnownLedger(box);
}

/**
 * A sale no key here opens: its secret from a copy already in the account, under any
 * generation this device holds - carried there by an upgrade to a passkey, or a save
 * whose list line never landed. Null when there is none; "later" when one could not be
 * read. The sale then takes the SAME path as any other (Fable 3c PR 2, 1): a copy alone is
 * never enough to erase on, since only the current generation's LIST makes a receipt
 * findable again once our copy is gone.
 */
async function secretFromCopy(pickupId: string, deps: CollectDeps): Promise<Uint8Array | null | "later"> {
  const [{ readHoldingCopy }, { hexToBytes }] = await Promise.all([import("./account-copy.js"), import("@noble/hashes/utils.js")]);
  let unsure = false;
  for (const keys of [...deps.gens].reverse()) {
    const copy = await readHoldingCopy(keys, pickupId, deps.io).catch(() => "unavailable" as const);
    if (copy === "unavailable") {
      unsure = true;
      continue;
    }
    if (copy) return hexToBytes(copy.r);
  }
  return unsure ? "later" : null;
}

/** One run over the account's sales on the server. Throws only for a fault in this code; every I/O fault is "left". */
export async function collectReceipts(deps: CollectDeps): Promise<CollectReport> {
  const report: CollectReport = { saved: 0, erased: 0, left: 0, skipped: 0, done: false };
  const mine = await deps.mine();
  if (mine.kind !== "ok") return report;
  const { keepInAccount } = await import("./keep.js");
  const stillCurrent = () => deps.stillCurrent().catch(() => false);

  for (const row of mine.holdings) {
    const r = (await openSaleSecret(row, deps.gens)) ?? (await secretFromCopy(row.pickupId, deps));
    if (r === "later") {
      report.left++;
      continue;
    }
    // Sealed to keys this device does not hold, and not in the account: left alone.
    if (!r) {
      report.skipped++;
      continue;
    }
    try {
      const got = await boxOf(r, row, deps.fetchBox);
      if (got.kind === "later") {
        report.left++;
        continue;
      }
      // Refused, unknown ledger, or gone since the list was read: nothing to keep.
      if (got.kind !== "ok" || !(await knownLedger(got.box))) {
        report.skipped++;
        continue;
      }
      if (!deps.current || !(await stillCurrent())) {
        report.left++;
        continue;
      }
      const out = await keepInAccount(deps.current, r, got.box, deps.keep);
      if (out.saved !== "saved") {
        report.left++;
        continue;
      }
      report.saved++;
      if (out.erase === "erased" || out.erase === "gone") report.erased++;
      else report.left++;
    } catch {
      report.left++;
    } finally {
      r.fill(0);
    }
  }
  report.done = mine.complete && report.left === 0;
  return report;
}

/**
 * The sales `gens` open that the server still holds receipts for, each opened and checked
 * and made into the copy a save would write - for an upgrade to a passkey, which carries
 * them to the new seed with the rest (`carryReceipts`). Nothing is saved or erased here.
 * "unavailable" when any could not be read, or the server's list may be short: carrying
 * part would leave the rest sealed to a seed that is about to leave the device.
 */
export async function pendingCopies(deps: Pick<CollectDeps, "mine" | "gens" | "fetchBox">): Promise<SavedHoldingCopies | "unavailable"> {
  const mine = await deps.mine();
  if (mine.kind !== "ok" || !mine.complete) return "unavailable";
  const { holdingCopyOf, holdingIndexEntryOf } = await import("@woco/shared/holding/copy");
  const out: SavedHoldingCopies = [];
  for (const row of mine.holdings) {
    const r = await openSaleSecret(row, deps.gens);
    // Not sealed to these keys: nothing this seed could carry.
    if (!r) continue;
    try {
      const got = await boxOf(r, row, deps.fetchBox);
      if (got.kind === "later") return "unavailable";
      // Whatever ledger it names: a mover never filters (`readAllHoldingCopies` does not),
      // and a sale left out here is sealed to a seed about to leave the device.
      if (got.kind !== "ok") continue;
      out.push({ copy: holdingCopyOf(r, got.box), entry: holdingIndexEntryOf(row.pickupId, got.box) });
    } finally {
      r.fill(0);
    }
  }
  return out;
}
