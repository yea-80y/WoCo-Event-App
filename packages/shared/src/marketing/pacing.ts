/**
 * Paced sending to contacts new to the platform (#619) — the numbers.
 *
 * Shared so the composer's "about 10 hours" and the server's gate are computed
 * by the same function and cannot drift apart.
 *
 * THE LADDER is Resend's warm-up table for an EXISTING domain, both columns
 * (https://resend.com/docs/knowledge-base/warming-up). Resend is a multi-tenant
 * sender on Amazon SES — its domain setup publishes `include:amazonses.com` —
 * which is WoCo's own position, so its schedule is the closest published
 * analogue. Existing rather than new-domain: the mail leaves on WoCo's marketing
 * subdomain, which has history; what is new is each sender's list, so the
 * ladder is climbed PER SENDER. The per-hour figure is the batch size (batches
 * are at least an hour apart) and the per-day figure is the day's ceiling. The
 * table ends at day 7; its last row continues indefinitely rather than turning
 * pacing off, so a stale list imported a year later is still paced — at the
 * sender's rung, which does not decay — rather than sent at once.
 *
 * THE THRESHOLDS: hold at Resend's published lines (bounce under 4%, spam
 * under 0.08% — https://resend.com/docs/knowledge-base/account-quotas-and-limits),
 * stop at the lines where SES says it may pause the account (10% / 0.5% —
 * https://docs.aws.amazon.com/ses/latest/dg/faqs-enforcement.html). The floors
 * are not published anywhere; each is the rate applied to a ladder figure, so
 * one event on a small batch cannot trip a rate (owner-accepted 2026-09-22).
 */

export interface PacingRung {
  /** New contacts per batch — Resend's per-hour maximum. */
  batchMax: number;
  /** New contacts per UTC day — Resend's per-day maximum. */
  dayMax: number;
}

export const PACING_LADDER: readonly PacingRung[] = [
  { batchMax: 100, dayMax: 1_000 },
  { batchMax: 300, dayMax: 2_500 },
  { batchMax: 600, dayMax: 5_000 },
  { batchMax: 800, dayMax: 5_000 },
  { batchMax: 1_000, dayMax: 7_500 },
  { batchMax: 1_500, dayMax: 7_500 },
  { batchMax: 2_000, dayMax: 10_000 },
];

/**
 * New contacts are stored and sent in chunks of this size. Every `batchMax`
 * and every `dayMax` above is a multiple of it, so a batch is always whole
 * chunks and a chunk is deleted the moment its batch has gone.
 */
export const PACING_CHUNK = 100;

/** Minimum gap between the STARTS of two batches of new contacts. */
export const PACING_BATCH_GAP_MS = 60 * 60_000;

/** How far back the bounce and complaint checks look. */
export const PACING_WINDOW_MS = 7 * 24 * 60 * 60_000;

/**
 * A contact accepted by the provider becomes "proven" once this has passed with
 * no hard bounce. Hard bounces arrive within minutes; an hour is the batch gap,
 * so a contact is proven before the batch after the one that reached them.
 */
export const PACING_PROOF_DELAY_MS = 60 * 60_000;

/**
 * The longest a paced send may hold its recipients, whatever its schedule
 * says. No external source: the owner's call, matched to the pacing window so
 * one number governs both (2026-09-22).
 */
export const PACING_MAX_HOLD_MS = 7 * 24 * 60 * 60_000;

/** Headroom on top of a paced send's planned end: a day rollover and a short pause. */
export const PACING_HOLD_SLACK_MS = 24 * 60 * 60_000;

export interface PacingThreshold {
  rate: number;
  floor: number;
}

export const PACING_THRESHOLDS = {
  /** Resend: "All accounts must maintain a bounce rate of under 4%." */
  holdBounce: { rate: 0.04, floor: 4 },
  /** SES: "If your bounce rate is 10% or greater, we might pause". */
  stopBounce: { rate: 0.1, floor: 10 },
  /** Resend: "All accounts must have a spam rate of under 0.08%." */
  holdComplaint: { rate: 0.0008, floor: 2 },
  /** SES: "If your complaint rate is 0.5% or greater, we might pause". */
  stopComplaint: { rate: 0.005, floor: 5 },
} as const satisfies Record<string, PacingThreshold>;

/**
 * `count >= floor AND count / sends >= rate`. A denominator smaller than the
 * count (a bounce recorded before its send was) is read as the count, so the
 * rate can only be over-stated, never divided by zero.
 */
export function crosses(t: PacingThreshold, count: number, sends: number): boolean {
  return count >= t.floor && count / Math.max(sends, count, 1) >= t.rate;
}

/** 1-based rung for a sender with this many EARLIER sending days. */
export function pacingRung(earlierSendingDays: number): number {
  return Math.min(PACING_LADDER.length, 1 + Math.max(0, Math.floor(earlierSendingDays)));
}

export function rungLimits(rung: number): PacingRung {
  return PACING_LADDER[Math.min(PACING_LADDER.length, Math.max(1, rung)) - 1]!;
}

/** `YYYY-MM-DD` of the UTC day containing `ms`. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function nextUtcMidnight(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/**
 * Where a sender stands on the ladder at one instant. Everything the gate and
 * the estimate need, and nothing that identifies anyone.
 */
export interface PacingPosition {
  /** Distinct UTC days BEFORE today on which the sender sent to new contacts. */
  earlierSendingDays: number;
  /** New contacts already admitted today (UTC). */
  admittedToday: number;
  /** Earliest start of the next batch of new contacts, ms; null = now. */
  nextAllowedAt: number | null;
  /** The instant this position describes, ms. */
  at: number;
}

/**
 * How many new contacts may go in a batch starting at `at`, given the
 * position. Whole chunks only: a partial chunk would have to be re-sealed.
 */
export function batchAllowance(pos: PacingPosition): { rung: number; size: number; dayRemaining: number } {
  const rung = pacingRung(pos.earlierSendingDays);
  const { batchMax, dayMax } = rungLimits(rung);
  const dayRemaining = Math.max(0, dayMax - pos.admittedToday);
  const size = Math.floor(Math.min(batchMax, dayRemaining) / PACING_CHUNK) * PACING_CHUNK;
  return { rung, size, dayRemaining };
}

export interface PacingSchedule {
  batches: number;
  /** Start of the last batch, ms. The sends themselves take seconds. */
  endsAt: number;
}

/**
 * Simulate the batches `unproven` new contacts would need, starting no earlier
 * than `pos.at`. Pure: assumes no pause, which is the estimate an organiser is
 * shown and the base of the hold bound.
 */
export function planSchedule(pos: PacingPosition, unproven: number): PacingSchedule {
  let remaining = Math.max(0, Math.floor(unproven));
  if (remaining === 0) return { batches: 0, endsAt: pos.at };

  let t = Math.max(pos.at, pos.nextAllowedAt ?? pos.at);
  let day = utcDay(pos.at);
  let earlier = pos.earlierSendingDays;
  let admitted = pos.admittedToday;
  let dayHadBatch = admitted > 0;
  let batches = 0;
  let last = t;

  // Bounded: every pass either sends a batch or moves to the next day, and the
  // smallest day ceiling is ten batches, so this cannot spin.
  for (let guard = 0; remaining > 0 && guard < 100_000; guard++) {
    const today = utcDay(t);
    if (today !== day) {
      if (dayHadBatch) earlier++;
      day = today;
      admitted = 0;
      dayHadBatch = false;
    }
    const { size } = batchAllowance({ earlierSendingDays: earlier, admittedToday: admitted, nextAllowedAt: null, at: t });
    if (size <= 0) {
      t = nextUtcMidnight(t);
      continue;
    }
    const n = Math.min(size, remaining);
    remaining -= n;
    admitted += n;
    dayHadBatch = true;
    batches++;
    last = t;
    t += PACING_BATCH_GAP_MS;
  }
  return { batches, endsAt: last };
}
