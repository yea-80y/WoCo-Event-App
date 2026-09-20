/**
 * The lap journal: what this phone knows about the rider's taps, before and
 * after the network does.
 *
 * WHY IT EXISTS. A lap's time is only worth keeping if it is the time of the
 * TAP. Reading the clock after the write resolves is late by the write, late by
 * the whole sign-in flow on a first tap, and simply absent when there is no
 * signal — and a park is where signal is worst. So the tap is written down HERE
 * first, synchronously, and everything that needs the network happens
 * afterwards, from this record, as many times as it takes.
 *
 * PURE. No storage, no clock, no auth — the same split as `next-statement.ts`
 * and `partition.ts`, and for the same reason: the rules below are the ones
 * that decide whether a rider's permanent, write-once count is right, so they
 * are pinned by tests rather than exercised by hand on a phone.
 *
 * THE RULE THAT MATTERS MOST lives in {@link beginPrepared}: a group of taps is
 * bound to ONE exact write (`prepared`) before anything is uploaded, and every
 * retry re-sends that write unchanged. With patchy signal an upload can land
 * while its reply is lost. A retry that built a fresh statement would then read
 * the landed one as the previous head and add the same laps a second time —
 * permanently. Re-sending identical bytes to the identical address cannot: a
 * chunk that already exists is deduped, and the read-back reports it verified.
 */

import { LAP_DIARY_MAX_TIMES, type CreditStatementV1 } from "@woco/shared";
import type { CreditVisibility } from "./visibility.js";

export const LAP_JOURNAL_VERSION = 1 as const;

/** One exact write, bound to the taps it carries. JSON-safe: it is persisted. */
export interface PreparedRide {
  /** The taps this write records — each a time read at its own tap. */
  times: number[];
  statement: CreditStatementV1;
  visibility: CreditVisibility;
  /** The band the write targets. */
  band: number;
  /** The exact SOC version, or null when the write has to probe for one — only
   *  ever a rider's first lap of a subject. */
  version: number | null;
  /** The EXACT data to upload: the sealed box for a private head, the statement
   *  itself for a public one. Replayed as is; re-sealing would change the bytes
   *  and turn an idempotent retry back into a second statement. */
  body: unknown;
  /** Whether the subject was already in its partition's index when prepared. */
  indexed: boolean;
  /** Whether this write opens a new band, so the index entry needs raising. */
  rollover: boolean;
  /** An upload of this write has been started at least once. */
  attempted: boolean;
  /** An upload of this write was ACCEPTED. The count on screen already includes
   *  it; it stays here until the read-back settles so a reload can still resolve
   *  a `superseded` by replaying it. */
  accepted: boolean;
}

/** A prepared write as the write path builds it — the sender adds the two
 *  progress flags when it binds the taps to it. */
export type PreparedRideDraft = Omit<PreparedRide, "attempted" | "accepted">;

/** Laps that are in a landed statement, and whether their times are sealed yet. */
export interface CountedLaps {
  seq: number;
  total: number;
  times: number[];
  sealed: boolean;
}

export interface LapJournal {
  v: typeof LAP_JOURNAL_VERSION;
  /** Tap times not yet bound to any write, in tap order. */
  waiting: number[];
  /** At most ONE write in flight or in doubt. */
  prepared: PreparedRide | null;
  /** Landed groups, oldest first. Kept for the rider's list and for sealing. */
  counted: CountedLaps[];
  /**
   * Waiting taps dated before this UTC date are HELD, not sent. Set when the
   * live head turned out to be on a later date than the taps — which one phone
   * cannot cause (the sender is oldest-date-first) and a second device can.
   * Neither honest write exists for that case today: folding the laps into the
   * later day signs a false date, and writing the true date after a newer head
   * signs a false COUNT, because the carry rule resets `session.count` whenever
   * the date differs. Holding signs nothing.
   */
  heldBefore: string | null;
}

export function emptyJournal(): LapJournal {
  return { v: LAP_JOURNAL_VERSION, waiting: [], prepared: null, counted: [], heldBefore: null };
}

function isTime(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0;
}

/**
 * Accept only what this version wrote. Anything else reads as an empty journal
 * rather than a crash on every tap — but note what that costs, which is why the
 * checks are no stricter than the code below needs: a journal rejected here is
 * a rider's unsent laps discarded.
 */
export function parseJournal(raw: unknown): LapJournal {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return emptyJournal();
  const o = raw as Partial<LapJournal>;
  if (o.v !== LAP_JOURNAL_VERSION) return emptyJournal();
  if (!Array.isArray(o.waiting) || !o.waiting.every(isTime)) return emptyJournal();
  if (!Array.isArray(o.counted)) return emptyJournal();
  const countedOk = o.counted.every(
    (c) =>
      c !== null &&
      typeof c === "object" &&
      Number.isSafeInteger(c.seq) &&
      Number.isSafeInteger(c.total) &&
      Array.isArray(c.times) &&
      c.times.every(isTime) &&
      typeof c.sealed === "boolean",
  );
  if (!countedOk) return emptyJournal();
  const p = o.prepared ?? null;
  if (p !== null) {
    const ok =
      typeof p === "object" &&
      Array.isArray(p.times) &&
      p.times.every(isTime) &&
      p.statement !== null &&
      typeof p.statement === "object" &&
      (p.visibility === "public" || p.visibility === "private") &&
      Number.isSafeInteger(p.band) &&
      (p.version === null || Number.isSafeInteger(p.version));
    if (!ok) return emptyJournal();
  }
  return {
    v: LAP_JOURNAL_VERSION,
    waiting: [...o.waiting],
    prepared: p,
    counted: o.counted.map((c) => ({ ...c, times: [...c.times] })),
    heldBefore: typeof o.heldBefore === "string" ? o.heldBefore : null,
  };
}

/** The UTC calendar date of a tap — the statement's signed `session.date`. */
export function utcDateOf(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * The one UTC date a statement for these taps signs. From the TAPS, never from
 * the clock at send: laps tapped on Monday and sent after midnight were ridden
 * on Monday. Throws on mixed dates — {@link nextGroup} never produces them, and
 * a statement has one `session.date`, so there is no honest way to proceed.
 */
export function rideDate(times: readonly number[]): string {
  if (times.length < 1) throw new Error("no laps to date");
  const date = utcDateOf(times[0]!);
  if (times.some((at) => utcDateOf(at) !== date)) {
    throw new Error("laps from different days cannot share a statement");
  }
  return date;
}

/** Record a tap. `at` is the clock read at the tap and is never recomputed. */
export function addTap(j: LapJournal, at: number): LapJournal {
  if (!isTime(at)) throw new Error(`invalid tap time: ${at}`);
  return { ...j, waiting: [...j.waiting, at] };
}

function isHeld(j: LapJournal, at: number): boolean {
  return j.heldBefore !== null && utcDateOf(at) < j.heldBefore;
}

/**
 * The next group to send: every sendable waiting tap of the OLDEST UTC date, in
 * tap order. One statement per date, not one per lap — the statement carries no
 * times, so per-lap writes would spend `seq`, SOC versions and the relay's
 * statement bucket to say nothing the grouped one does not.
 *
 * Oldest DATE, not first in the queue: a clock correction can put a later tap
 * earlier, and sending a newer date first is exactly what would strand the
 * older one behind a newer head (see `heldBefore`).
 */
export function nextGroup(
  j: LapJournal,
  max: number = LAP_DIARY_MAX_TIMES,
): { date: string; times: number[] } | null {
  const sendable = j.waiting.filter((at) => !isHeld(j, at));
  if (sendable.length === 0) return null;
  const date = sendable.map(utcDateOf).reduce((a, b) => (a < b ? a : b));
  return { date, times: sendable.filter((at) => utcDateOf(at) === date).slice(0, max) };
}

/** Remove one occurrence of each of `times` from `from`. */
function without(from: readonly number[], times: readonly number[]): number[] {
  const out = [...from];
  for (const t of times) {
    const i = out.indexOf(t);
    if (i === -1) throw new Error("prepared write names a tap that is not waiting");
    out.splice(i, 1);
  }
  return out;
}

/**
 * Bind a group of waiting taps to one exact write. The caller PERSISTS the
 * result before uploading anything — that ordering is the whole guarantee, so
 * it is the sender's first tested property rather than a convention.
 */
export function beginPrepared(j: LapJournal, prepared: PreparedRide): LapJournal {
  if (j.prepared !== null) throw new Error("a prepared write is already outstanding");
  if (prepared.times.length < 1) throw new Error("a prepared write must carry at least one tap");
  return { ...j, waiting: without(j.waiting, prepared.times), prepared };
}

export function markAttempted(j: LapJournal): LapJournal {
  return j.prepared ? { ...j, prepared: { ...j.prepared, attempted: true } } : j;
}

export function markAccepted(j: LapJournal): LapJournal {
  return j.prepared ? { ...j, prepared: { ...j.prepared, attempted: true, accepted: true } } : j;
}

/** The prepared write is what its version of the feed holds. */
export function preparedLanded(j: LapJournal): LapJournal {
  if (!j.prepared) return j;
  const { statement, times } = j.prepared;
  return {
    ...j,
    prepared: null,
    counted: [...j.counted, { seq: statement.seq, total: statement.total, times: [...times], sealed: false }],
  };
}

/** Another writer's bytes are at that version: the taps go back to the FRONT,
 *  with their original times, to be built on the winner's head. */
export function preparedLost(j: LapJournal): LapJournal {
  if (!j.prepared) return j;
  return { ...j, prepared: null, waiting: [...j.prepared.times, ...j.waiting] };
}

export function holdBefore(j: LapJournal, date: string): LapJournal {
  return { ...j, heldBefore: j.heldBefore !== null && j.heldBefore > date ? j.heldBefore : date };
}

/** The oldest landed group whose times are not sealed yet. */
export function nextUnsealed(j: LapJournal): CountedLaps | null {
  return j.counted.find((c) => !c.sealed) ?? null;
}

export function markSealed(j: LapJournal, seq: number): LapJournal {
  return { ...j, counted: j.counted.map((c) => (c.seq === seq ? { ...c, sealed: true } : c)) };
}

/** Drop sealed groups older than `keepMs`. Unsealed ones are never dropped:
 *  this journal is the only copy of their times. */
export function pruneJournal(j: LapJournal, now: number, keepMs: number): LapJournal {
  return {
    ...j,
    counted: j.counted.filter((c) => !c.sealed || Math.max(...c.times) >= now - keepMs),
  };
}

export interface JournalCounts {
  /** Taps the rider made that are in no accepted write yet. NEVER part of the
   *  count on screen: that number is always one somebody wrote. */
  waiting: number;
  /** Waiting taps that cannot be sent (see `heldBefore`). Included in `waiting`. */
  held: number;
  /** Counted laps whose times exist only on this phone so far. */
  unsealed: number;
}

export function journalCounts(j: LapJournal): JournalCounts {
  const inDoubt = j.prepared && !j.prepared.accepted ? j.prepared.times.length : 0;
  return {
    waiting: j.waiting.length + inDoubt,
    held: j.waiting.filter((at) => isHeld(j, at)).length,
    unsealed: j.counted.filter((c) => !c.sealed).reduce((n, c) => n + c.times.length, 0),
  };
}

/** The newest tap this phone knows of, for the accidental-double-tap guard.
 *  From the journal rather than memory so a reload does not reset it. */
export function lastTapAt(j: LapJournal): number {
  const all = [...j.waiting, ...(j.prepared?.times ?? []), ...j.counted.flatMap((c) => c.times)];
  return all.length === 0 ? 0 : Math.max(...all);
}

/**
 * What the card shows. `counted` is the carried total of a statement this
 * device has actually seen — a live head, else the remembered number — and
 * waiting laps are reported beside it, never folded in. A public counter only
 * moves when laps are sent; the rider's own screen must not claim otherwise.
 */
export function cardNumbers(args: {
  headTotal: number | null;
  rememberedTotal: number | null;
  journal: LapJournal;
}): { counted: number; waiting: number } {
  return {
    counted: args.headTotal ?? args.rememberedTotal ?? 0,
    waiting: journalCounts(args.journal).waiting,
  };
}

export interface LapRow {
  at: number;
  /** The lap's lifetime number, known once it is in a landed statement. */
  lap: number | null;
  state: "counted" | "waiting" | "held";
}

/** Every tap this phone knows of on the day `dayOf` names, oldest first. */
export function lapRows(j: LapJournal, dayOf: (at: number) => string, day: string): LapRow[] {
  const rows: LapRow[] = [];
  for (const c of j.counted) {
    const sorted = [...c.times].sort((a, b) => a - b);
    sorted.forEach((at, i) => rows.push({ at, lap: c.total - sorted.length + 1 + i, state: "counted" }));
  }
  // An accepted write is already in the count on screen, so its laps read as
  // counted here too — but unnumbered until the read-back confirms the total.
  for (const at of j.prepared?.times ?? []) {
    rows.push({ at, lap: null, state: j.prepared?.accepted ? "counted" : "waiting" });
  }
  for (const at of j.waiting) rows.push({ at, lap: null, state: isHeld(j, at) ? "held" : "waiting" });
  return rows.filter((r) => dayOf(r.at) === day).sort((a, b) => a.at - b.at);
}
