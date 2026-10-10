/**
 * `woco.lap-diary.v1` — the rider's own lap times, sealed to the rider.
 *
 * The landing place docs/COASTER_CREDITS_PLAN.md reserved under "Times:
 * attested only, never declared": a sealed private sidecar, never inside the
 * public statement. `woco.credit.v1` is closed and carries no times on purpose
 * — a declared time proves nothing to anyone else, and a public per-ride time
 * is a routine profile of a minor-heavy audience. Neither objection applies to
 * a record only the rider can open, which is what this is.
 *
 * ONE WRITE-ONCE ENTRY PER STATEMENT `seq`, not one list per day rewritten on
 * each tap. The rewritten list was the first proposal and was rejected for
 * three reasons that all point the same way:
 *  - it is a read-modify-write snapshot, the one write shape in this rail that
 *    can verify perfectly while erasing what came before it;
 *  - a 130-lap day makes it a 130-version feed with no bands, which is the
 *    lookup cost banding exists to remove;
 *  - sealed ciphertext is hex, so late in the day every tap would re-upload the
 *    whole day as several chunks.
 * An entry per `seq` needs no head, no band and no index — the statement head's
 * own `seq` bounds the address space — and losing one write loses one entry.
 *
 * CLOSED, like every format here, although nothing public reads it: entries are
 * write-once at computed addresses, so whatever a future build finds there it
 * must be able to dispatch on. Any added field is `woco.lap-diary.v2`.
 */

import type { Hex0x } from "../types.js";
import { privateTopicSalt, statementTopic, subjectToBytes } from "../statement/discipline.js";

export const LAP_DIARY_FORMAT = "woco.lap-diary.v1" as const;

/** Discipline (type, version) the salt and topic derive from. */
const LAP_DIARY_TYPE = "lap-diary";
const LAP_DIARY_VERSION = 1;

/**
 * Most times one entry may carry, and therefore the most laps one statement may
 * record when its times are wanted. A whole offline day is well inside it; the
 * bound exists so a reader never allocates on a number it found on the network.
 */
export const LAP_DIARY_MAX_TIMES = 256;

export interface LapDiaryEntryV1 {
  format: typeof LAP_DIARY_FORMAT;
  subject: Hex0x;
  /** The `seq` of the statement these laps landed in. Also what the address is
   *  derived from — carried INSIDE the sealed payload so a box found at the
   *  wrong address is rejected rather than shown against the wrong laps. */
  seq: number;
  /** The carried `total` of that statement, copied. The statement stays the
   *  authority; this is here so laps can be NUMBERED (`total - times.length + 1`
   *  onward) even when a neighbouring entry never landed — without it one
   *  missing entry would shift every older lap's number. */
  total: number;
  /** One per lap in that statement: whole UTC milliseconds, read from the
   *  rider's clock at the tap, ascending. Never the time the write was sent. */
  times: number[];
}

/** The rider's diary salt: HMAC(x25519PrivKey, "woco-lap-diary-topic-salt-v1").
 *  Its own label, so a disclosed diary topic says nothing about the logbook's. */
export function lapDiaryPrivateSalt(encryptionPrivKey: Uint8Array): Uint8Array {
  return privateTopicSalt(encryptionPrivKey, LAP_DIARY_TYPE, LAP_DIARY_VERSION);
}

/**
 * Topic of the entry for one (subject, seq):
 * `"woco/lap-diary/v1/" + hex(HMAC-SHA256(salt, subjectBytes || uint64BE(seq)))`.
 *
 * Deliberately the statement topic recipe with `seq` in the position a banded
 * feed puts its band: the same pinned 40-byte message, no second encoding to
 * get wrong. The entry is always VERSION 0 of this topic and is never rewritten.
 */
export function lapDiaryEntryTopic(salt: Uint8Array, subject: Hex0x, seq: number): string {
  return statementTopic(LAP_DIARY_TYPE, LAP_DIARY_VERSION, salt, subjectToBytes(subject), seq);
}

const SUBJECT_RE = /^0x[0-9a-f]{64}$/;

function isCount(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

/** Closed-schema validation. Unknown fields are REJECTED, not ignored. */
export function validateLapDiaryEntryV1(value: unknown): value is LapDiaryEntryV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  if (keys.join(",") !== "format,seq,subject,times,total") return false;
  if (o.format !== LAP_DIARY_FORMAT) return false;
  if (typeof o.subject !== "string" || !SUBJECT_RE.test(o.subject)) return false;
  if (!isCount(o.seq) || !isCount(o.total)) return false;
  if (!Array.isArray(o.times)) return false;
  const times = o.times as unknown[];
  if (times.length < 1 || times.length > LAP_DIARY_MAX_TIMES) return false;
  // A statement cannot have recorded more laps than its own lifetime total.
  if (o.total < times.length) return false;
  let last = 0;
  for (const t of times) {
    if (!isCount(t) || t < 1 || t < last) return false;
    last = t;
  }
  return true;
}

/**
 * Build an entry. SORTS, because a phone clock can step backwards between two
 * taps (a network time correction) and an entry that failed its own validator
 * would strand those times on the device forever. Sorting changes which lap a
 * time is listed against, never which times were recorded.
 */
export function buildLapDiaryEntry(args: {
  subject: Hex0x;
  seq: number;
  total: number;
  times: readonly number[];
}): LapDiaryEntryV1 {
  const entry: LapDiaryEntryV1 = {
    format: LAP_DIARY_FORMAT,
    subject: args.subject,
    seq: args.seq,
    total: args.total,
    times: [...args.times].sort((a, b) => a - b),
  };
  if (!validateLapDiaryEntryV1(entry)) throw new Error("invalid woco.lap-diary.v1 entry");
  return entry;
}
