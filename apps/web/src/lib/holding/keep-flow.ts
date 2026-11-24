/**
 * What the Keep page does, step by step (spec-receipt-note 5.2), apart from the screen so
 * each step is tested on its own.
 *
 * - `acceptKeepLink`: on load. Reads the link and keeps its secret on the device. LOCAL
 *   ONLY - nothing goes over the network until a button is pressed (mail scanners open
 *   links; Fable condition 2).
 * - `showReceipt`: the "Show my receipt" press. The box from the device if it is already
 *   there, else from Swarm by its root, the pickup API only as the fallback
 *   (`fetchHoldingBox`). Checked against the secret, and against the ticket ledgers this
 *   build knows, before anything is shown or kept.
 * - `saveToAccount`: the "Save to your WoCo account" press, given keys from a CONFIRMED-
 *   current account secret. Saved and read back, THEN our copy erased (`keepInAccount`).
 * - `finishErase`: erasing our copy again, for a receipt already saved.
 *
 * A secret is never dropped here on any answer - "not found", "later", a refusal, a
 * thrown error. The device keeps it until the person signs out there; a step that finds
 * it gone says so ("not-on-device": open the email link again), never "try later".
 */
import type { HoldingBoxV1 } from "@woco/shared/holding/box";
import type { CheckedReceipt, HoldingBoxRefusal } from "@woco/shared/holding/open";
import type { EraseResult } from "../api/holdings.js";
import type { HoldingGenKeys, SaveResult } from "./account-copy.js";
import type { BoxSourceResult } from "./box-source.js";
import type { DeviceReceipt } from "./device-store.js";
import type { KeepDeps } from "./keep.js";

export interface KeepFlowDeps {
  device: Pick<
    typeof import("./device-store.js"),
    "readDeviceReceipt" | "rememberKeepLink" | "rememberDeviceBox" | "markDeviceReceiptSaved" | "markDeviceReceiptErased"
  >;
  fetchBox(r: Uint8Array, boxRoot: string | undefined): Promise<BoxSourceResult>;
  keepDeps(): Promise<KeepDeps>;
}

export async function liveKeepFlowDeps(): Promise<KeepFlowDeps> {
  const [device, { fetchHoldingBox }, { liveKeepDeps }] = await Promise.all([
    import("./device-store.js"),
    import("./box-source.js"),
    import("./keep.js"),
  ]);
  return { device, fetchBox: (r, root) => fetchHoldingBox(r, root), keepDeps: liveKeepDeps };
}

/**
 * The ticket ledger the box names is one this build knows (the chain and its address).
 * A box naming another was not made by this platform's sales, whatever it says.
 */
export async function isKnownLedger(box: HoldingBoxV1): Promise<boolean> {
  const { ticketLedger2Address } = await import("@woco/shared/ticket/ledger2");
  const first = box.receipts[0];
  return !!first && box.receipts.every((e) => e.chainId === first.chainId && e.ledger === first.ledger) && ticketLedger2Address(first.chainId) === first.ledger;
}

const bytesOf = async (hex: string) => (await import("@noble/hashes/utils.js")).hexToBytes(hex);

/** On load: the link read and its secret kept on the device. No network. */
export async function acceptKeepLink(fragment: string, deps: Pick<KeepFlowDeps, "device">): Promise<DeviceReceipt | "malformed"> {
  const { parseHoldingKeepFragment } = await import("@woco/shared/holding/pickup");
  const link = parseHoldingKeepFragment(fragment);
  if (!link) return "malformed";
  try {
    return await deps.device.rememberKeepLink(link.r, link.boxRoot);
  } finally {
    link.r.fill(0);
  }
}

export type ShowResult =
  | { kind: "shown"; receipt: DeviceReceipt; receipts: CheckedReceipt[] }
  /** This device no longer keeps the receipt (someone signed out here): open the email link again. */
  | { kind: "not-on-device" }
  /** The box names a ticket ledger this build does not know: not shown, not kept. */
  | { kind: "unknown-ledger" }
  /** The server has no receipt for this secret and Swarm did not serve it. */
  | { kind: "not-found" }
  | { kind: "later" }
  | { kind: "refused"; reason: HoldingBoxRefusal };

/** The "Show my receipt" press. */
export async function showReceipt(pickupId: string, deps: KeepFlowDeps): Promise<ShowResult> {
  const kept = await deps.device.readDeviceReceipt(pickupId);
  if (!kept) return { kind: "not-on-device" };
  const r = await bytesOf(kept.r);
  try {
    if (kept.box) {
      // Kept on this device after an earlier check: checked again, never trusted as stored.
      const { checkedHoldingBox, HoldingBoxRefusedError } = await import("@woco/shared/holding/open");
      try {
        const checked = checkedHoldingBox(r, kept.box);
        if (!(await isKnownLedger(checked.box))) return { kind: "unknown-ledger" };
        return { kind: "shown", receipt: kept, receipts: checked.receipts };
      } catch (e) {
        if (!(e instanceof HoldingBoxRefusedError)) throw e;
        // Fall through to fetching it afresh.
      }
    }
    const got = await deps.fetchBox(r, kept.boxRoot);
    if (got.kind !== "ok") return got;
    if (!(await isKnownLedger(got.box))) return { kind: "unknown-ledger" };
    const receipt = await deps.device.rememberDeviceBox(kept.r, got.box, got.boxRoot);
    if (!receipt) return { kind: "not-on-device" };
    return { kind: "shown", receipt, receipts: got.receipts };
  } finally {
    r.fill(0);
  }
}

export type SaveOutcome =
  /** Saved and read back; `erase` is what our server said (or "later" when it was not asked). */
  | { kind: "saved"; erase: EraseResult }
  /** Sent, but not read back yet: our copy was left alone. */
  | { kind: "unconfirmed" }
  /** No checked box on the device: show it first. */
  | { kind: "not-shown" }
  /** This device no longer keeps the receipt: open the email link again. */
  | { kind: "not-on-device" };

/** The "Save to your WoCo account" press. `account`: the signed-in account, `keys` its CURRENT generation. */
export async function saveToAccount(pickupId: string, keys: HoldingGenKeys, account: string, deps: KeepFlowDeps): Promise<SaveOutcome> {
  const kept = await deps.device.readDeviceReceipt(pickupId);
  if (!kept) return { kind: "not-on-device" };
  if (!kept.box || !(await isKnownLedger(kept.box))) return { kind: "not-shown" };
  const r = await bytesOf(kept.r);
  try {
    const { keepInAccount } = await import("./keep.js");
    const out = await keepInAccount(keys, r, kept.box, await deps.keepDeps());
    return await settle(kept.r, out.saved, out.erase, account, deps);
  } finally {
    r.fill(0);
  }
}

/** Erase our copy of a receipt already saved in an account. */
export async function finishErase(pickupId: string, deps: KeepFlowDeps): Promise<EraseResult | "not-saved" | "not-on-device"> {
  const kept = await deps.device.readDeviceReceipt(pickupId);
  if (!kept) return "not-on-device";
  if (!kept.savedTo) return "not-saved";
  if (kept.serverErased) return "erased";
  const r = await bytesOf(kept.r);
  try {
    const { eraseServerCopy } = await import("./keep.js");
    const erase = await eraseServerCopy(r, await deps.keepDeps());
    if (erase === "erased" || erase === "gone") await deps.device.markDeviceReceiptErased(kept.r);
    return erase;
  } finally {
    r.fill(0);
  }
}

async function settle(rHex: string, saved: SaveResult, erase: EraseResult | "not-yet", account: string, deps: KeepFlowDeps): Promise<SaveOutcome> {
  if (saved !== "saved") return { kind: "unconfirmed" };
  await deps.device.markDeviceReceiptSaved(rHex, account);
  const result: EraseResult = erase === "not-yet" ? "later" : erase;
  if (result === "erased" || result === "gone") await deps.device.markDeviceReceiptErased(rHex);
  return { kind: "saved", erase: result };
}
