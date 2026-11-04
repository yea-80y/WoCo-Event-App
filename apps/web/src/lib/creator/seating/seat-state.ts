/**
 * The organiser's side of a seated ticket type's seat state (`woco.seatstate.v1`,
 * docs/SEATING.md Decisions 3 + 5): read it, and carry it to a new feed signer when the
 * account's keys move (#186). Written by the dashboard only (`writeSeatState`, S6).
 *
 * Thorough reads only: "absent" here decides what is written, and a state that cannot
 * be read stops the caller rather than being taken as never written.
 */

import type { EventFeed } from "@woco/shared";
import type { SeatHoldKind, SeatState } from "@woco/shared/seating/state";
import type { ContentFeedResult } from "../../swarm/content-feed.js";
import type { FeedRoute } from "../../swarm/gateways.js";

export interface SeatStateIO {
  read(signer: string, topic: string, route: FeedRoute): Promise<ContentFeedResult<unknown>>;
  /** Exactly version `version` (thorough). */
  readVersion(signer: string, topic: string, route: FeedRoute, version: number): Promise<ContentFeedResult<unknown>>;
  write(args: { signerPrivKey: string; topic: string; data: unknown; route: FeedRoute }): Promise<number>;
  route(feed: Pick<EventFeed, "gatewayUrl">): FeedRoute;
}

export class SeatStateUnreadableError extends Error {
  constructor(message = "Couldn't read your seat holds just now - nothing was changed. Try again.") {
    super(message);
    this.name = "SeatStateUnreadableError";
  }
}

/** Another device saved at the same version first: send the changes again on top of it. */
export class SeatStateConflictError extends Error {
  constructor() {
    super("Saved on another device meanwhile - sending your changes again.");
    this.name = "SeatStateConflictError";
  }
}

/** How far below an invalid head the writer looks for the last whole state. */
export const TORN_READ_DOWN = 8;

/** The event's seated ticket types (a `seating` block names the plan's band prices). */
export function seatedSeriesIds(feed: Pick<EventFeed, "series">): string[] {
  return feed.series.filter((s) => s.seating !== undefined).map((s) => s.seriesId);
}

/**
 * The state under `signer`, as stored: null when never written. Throws when it cannot
 * be read conclusively (an older version could be the one found).
 */
export async function readStoredSeatState(
  io: SeatStateIO,
  signer: string,
  feed: Pick<EventFeed, "eventId" | "gatewayUrl">,
  seriesId: string,
): Promise<{ value: unknown; version: number } | null> {
  const { seatStateTopic } = await import("@woco/shared/seating/topics");
  const res = await io.read(signer, seatStateTopic(feed.eventId, seriesId), io.route(feed));
  if (res.status === "unavailable" || (res.status === "found" && !res.scanClean)) throw new SeatStateUnreadableError();
  return res.status === "found" ? { value: res.value, version: res.version } : null;
}

/** A stored state that is this ticket type's, well formed. */
export async function ownSeatState(value: unknown, eventId: string, seriesId: string): Promise<SeatState | null> {
  const { validateSeatState } = await import("@woco/shared/seating/state");
  return validateSeatState(value) && value.eventId === eventId && value.seriesId === seriesId ? value : null;
}

/** The seq a stored value claims, if it parses as one: a torn version may have announced it. */
function claimedSeq(v: unknown): number {
  const seq = (v as { seq?: unknown } | null)?.seq;
  return typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0 ? seq : -1;
}

/**
 * The newest WHOLE state below version `from` (up to TORN_READ_DOWN versions down), and
 * the highest seq any version stepped past claimed. Below a head that exists every
 * version exists: absent is a miss, not a gap, and stepping past it could roll holds
 * back - unreadable. Only a version that reads but does not validate, or can never be
 * read, is stepped past. `state` null: every version down to the first is unusable.
 */
async function newestWholeBelow(
  io: SeatStateIO,
  signer: string,
  feed: Pick<EventFeed, "eventId" | "gatewayUrl">,
  seriesId: string,
  from: number,
): Promise<{ state: SeatState | null; maxSeq: number }> {
  const { seatStateTopic } = await import("@woco/shared/seating/topics");
  const topic = seatStateTopic(feed.eventId, seriesId);
  const route = io.route(feed);
  let maxSeq = -1;
  const lowest = Math.max(0, from - TORN_READ_DOWN);
  for (let v = from - 1; v >= lowest; v--) {
    const r = await io.readVersion(signer, topic, route, v);
    if (r.status === "absent" || (r.status === "unavailable" && r.unusableAt === undefined)) throw new SeatStateUnreadableError();
    const own = r.status === "found" ? await ownSeatState(r.value, feed.eventId, seriesId) : null;
    if (own) return { state: own, maxSeq };
    if (r.status === "found") maxSeq = Math.max(maxSeq, claimedSeq(r.value));
  }
  if (lowest === 0) return { state: null, maxSeq };
  throw new SeatStateUnreadableError();
}

/** A state's holds as seat -> kind. */
async function holdsOf(s: SeatState): Promise<Map<number, SeatHoldKind>> {
  const { decodeHeld } = await import("@woco/shared/seating/state");
  const out = new Map<number, SeatHoldKind>();
  for (const h of s.holds) for (const k of decodeHeld(h.held, s.seats)) out.set(k, h.kind);
  return out;
}

/**
 * Key rotation (#186), before the flip: every seated ticket type's state, as stored and
 * at the same `seq`, under the new signer. The server reads the new signer once the flip
 * lands; a state left behind would read as never written there - the plan's own holds
 * back, and every confirmation gone. Copied verbatim, malformed or not: what the server
 * made of it under the old signer is what it makes of it under the new one. An
 * unreadable state stops the removal before anything changes; this runs inside the
 * copying phase, which a resumed removal runs again until the flip.
 */
export async function copySeatStates(
  io: SeatStateIO,
  feed: Pick<EventFeed, "eventId" | "gatewayUrl" | "series">,
  oldSigner: string,
  newSignerPrivKey: string,
  now: () => string = () => new Date().toISOString(),
): Promise<number> {
  const [{ seatStateTopic }, { buildSeatState }] = await Promise.all([
    import("@woco/shared/seating/topics"),
    import("@woco/shared/seating/state"),
  ]);
  let copied = 0;
  for (const seriesId of seatedSeriesIds(feed)) {
    const stored = await readStoredSeatState(io, oldSigner, feed, seriesId);
    if (!stored) continue;
    let data = stored.value;
    // A torn head (S6 delta check): copied as is, the next save under the new signer would
    // find nothing whole below it and start from the plan. Copy the newest WHOLE state
    // instead, numbered above everything the torn versions announced.
    if (!(await ownSeatState(stored.value, feed.eventId, seriesId))) {
      const below = await newestWholeBelow(io, oldSigner, feed, seriesId, stored.version);
      if (below.state) {
        const w = below.state;
        data = buildSeatState({
          eventId: w.eventId, seriesId: w.seriesId, planDigest: w.planDigest, seats: w.seats,
          holds: await holdsOf(w), confirmed: new Map(w.confirmed),
          seq: Math.max(w.seq, claimedSeq(stored.value), below.maxSeq) + 1,
          updatedAt: now(),
        });
      }
    }
    await io.write({ signerPrivKey: newSignerPrivKey, topic: seatStateTopic(feed.eventId, seriesId), data, route: io.route(feed) });
    copied++;
  }
  return copied;
}

// ── Writing ──────────────────────────────────────────────────────────────────

/** One save's changes, applied to the state read just before it is written. */
export interface SeatStateDelta {
  /** Seats into a hold of this kind (a seat already held moves to it). */
  hold?: ReadonlyMap<number, SeatHoldKind>;
  release?: readonly number[];
  /** Seats a move freed, put back on sale: seat -> its on-chain `seatNonces` now. */
  confirm?: ReadonlyMap<number, number>;
}

export interface SeatStateWriter extends SeatStateIO {
  /** The organiser unlock (`auth.ensureOrganiserUnlock()`): throws when declined. */
  unlock(): Promise<void>;
  /** The account's current content-feed signer. */
  signer(): Promise<{ privKey: string; address: string }>;
  /** Whether this device has seen a version of the feed (its version hint). */
  hadVersion(signer: string, topic: string): boolean;
  now(): string;
}

/** The plan a ticket type sells from, as the dashboard loaded it. */
export interface SeatPlanFacts {
  digest: string;
  seats: number;
  /** The plan's own held seats: what a never-written state holds. */
  planHolds: ReadonlyMap<number, SeatHoldKind>;
}

/**
 * Save `delta` to the ticket type's seat state. Asks for the organiser unlock ITSELF,
 * every time (S6 consult): a confirmation is what lets a freed seat sell again, and
 * the feed signer alone - cached on an open device - must not be enough to write one.
 * Then a thorough read of the stored state, `delta` applied to it, `seq` + 1, written,
 * read back. Applying the delta to a fresh read is what keeps two devices from undoing
 * each other's holds: the race is one write wide.
 *
 * Throws `SeatStateUnreadableError` when the stored state cannot be read - and when it
 * reads as never written on a device that has seen a version of it (an absent read
 * that is really an unreachable one), or is not this ticket type's or this plan's.
 * `settled` false: written, but the read-back does not show it yet.
 */
export async function writeSeatState(
  w: SeatStateWriter,
  feed: Pick<EventFeed, "eventId" | "gatewayUrl">,
  seriesId: string,
  plan: SeatPlanFacts,
  delta: SeatStateDelta,
): Promise<{ state: SeatState; settled: boolean }> {
  await w.unlock();
  const signer = await w.signer();
  const [{ seatStateTopic }, { buildSeatState, decodeHeld }] = await Promise.all([
    import("@woco/shared/seating/topics"),
    import("@woco/shared/seating/state"),
  ]);
  const topic = seatStateTopic(feed.eventId, seriesId);

  const route = w.route(feed);

  // The base: the newest WHOLE state. A head that does not validate - a torn paged write
  // (S6 sign-off F1) - or that can never be read, is stepped past: the write then lands
  // after it, and readers that refused it read the new version.
  // Torn versions stepped past may have announced their seq: the new one goes above all.
  let steppedSeq = -1;
  const readDown = async (from: number): Promise<SeatState | null> => {
    const below = await newestWholeBelow(w, signer.address, feed, seriesId, from);
    steppedSeq = below.maxSeq;
    return below.state; // null: every version down to the first is unusable - start from the plan
  };
  const head = await w.read(signer.address, topic, route);
  const headSeq = head.status === "found" ? claimedSeq(head.value) : -1;
  let base: SeatState | null;
  if (head.status === "absent") {
    if (w.hadVersion(signer.address, topic)) throw new SeatStateUnreadableError();
    base = null;
  } else if (head.status === "found" && head.scanClean) {
    base = (await ownSeatState(head.value, feed.eventId, seriesId)) ?? (await readDown(head.version));
  } else if (head.status === "unavailable" && head.unusableAt !== undefined) {
    base = await readDown(head.unusableAt);
  } else {
    throw new SeatStateUnreadableError();
  }
  if (base && (base.planDigest !== plan.digest.toLowerCase() || base.seats !== plan.seats)) {
    throw new SeatStateUnreadableError("This ticket type's seat holds are saved for a different seating plan. Nothing was changed.");
  }

  const holds = new Map<number, SeatHoldKind>();
  if (base) for (const h of base.holds) for (const k of decodeHeld(h.held, base.seats)) holds.set(k, h.kind);
  else for (const [k, kind] of plan.planHolds) holds.set(k, kind);
  const confirmed = new Map<number, number>(base?.confirmed ?? []);
  for (const k of delta.release ?? []) holds.delete(k);
  for (const [k, kind] of delta.hold ?? []) holds.set(k, kind);
  for (const [k, n] of delta.confirm ?? []) confirmed.set(k, n);

  const state = buildSeatState({
    eventId: feed.eventId,
    seriesId,
    planDigest: plan.digest,
    seats: plan.seats,
    holds,
    confirmed,
    seq: Math.max(base ? base.seq : -1, headSeq, steppedSeq) + 1,
    updatedAt: w.now(),
  });
  const version = await w.write({ signerPrivKey: signer.privKey, topic, data: state, route });

  // The EXACT version written (S6 sign-off F2): another device's bytes there mean this
  // write was dropped - a SOC at an existing address keeps the first - and so does a tear.
  const back = await w.readVersion(signer.address, topic, route, version).catch(() => null);
  if (back?.status === "found") {
    // Validated in full: the digest is the last field, so a tear whose last page is ours
    // would match on the field alone. Validation recomputes it over what was read.
    const own = await ownSeatState(back.value, feed.eventId, seriesId);
    if (!own || own.digest !== state.digest) throw new SeatStateConflictError();
    return { state, settled: true };
  }
  return { state, settled: false };
}

/** The live wiring: the app's content-feed reader and writer. */
export async function liveSeatStateIO(): Promise<SeatStateIO> {
  const [{ readContentFeedResult, readContentFeedAtVersion, writeContentFeed }, { feedRouteFor }] = await Promise.all([
    import("../../swarm/content-feed.js"),
    import("../../swarm/gateways.js"),
  ]);
  return {
    read: (signer, topic, route) => readContentFeedResult<unknown>(signer, topic, { route, thorough: true, skipLegacy: true }),
    readVersion: (signer, topic, route, version) => readContentFeedAtVersion<unknown>(signer, topic, version, { route, thorough: true }),
    // A large plan's state is up to ~100 chunks, past one minute of the relay's budget.
    write: (args) => writeContentFeed({ ...args, paceWhenBusy: true }),
    route: (feed) => feedRouteFor(feed.gatewayUrl),
  };
}

/** The dashboard's writer: the live IO plus the organiser unlock and the account's signer. */
export async function liveSeatStateWriter(): Promise<SeatStateWriter> {
  const [io, { auth }, { hintKey }] = await Promise.all([
    liveSeatStateIO(),
    import("../../auth/auth-store.svelte.js"),
    import("../../swarm/content-feed.js"),
  ]);
  return {
    ...io,
    unlock: () => auth.ensureOrganiserUnlock(),
    signer: async () => {
      const s = await auth.getContentFeedSigner();
      if (!s) throw new Error("Sign in again to change seats.");
      return s;
    },
    hadVersion: (signer, topic) => {
      try {
        return localStorage.getItem(hintKey(signer, topic)) !== null;
      } catch {
        return false;
      }
    },
    now: () => new Date().toISOString(),
  };
}
