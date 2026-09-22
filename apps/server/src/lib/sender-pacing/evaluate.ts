/**
 * The bounce and complaint checks, as a pure function of a sender's recent
 * batches. No I/O, no clock of its own — `index.ts` owns both.
 *
 * TWO DENOMINATORS, deliberately. The ALL-SENDS check measures the sender's
 * mail the way SES and Resend measure an account. The NEW-CONTACTS check
 * measures only contacts the sender had never reached through us, the way
 * Mailchimp judges "email addresses you haven't contacted through Mailchimp
 * yet" — without it, a sender with thousands of proven contacts dilutes a dead
 * import: 5,000 good sends hide 200 hard bounces at 3.3%, under every line.
 */

import { PACING_THRESHOLDS, crosses } from "@woco/shared";

export type BatchKind = "p" | "u";

/** What the provider told us about one batch. Counts only — never an address. */
export interface BatchCounts {
  kind: BatchKind;
  startedAt: number;
  /** Messages the provider accepted. */
  accepted: number;
  /** Hard bounces by SES subtype. Every `Permanent` subtype counts. */
  bounces: Record<string, number>;
  /** Complaints that count: a feedback report about a message that was sent. */
  complaints: number;
}

export type HoldCause = "all-bounce" | "all-complaint" | "new-bounce" | "new-complaint";

export interface WindowTotals {
  sends: number;
  bounces: number;
  complaints: number;
}

export interface Evaluation {
  all: WindowTotals;
  new: WindowTotals;
  /** Set when a STOP line is crossed — which line, for the reason text. */
  stop: HoldCause | null;
  /** Every hold line currently crossed. Each lifts on its own. */
  holds: HoldCause[];
}

function total(batches: BatchCounts[]): WindowTotals {
  let sends = 0;
  let bounces = 0;
  let complaints = 0;
  for (const b of batches) {
    sends += b.accepted;
    for (const n of Object.values(b.bounces)) bounces += n;
    complaints += b.complaints;
  }
  return { sends, bounces, complaints };
}

/**
 * @param batches only those inside the window — the caller filters by age and
 *   by the last operator lift, so this never needs a clock.
 */
export function evaluate(batches: BatchCounts[]): Evaluation {
  const all = total(batches);
  const fresh = total(batches.filter((b) => b.kind === "u"));
  const T = PACING_THRESHOLDS;

  let stop: HoldCause | null = null;
  if (crosses(T.stopBounce, fresh.bounces, fresh.sends)) stop = "new-bounce";
  else if (crosses(T.stopComplaint, fresh.complaints, fresh.sends)) stop = "new-complaint";
  else if (crosses(T.stopBounce, all.bounces, all.sends)) stop = "all-bounce";
  else if (crosses(T.stopComplaint, all.complaints, all.sends)) stop = "all-complaint";

  const holds: HoldCause[] = [];
  if (crosses(T.holdBounce, all.bounces, all.sends)) holds.push("all-bounce");
  if (crosses(T.holdComplaint, all.complaints, all.sends)) holds.push("all-complaint");
  if (crosses(T.holdBounce, fresh.bounces, fresh.sends)) holds.push("new-bounce");
  if (crosses(T.holdComplaint, fresh.complaints, fresh.sends)) holds.push("new-complaint");

  return { all, new: fresh, stop, holds };
}

/**
 * How far a hold reaches. A complaint across ALL the sender's mail is about
 * the sender's mail, so everything waits; every other cause is evidence about
 * the new contacts, so only they wait and proven contacts keep receiving.
 */
export function holdScope(holds: HoldCause[]): "all" | "new" | null {
  if (holds.includes("all-complaint")) return "all";
  return holds.length > 0 ? "new" : null;
}
