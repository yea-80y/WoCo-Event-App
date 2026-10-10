/**
 * Pairing mailbox (#746 step 4) - the transport two devices use to link.
 *
 * In memory only, on purpose: a pairing lives ten minutes, and a restart just
 * means "start again" on the device showing the code. Nothing here must survive.
 *
 * It holds sealed bytes it cannot read (`packages/shared/src/auth/device-pairing.ts`)
 * and enforces only transport rules: each slot is written once, in order, and the
 * whole pairing expires PAIRING_TTL_MS after its offer. Who may act on a message
 * is decided by the signatures inside it, checked by the devices and by the grant
 * routes, so nothing here authenticates a writer.
 */

import { PAIRING_SLOT_AFTER, PAIRING_TTL_MS, type PairingSlot } from "@woco/shared";

interface Pairing {
  createdAt: number;
  slots: Partial<Record<PairingSlot, string>>;
}

/** Live pairings at once. Ten-minute entries, a handful per person per sitting. */
export const MAX_LIVE_PAIRINGS = 2_000;

const pairings = new Map<string, Pairing>();

export type PairingPutResult = "ok" | "exists" | "out-of-order" | "gone" | "full";

function expired(p: Pairing, now: number): boolean {
  return now - p.createdAt >= PAIRING_TTL_MS;
}

function sweep(now: number): void {
  for (const [id, p] of pairings) if (expired(p, now)) pairings.delete(id);
}

function live(id: string, now: number): Pairing | undefined {
  const p = pairings.get(id);
  if (p && expired(p, now)) {
    pairings.delete(id);
    return undefined;
  }
  return p;
}

export function putPairingSlot(id: string, slot: PairingSlot, box: string, now = Date.now()): PairingPutResult {
  if (slot === "offer") {
    if (live(id, now)) return "exists";
    if (pairings.size >= MAX_LIVE_PAIRINGS) {
      sweep(now);
      if (pairings.size >= MAX_LIVE_PAIRINGS) return "full";
    }
    pairings.set(id, { createdAt: now, slots: { offer: box } });
    return "ok";
  }
  const p = live(id, now);
  if (!p) return "gone";
  const before = PAIRING_SLOT_AFTER[slot];
  if (before && p.slots[before] === undefined) return "out-of-order";
  if (p.slots[slot] !== undefined) return "exists";
  p.slots[slot] = box;
  return "ok";
}

/** The box, `null` while the slot is still empty, or "gone" (expired / never existed). */
export function getPairingSlot(id: string, slot: PairingSlot, now = Date.now()): string | null | "gone" {
  const p = live(id, now);
  if (!p) return "gone";
  return p.slots[slot] ?? null;
}

/** Tests only. */
export function __resetPairingsForTest(): void {
  pairings.clear();
}
