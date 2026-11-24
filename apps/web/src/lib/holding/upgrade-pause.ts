/**
 * Receipt saves under an email or Google account's seed pause while this device holds a
 * half-done upgrade of it to a passkey (Fable 3c PR 1). The upgrade carries that seed's
 * receipts once, right before the switch (`carryReceipts`); a receipt saved under it
 * after the carry would leave the device with the old seed. Undo, or finishing the
 * upgrade, ends the pause.
 *
 * A passkey account is never paused: its seed is the passkey's own, the one receipts are
 * carried TO. Another device is not covered (the marker is this device's): the carry
 * reads the old seed afresh at every attempt, and a tab without the passkey refuses when
 * anything changed since (`carried`).
 */
import { localMarkerStore } from "../auth/upgrade-marker.js";

export const RECEIPT_SAVES_PAUSED_MESSAGE = "Finish or undo your passkey upgrade first, then save your receipt.";

export function receiptSavesPaused(parent: string, kind: string | null): boolean {
  if (kind === "passkey") return false;
  return localMarkerStore.read(parent)?.stage === "prepared";
}
