/**
 * Door roster retention (#883).
 *
 * A roster carries every attendee's email and order-form answers, encrypted to
 * the organiser's door key. It is a derived copy - the dashboard builds it from
 * the orders and can upload it again - so it is deleted a fixed time after the
 * event ends and nothing unrecoverable goes with it. The event's door entries
 * (later buyers' sealed email and card name, `door-entries.ts`) go with it, on the
 * same clock, whether or not a roster was ever pushed. The check-in set and the
 * door pass are left alone: they hold no answers.
 *
 * The end is the onchain `eventEndTs` of the event's registrations, never the
 * feed's `endDate`: that one is organiser-signed and editable, while the chain's
 * is fixed at registration with no setter (#294). With several series the LATEST
 * end counts, since a series still selling may still need its door. No end the
 * server can trust (no registration, an unreadable record, a chain with no end
 * or no answer) keeps the roster, and the next pass looks again.
 */

import { chainTimeMs } from "../chain/event-contract.js";
import { chainEventEndMsAt, type ChainEndReaderAt } from "../event/end-date-guard.js";
import {
  getAllResolutionEntries,
  hasUnreadableRecordFor,
  registrationContractFor,
} from "../event/onchain-registry.js";
import { errorClass } from "../http/error-class.js";
import { deleteRoster, eventKey, storedRosterKeys } from "./store.js";
import { deleteDoorEntries, storedDoorEntryKeys } from "./door-entries.js";

/** Days a roster outlives its event's onchain end. Stated in DATA_INVENTORY §3.1. */
export const ROSTER_KEPT_AFTER_END_DAYS = 2;
const KEPT_MS = ROSTER_KEPT_AFTER_END_DAYS * 24 * 60 * 60 * 1000;

export interface RosterSweepOptions {
  /** Server clock, epoch ms. */
  now?: number;
  /** Test seams; production reads the registration's own contract. */
  readEnd?: ChainEndReaderAt;
  chainNow?: (chainId: number) => Promise<number>;
}

const health = {
  lastRunAt: null as string | null,
  /** Since boot. */
  deleted: 0,
  /** Rosters the last pass found no trusted end for: kept until one exists. */
  undated: 0,
  /** The last pass's failures, by class only (an RPC error can carry a keyed URL). */
  lastError: null as string | null,
};

/** `/api/health` - reported, not an alarm, like the consent sweep (#547). */
export function rosterRetentionHealth() {
  return { keptAfterEndDays: ROSTER_KEPT_AFTER_END_DAYS, ...health };
}

let running = false;

const fsCode = (err: unknown) => (err as NodeJS.ErrnoException | null)?.code ?? "error";

/**
 * Delete each roster whose event ended more than ROSTER_KEPT_AFTER_END_DAYS ago.
 *
 * @returns how many went, or null when a pass was already running: two passes
 *   would read the same ends twice and race each other's deletes.
 */
export async function sweepExpiredRosters(opts: RosterSweepOptions = {}): Promise<number | null> {
  if (running) return null;
  running = true;
  try {
    return await sweep(opts);
  } catch (err) {
    health.lastError = `pass failed (${fsCode(err)})`;
    throw err;
  } finally {
    running = false;
  }
}

async function sweep({ now = Date.now(), readEnd, chainNow = chainTimeMs }: RosterSweepOptions): Promise<number> {
  const stored = new Set([...storedRosterKeys(), ...storedDoorEntryKeys()]);
  const regsByEvent = new Map<string, Array<{ seriesId: string; onChainEventId: string }>>();
  for (const r of getAllResolutionEntries()) {
    if (!stored.has(eventKey(r.wocoEventId))) continue;
    const regs = regsByEvent.get(r.wocoEventId) ?? [];
    regs.push({ seriesId: r.seriesId, onChainEventId: r.onChainEventId });
    regsByEvent.set(r.wocoEventId, regs);
  }

  // One read of each chain's clock per pass, and only once a roster is due by ours.
  const clocks = new Map<number, Promise<number>>();
  const clock = (chainId: number) => {
    let c = clocks.get(chainId);
    if (!c) clocks.set(chainId, (c = chainNow(chainId)));
    return c;
  };

  /** "due" only when EVERY registration's end is known and past the period by both clocks. */
  const verdict = async (eventId: string): Promise<"due" | "not-due" | "undated"> => {
    if (hasUnreadableRecordFor(eventId)) return "undated";
    for (const { seriesId, onChainEventId } of regsByEvent.get(eventId)!) {
      const contract = registrationContractFor(eventId, seriesId);
      if (!contract) return "undated";
      const endMs = await chainEventEndMsAt(contract, onChainEventId, readEnd);
      if (endMs === null) return "undated";
      // The EARLIER clock: a server clock running fast must not delete early.
      if (now - endMs <= KEPT_MS) return "not-due";
      if ((await clock(contract.chainId)) - endMs <= KEPT_MS) return "not-due";
    }
    return "due";
  };

  let deleted = 0;
  let undated = stored.size - regsByEvent.size;
  const failures = new Set<string>();
  for (const eventId of regsByEvent.keys()) {
    const key = eventKey(eventId);
    let v: Awaited<ReturnType<typeof verdict>>;
    try {
      v = await verdict(eventId);
    } catch (err) {
      failures.add(`end unreadable (${errorClass(err)})`);
      continue;
    }
    if (v === "undated") undated++;
    if (v !== "due") continue;
    try {
      deleteRoster(key);
      deleteDoorEntries(key);
    } catch (err) {
      failures.add(`delete failed (${fsCode(err)})`);
      continue;
    }
    deleted++;
    console.log(`[checkin] deleted the door roster ${key}: its event ended over ${ROSTER_KEPT_AFTER_END_DAYS} days ago`);
  }

  health.lastRunAt = new Date().toISOString();
  health.deleted += deleted;
  health.undated = undated;
  health.lastError = failures.size ? `rosters left for the next pass: ${[...failures].join("; ")}` : null;
  if (failures.size) console.warn(`[checkin] roster sweep: ${health.lastError}`);
  return deleted;
}
