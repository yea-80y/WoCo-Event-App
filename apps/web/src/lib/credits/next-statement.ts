/**
 * The carry rule: how one ride becomes the next statement.
 *
 * Separate from `credits.ts` because that module reaches the auth store, and
 * this is the one piece with a failure mode worth pinning in a test — the
 * frozen aggregation rule is that `total` is CARRIED on each statement and
 * never summed across writes, so an indexer reading eight statements sees the
 * rider's total, not the sum of eight totals. Getting the carry backwards is
 * how "8 taps" becomes "36 rides".
 */

import {
  CREDIT_STATEMENT_FORMAT,
  type CreditStatementV1,
  type UnsignedCreditStatementV1,
  type Hex0x,
} from "@woco/shared";

/** UTC, per the frozen decision — a signed field must not depend on the
 *  mutable subject registry, so `date` never means "park-local". At a UTC-8
 *  park every day splits mid-afternoon; display recombines through the
 *  registry timezone. */
export function utcSessionDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Build the statement that records `laps` more rides, given the current head
 * (`null` on a rider's first ride of this subject).
 *
 * `seq` increments on every write and is the ordering authority. The session
 * block resets when the UTC date rolls over, because it describes TODAY —
 * older days stay readable as older SOC versions, which is why no history
 * mechanism is needed here.
 */
export function nextCreditStatement(args: {
  prev: CreditStatementV1 | null;
  subject: Hex0x;
  holder: string;
  laps: number;
  date?: string;
}): UnsignedCreditStatementV1 {
  const { prev, subject, holder, laps } = args;
  if (!Number.isSafeInteger(laps) || laps < 1) {
    throw new Error(`laps must be a positive whole number, got ${laps}`);
  }
  const date = args.date ?? utcSessionDate();
  const sameDay = prev !== null && prev.session.date === date;

  return {
    format: CREDIT_STATEMENT_FORMAT,
    subject,
    holder,
    seq: prev ? prev.seq + 1 : 0,
    total: (prev?.total ?? 0) + laps,
    session: {
      date,
      count: (sameDay ? prev.session.count : 0) + laps,
    },
  };
}
