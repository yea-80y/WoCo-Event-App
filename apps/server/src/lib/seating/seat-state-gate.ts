/**
 * A seated ticket type's seat state (`woco.seatstate.v1`: held seats, confirmed freed
 * seats) as the money path reads it - docs/SEATING.md Decisions 3 + 5, S6 consult
 * (Fable, 2026-11-04). The notice gate's shape (`lib/legal/notice-gate.ts`), with the
 * opposite failure direction: a stale notice keeps sales open, which is harmless; a
 * stale seat state could sell a seat the organiser has just held. So:
 *
 *   - read under the event's carrier (`eventKeys`: the ring's feed signer, else the one
 *     pinned at create), never the event feed's description of itself;
 *   - answered from memory for at most SEAT_STATE_FRESH_MS, single-flight, and only for
 *     the exact signer, plan and seat count it was read for;
 *   - the organiser's own write, seen at the SOC relay, ends that at once and names the
 *     `seq` it carries (`seatStateWritten`): older reads are refused from then on. The
 *     floor does not lapse - a write stored on Etherna can take minutes to reach the
 *     reader, and selling from the old state meanwhile is exactly what it exists to stop.
 *     A save that died half way leaves that ticket type's holds refused until the
 *     organiser saves again (the dashboard says so) or the process restarts;
 *   - a read below the highest `seq` found is unavailable: a lagging read never rolls a
 *     hold back, and once a state was found here, reading none is unavailable, not
 *     "never written";
 *   - a state that does not parse or validate, or validates for another event, ticket
 *     type or plan, is unavailable (a bug, not a verdict) - never the plan's own flags,
 *     which is what "absent" means.
 *
 * Unavailable refuses the hold (503). In memory only: a restart forgets the floors and
 * high-water marks, and the first read after it is trusted as found.
 */

import type { VersionedFeedRead } from "@woco/shared";
import { seatStateTopic } from "@woco/shared/seating/topics";
import { validateSeatState, type SeatState } from "@woco/shared/seating/state";
import { invalidateContentFeedVersion, readContentFeedJsonResult } from "../swarm/soc-upload.js";
import { getRecordedFeedSigner } from "../event/feed-signer-record.js";
import { eventKeys } from "../keyring/event-keys.js";

export type SeatStateRead =
  | { status: "found"; state: SeatState }
  /** Never written: the plan's own held flags apply. */
  | { status: "absent" }
  | { status: "unavailable"; reason: string };

export type SeatStateFeedReader = (ownerHex: string, topic: string) => Promise<VersionedFeedRead>;

export const SEAT_STATE_FRESH_MS = 30_000;
/** How long an announced write may stay unread before it is logged (it keeps refusing). */
export const SEAT_STATE_SIGNAL_WARN_MS = 2 * 60_000;
const MAX_ENTRIES = 10_000;
/** Announced writes one event may have waiting: its seated ticket types, with room (S6 sign-off change 6). */
export const MAX_SIGNALS_PER_EVENT = 64;

// `fresh`: the version cache under it is only a starting point. A write's first page
// reaches the relay before its head does, so a version cached in between would
// otherwise keep answering the old state for that cache's whole lifetime.
const defaultReader: SeatStateFeedReader = (ownerHex, topic) =>
  readContentFeedJsonResult(ownerHex, topic, "event", { skipLegacy: true, fresh: true });

let reader: SeatStateFeedReader = defaultReader;
let clock: () => number = Date.now;

interface Entry {
  /** signer | planDigest | seats: what the read was validated for. */
  for: string;
  read: Extract<SeatStateRead, { status: "found" | "absent" }>;
  at: number;
}
/** series key -> the last definitive read. */
const cache = new Map<string, Entry>();
/** series key -> the highest seq found (any signer: a rotation copies the seq). */
const highest = new Map<string, number>();
/** series key -> a write announced at the relay and not yet read back. */
const expected = new Map<string, { seq: number; at: number; warned: boolean }>();
const inflight = new Map<string, Promise<SeatStateRead>>();

const seriesKey = (eventId: string, seriesId: string) => `${eventId}\u0000${seriesId}`;

function bounded<V>(m: Map<string, V>, key: string, value: V): void {
  m.delete(key); // re-insert at the end: the Map's order is the eviction order
  m.set(key, value);
  while (m.size > MAX_ENTRIES) {
    const oldest = m.keys().next().value;
    if (oldest === undefined) break;
    m.delete(oldest);
  }
}

function pendingSeq(key: string): number | null {
  const e = expected.get(key);
  if (!e) return null;
  if (!e.warned && clock() - e.at >= SEAT_STATE_SIGNAL_WARN_MS) {
    e.warned = true;
    const [eventId, seriesId] = key.split("\u0000");
    console.warn(`[seat-state] ${eventId?.slice(0, 8)}/${seriesId?.slice(0, 8)}: announced seq ${e.seq} still not readable - that ticket type's holds stay refused until the organiser saves again`);
  }
  return e.seq;
}

export interface SeatStateExpect {
  eventId: string;
  seriesId: string;
  /** Lowercase 0x: the carrier's feed signer. */
  signer: string;
  planDigest: string;
  seats: number;
}

/**
 * One read, its verdict, and - in the same synchronous step as the floor check - the
 * memory of a definitive one: a write announced after this point deletes it, and one
 * announced before it was seen here. No await sits between the check and the memory.
 */
async function readOnce(x: SeatStateExpect, key: string, forWhat: string): Promise<SeatStateRead> {
  const remember = (r: Extract<SeatStateRead, { status: "found" | "absent" }>) => {
    bounded(cache, key, { for: forWhat, read: r, at: clock() });
    return r;
  };
  let res: VersionedFeedRead;
  try {
    res = await reader(x.signer.replace(/^0x/, ""), seatStateTopic(x.eventId, x.seriesId));
  } catch (err) {
    return { status: "unavailable", reason: err instanceof Error ? err.message : String(err) };
  }
  const top = highest.get(key);
  const pending = pendingSeq(key);
  if (res.status === "unavailable") return { status: "unavailable", reason: res.reason ?? "unavailable" };
  if (res.status === "absent") {
    if (top !== undefined) return { status: "unavailable", reason: "seat state read absent after it was found" };
    if (pending !== null) return { status: "unavailable", reason: "seat state write not readable yet" };
    return remember({ status: "absent" });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(res.bytes).replace(/\0+$/, ""));
  } catch {
    return { status: "unavailable", reason: "seat state does not parse" };
  }
  if (!validateSeatState(raw)) return { status: "unavailable", reason: "seat state does not validate" };
  if (!validateSeatState(raw, x)) {
    console.error(`[seat-state] ${x.eventId.slice(0, 8)}: state names another ticket type or plan - holds refused`);
    return { status: "unavailable", reason: "seat state is for another ticket type or plan" };
  }
  // A replica behind what this process has already read, or behind a write announced
  // since: refused, never served (a hold must not roll back).
  if (top !== undefined && raw.seq < top) return { status: "unavailable", reason: "seat state read is older than one already seen" };
  if (pending !== null && raw.seq < pending) return { status: "unavailable", reason: "seat state write not readable yet" };
  if (pending !== null) expected.delete(key);
  bounded(highest, key, raw.seq);
  return remember({ status: "found", state: raw });
}

/**
 * The ticket type's seat state for a hold check. Never throws. Run it under the series
 * lock, beside the chain read it is checked with.
 */
export async function seatStateRead(input: SeatStateExpect): Promise<SeatStateRead> {
  const x = { ...input, signer: input.signer.toLowerCase(), planDigest: input.planDigest.toLowerCase() };
  const key = seriesKey(x.eventId, x.seriesId);
  const forWhat = `${x.signer}|${x.planDigest}|${x.seats}`;
  const e = cache.get(key);
  if (e && e.for === forWhat && clock() - e.at < SEAT_STATE_FRESH_MS && pendingSeq(key) === null) return e.read;
  const flight = `${key}\u0000${forWhat}`;
  const running = inflight.get(flight);
  if (running) return running;
  const p = (async () => {
    try {
      const r = await readOnce(x, key, forWhat);
      if (r.status === "unavailable") cache.delete(key);
      return r;
    } finally {
      inflight.delete(flight);
    }
  })();
  inflight.set(flight, p);
  return p;
}

/**
 * A seat-state write for this ticket type, naming `seq`, was stored. Drops the cached
 * read and refuses anything older from now on. Only ever stricter.
 */
export function seatStateWritten(eventId: string, seriesId: string, seq: number): void {
  const key = seriesKey(eventId, seriesId);
  const before = expected.get(key);
  // One organiser cannot fill the map with made-up ticket types and evict others' floors.
  if (!before) {
    let mine = 0;
    for (const k of expected.keys()) if (k.startsWith(`${eventId}\u0000`)) mine++;
    if (mine >= MAX_SIGNALS_PER_EVENT) return;
  }
  bounded(expected, key, { seq: Math.max(seq, before?.seq ?? 0), at: clock(), warned: false });
  cache.delete(key);
}

/** The event's carrier signer (`eventKeys`), lowercase 0x, or null when it is not known. */
async function liveCarrierSigner(eventId: string): Promise<string | null> {
  const k = await eventKeys(eventId).catch(() => null);
  return k && (k.kind === "ring" || k.kind === "record") ? k.feedSigner.toLowerCase() : null;
}

/**
 * The SOC relay stored a chunk carrying `signal`, for authenticated account `parent`,
 * owned by `ownerHex`. Acts only for the event's own organiser - the write-once
 * record's creator, never the feed's description of itself - writing under the event's
 * CURRENT carrier signer (S6 sign-off change 3: after a key rotation, a device still
 * holding the old signer must not keep that ticket type's holds refused). A carrier that
 * cannot be read is treated as matching: a false signal only refuses, the safe side.
 * Anyone else's chunk changes nothing. True when it acted.
 */
export async function seatStateRelayed(
  signal: { eventId: string; seriesId: string; seq: number },
  parent: string,
  ownerHex: string,
  recordedCreator: (eventId: string) => string | null = (id) => getRecordedFeedSigner(id)?.creatorAddress ?? null,
  carrierSigner: (eventId: string) => Promise<string | null> = liveCarrierSigner,
): Promise<boolean> {
  const creator = recordedCreator(signal.eventId);
  if (!creator || creator.toLowerCase() !== parent.toLowerCase()) return false;
  const carrier = await carrierSigner(signal.eventId);
  const owner = `0x${ownerHex.toLowerCase().replace(/^0x/, "")}`;
  if (carrier !== null && carrier !== owner) return false;
  seatStateWritten(signal.eventId, signal.seriesId, signal.seq);
  invalidateContentFeedVersion(ownerHex.toLowerCase().replace(/^0x/, ""), seatStateTopic(signal.eventId, signal.seriesId));
  return true;
}

/**
 * `/api/health` `seatState` (S6 sign-off change 4): red while a ticket type's announced
 * save has stayed unreadable past SEAT_STATE_SIGNAL_WARN_MS - its holds are refused (503)
 * until the organiser saves again (their "Try again") or the process restarts. Counts
 * only on this public report; the server log names the event.
 */
export function seatStateGateHealth(): { ok: boolean; waiting: number; stuck: number; oldestMs: number | null } {
  const now = clock();
  let stuck = 0;
  let oldest: number | null = null;
  for (const e of expected.values()) {
    const age = now - e.at;
    if (age >= SEAT_STATE_SIGNAL_WARN_MS) stuck++;
    oldest = oldest === null ? age : Math.max(oldest, age);
  }
  return { ok: stuck === 0, waiting: expected.size, stuck, oldestMs: oldest };
}

export function __setSeatStateGateForTests(opts: { reader?: SeatStateFeedReader; now?: () => number } = {}): void {
  reader = opts.reader ?? defaultReader;
  clock = opts.now ?? Date.now;
  cache.clear();
  highest.clear();
  expected.clear();
  inflight.clear();
}
