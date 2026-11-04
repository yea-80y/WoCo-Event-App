/**
 * The organiser's seat state (`woco.seatstate.v1`: held seats, confirmed freed seats) as
 * the money path reads it - docs/SEATING.md Decisions 3 + 5, S6 consult (Fable,
 * 2026-11-04). The notice gate's shape (`lib/legal/notice-gate.ts`), with the opposite
 * failure direction: a stale notice keeps sales open, which is harmless; a stale seat
 * state could sell a seat the organiser has just held. So:
 *
 *   - read under the event's carrier (`eventKeys`: the ring's feed signer, else the one
 *     pinned at create), never the event feed's description of itself;
 *   - answered from memory for at most SEAT_STATE_FRESH_MS, single-flight per event;
 *   - the organiser's own write, seen at the SOC relay, ends that at once and names the
 *     `seq` it carries (`seatStateWritten`): until a read shows that seq (or
 *     SEAT_STATE_SIGNAL_MS passes - a write that died half way), older reads are
 *     unavailable, never served;
 *   - a read below the highest `seq` found per event is unavailable: a lagging read
 *     never rolls a hold back, and once a state was found here, reading none is
 *     unavailable, not "never written";
 *   - a state that does not parse or validate, or validates for another event or plan,
 *     is unavailable (a bug, not a verdict) - never the plan's own flags, which is what
 *     "absent" means.
 *
 * Unavailable refuses the hold (503). In memory only: a restart forgets the high-water
 * marks, and the first read after it is trusted as found.
 */

import type { VersionedFeedRead } from "@woco/shared";
import { eventSeatStateTopic } from "@woco/shared/seating/topics";
import { validateSeatState, type SeatState } from "@woco/shared/seating/state";
import { readContentFeedJsonResult } from "../swarm/soc-upload.js";

export type SeatStateRead =
  | { status: "found"; state: SeatState }
  /** Never written: the plan's own held flags apply. */
  | { status: "absent" }
  | { status: "unavailable"; reason: string };

export type SeatStateFeedReader = (ownerHex: string, topic: string) => Promise<VersionedFeedRead>;

export const SEAT_STATE_FRESH_MS = 30_000;
export const SEAT_STATE_SIGNAL_MS = 2 * 60_000;
const MAX_ENTRIES = 10_000;

// `fresh`: the version cache under it is only a starting point. A write's first page
// reaches the relay before its head does, so a version cached in between would
// otherwise keep answering the old state for that cache's whole lifetime.
const defaultReader: SeatStateFeedReader = (ownerHex, topic) =>
  readContentFeedJsonResult(ownerHex, topic, "event", { skipLegacy: true, fresh: true });

let reader: SeatStateFeedReader = defaultReader;
let clock: () => number = Date.now;

interface Entry {
  signer: string;
  read: Extract<SeatStateRead, { status: "found" | "absent" }>;
  at: number;
}
/** eventId -> the last definitive read. */
const cache = new Map<string, Entry>();
/** eventId -> the highest seq found (any signer: a rotation copies the seq). */
const highest = new Map<string, number>();
/** eventId -> a write announced at the relay and not yet read back. */
const expected = new Map<string, { seq: number; at: number }>();
const inflight = new Map<string, Promise<SeatStateRead>>();

function bounded<V>(m: Map<string, V>, key: string, value: V): void {
  m.delete(key); // re-insert at the end: the Map's order is the eviction order
  m.set(key, value);
  while (m.size > MAX_ENTRIES) {
    const oldest = m.keys().next().value;
    if (oldest === undefined) break;
    m.delete(oldest);
  }
}

function pendingSeq(eventId: string): number | null {
  const e = expected.get(eventId);
  if (!e) return null;
  if (clock() - e.at >= SEAT_STATE_SIGNAL_MS) {
    expected.delete(eventId);
    console.warn(`[seat-state] ${eventId.slice(0, 8)}: announced seq ${e.seq} never read back - trusting the latest readable state`);
    return null;
  }
  return e.seq;
}

export interface SeatStateExpect {
  eventId: string;
  /** Lowercase 0x: the carrier's feed signer. */
  signer: string;
  planDigest: string;
  seats: number;
}

async function readOnce(x: SeatStateExpect): Promise<SeatStateRead> {
  let res: VersionedFeedRead;
  try {
    res = await reader(x.signer.toLowerCase().replace(/^0x/, ""), eventSeatStateTopic(x.eventId));
  } catch (err) {
    return { status: "unavailable", reason: err instanceof Error ? err.message : String(err) };
  }
  const top = highest.get(x.eventId);
  const pending = pendingSeq(x.eventId);
  if (res.status === "unavailable") return { status: "unavailable", reason: res.reason ?? "unavailable" };
  if (res.status === "absent") {
    if (top !== undefined) return { status: "unavailable", reason: "seat state read absent after it was found" };
    if (pending !== null) return { status: "unavailable", reason: "seat state write not readable yet" };
    return { status: "absent" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(res.bytes).replace(/\0+$/, ""));
  } catch {
    return { status: "unavailable", reason: "seat state does not parse" };
  }
  if (!validateSeatState(raw)) return { status: "unavailable", reason: "seat state does not validate" };
  if (!validateSeatState(raw, { eventId: x.eventId, planDigest: x.planDigest, seats: x.seats })) {
    console.error(`[seat-state] ${x.eventId.slice(0, 8)}: state names another event or plan - holds refused`);
    return { status: "unavailable", reason: "seat state is for another event or plan" };
  }
  // A replica behind what this process has already read, or behind a write announced
  // since: refused, never served (a hold must not roll back).
  if (top !== undefined && raw.seq < top) return { status: "unavailable", reason: "seat state read is older than one already seen" };
  if (pending !== null && raw.seq < pending) return { status: "unavailable", reason: "seat state write not readable yet" };
  if (pending !== null) expected.delete(x.eventId);
  bounded(highest, x.eventId, raw.seq);
  return { status: "found", state: raw };
}

/**
 * The event's seat state for a hold check. Never throws. Run it under the series lock,
 * beside the chain read it is checked with.
 */
export async function seatStateRead(x: SeatStateExpect): Promise<SeatStateRead> {
  const signer = x.signer.toLowerCase();
  const e = cache.get(x.eventId);
  if (e && e.signer === signer && clock() - e.at < SEAT_STATE_FRESH_MS && pendingSeq(x.eventId) === null) return e.read;
  const key = `${x.eventId}|${signer}`;
  const running = inflight.get(key);
  if (running) return running;
  const p = (async () => {
    try {
      const r = await readOnce({ ...x, signer });
      if (r.status !== "unavailable") bounded(cache, x.eventId, { signer, read: r, at: clock() });
      else cache.delete(x.eventId);
      return r;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/**
 * The SOC relay just stored a seat-state chunk for `eventId` from the event's own
 * organiser, naming `seq` (`seatStateWriteSignal`). Drops the cached read and refuses
 * anything older until that seq reads back or the signal lapses. Only ever stricter.
 */
export function seatStateWritten(eventId: string, seq: number): void {
  const before = expected.get(eventId);
  bounded(expected, eventId, { seq: Math.max(seq, before?.seq ?? 0), at: clock() });
  cache.delete(eventId);
}

export function __setSeatStateGateForTests(opts: { reader?: SeatStateFeedReader; now?: () => number } = {}): void {
  reader = opts.reader ?? defaultReader;
  clock = opts.now ?? Date.now;
  cache.clear();
  highest.clear();
  expected.clear();
  inflight.clear();
}
