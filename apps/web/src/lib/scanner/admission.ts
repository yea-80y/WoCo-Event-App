/**
 * Whether the door lets a genuine, unrefunded ticket in (#641). Kept apart from
 * the store (runes + IndexedDB) so each rule is testable in node:
 * `apps/web/test/scanner-admission.test.ts`.
 *
 * - "single": this device is the only door on the pass, so its own set is the
 *   whole truth and it admits with no signal.
 * - "several": only the server knows what the other scanners admitted, so only
 *   a confirmed server admission lets anyone in. Offline is "couldn't confirm".
 * - A dead pass admits nothing in either mode: it was revoked or moved to
 *   another phone, and admitting on would make this a second, uncoordinated door.
 */
import type { CheckinPack, CheckinRecord, DoorMode } from "@woco/shared";
import type { ClaimAnswer } from "./claim.js";

export type Admission =
  | { kind: "admitted" }
  | { kind: "already-in"; record: CheckinRecord }
  | { kind: "cant-confirm"; message: string };

export interface AdmitInput {
  mode: DoorMode;
  passDead: string | null;
  online: boolean;
  claimInFlight: boolean;
  /** What this device already knows about the ticket (its own admission, or a synced one). */
  known: CheckinRecord | undefined;
  /** "single" only: consume the local nullifier; the existing record if already in. */
  markLocally: () => Promise<CheckinRecord | null>;
  /** "several" only: ask the server. */
  claimAtServer: () => Promise<ClaimAnswer>;
}

export const OFFLINE_MESSAGE = "No connection - check-in is paused so nobody gets in twice";
export const IN_FLIGHT_MESSAGE = "Still checking the last ticket - scan again";
export const EVENT_CHANGED_MESSAGE = "This tab changed event during the scan - scan again";

/** A pack that names no mode (built before #641) is "several": the mode that cannot admit twice. */
export function doorModeOf(pack: Pick<CheckinPack, "doorMode"> | null | undefined): DoorMode {
  return pack?.doorMode === "single" ? "single" : "several";
}

export async function admit(i: AdmitInput): Promise<Admission> {
  if (i.passDead) return { kind: "cant-confirm", message: i.passDead };

  if (i.mode === "single") {
    const existing = await i.markLocally();
    return existing ? { kind: "already-in", record: existing } : { kind: "admitted" };
  }

  if (i.known) return { kind: "already-in", record: i.known };
  // Two claims in flight for one ticket could carry different claimIds, and the
  // second would read this device's own admission as "already in".
  if (i.claimInFlight) return { kind: "cant-confirm", message: IN_FLIGHT_MESSAGE };
  if (!i.online) return { kind: "cant-confirm", message: OFFLINE_MESSAGE };

  const answer = await i.claimAtServer();
  if (answer.kind === "admitted") return { kind: "admitted" };
  if (answer.kind === "already-in") return { kind: "already-in", record: answer.record };
  return { kind: "cant-confirm", message: answer.message };
}

/**
 * The in-memory check-in set after a confirmed server answer, or null when this
 * tab moved to another pass while the claim was in flight (a pass link opened in
 * the tab): the answer belongs to the pass it was asked under, is stored under
 * that pass's event, and must never appear in another event's set.
 */
export function withConfirmed(
  checkins: Map<string, CheckinRecord>,
  key: string,
  record: CheckinRecord,
  askedUnder: string,
  current: string | undefined,
): Map<string, CheckinRecord> | null {
  if (askedUnder !== current) return null;
  const next = new Map(checkins);
  next.set(key, record);
  return next;
}
