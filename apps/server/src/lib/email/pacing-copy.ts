/**
 * What an organiser is told when sender pacing (#619) pauses or stops their
 * marketing. Composed here, where the numbers are, and shown verbatim by the
 * app — the same way a job's `reason` already is.
 *
 * Every sentence says what happened, why it matters to them, and what happens
 * next; none of them asks the organiser to do something they cannot do.
 */

import { PACING_THRESHOLDS, SUPPORT_EMAIL } from "@woco/shared";
import type { HoldCause, PacingState } from "../sender-pacing/index.js";
import type { Evaluation } from "../sender-pacing/evaluate.js";

const n = (x: number) => x.toLocaleString("en-GB");
const plural = (x: number, one: string, many: string) => (x === 1 ? one : many);

/** "4 in 100" / "8 in 10,000" — a rate as the organiser can picture it. */
function perHundred(rate: number): string {
  const per = rate >= 0.01 ? 100 : 10_000;
  return `${n(Math.round(rate * per))} in ${n(per)}`;
}

function pickCause(causes: HoldCause[]): HoldCause {
  for (const c of ["all-complaint", "new-complaint", "new-bounce", "all-bounce"] as const) {
    if (causes.includes(c)) return c;
  }
  return causes[0]!;
}

function what(cause: HoldCause, w: Evaluation): string {
  switch (cause) {
    case "new-bounce":
      return `${n(w.new.bounces)} of ${n(w.new.sends)} new contacts bounced`;
    case "all-bounce":
      return `${n(w.all.bounces)} of your last ${n(w.all.sends)} emails bounced`;
    case "new-complaint":
      return `${n(w.new.complaints)} of your new contacts marked your email as spam`;
    case "all-complaint":
      return `${n(w.all.complaints)} ${plural(w.all.complaints, "person", "people")} marked your email as spam`;
  }
}

/** The message for a pause, or null when the sender is not paused. */
export function pausedMessage(state: PacingState, w: Evaluation): string | null {
  if (state.kind !== "held") return null;
  const cause = pickCause(state.causes);
  const bounce = cause.endsWith("bounce");
  const T = PACING_THRESHOLDS;
  const line = bounce ? T.holdBounce.rate : T.holdComplaint.rate;
  const count = bounce
    ? cause === "new-bounce" ? w.new.bounces : w.all.bounces
    : cause === "new-complaint" ? w.new.complaints : w.all.complaints;
  const removed = `${plural(count, "That address has", `Those ${n(count)} addresses have`)} been removed.`;

  if (state.scope === "all") {
    return (
      `Paused - ${what(cause, w)}. Above ${perHundred(line)} we pause your marketing email, ` +
      `because complaints affect delivery for every organiser on WoCo. ${removed} ` +
      `Sending resumes on its own once your complaint rate over the past 7 days is under that level.`
    );
  }
  return (
    `Paused for new contacts - ${what(cause, w)}. Above ${perHundred(line)} we pause new contacts, ` +
    `because ${bounce ? "a list that bounces" : "complaints"} affect${bounce ? "s" : ""} email delivery for every organiser on WoCo. ` +
    `${removed} Sending resumes on its own once your ${bounce ? "bounce" : "complaint"} rate over the past 7 days is under ` +
    `${bounce ? `${Math.round(line * 100)}%` : "that level"}. People you've emailed before are unaffected.`
  );
}

/** The message for a stop — automatic (with its numbers) or placed by an operator. */
export function stoppedMessage(state: PacingState, w: Evaluation): string | null {
  if (state.kind !== "stopped") return null;
  const contact = `Contact ${SUPPORT_EMAIL} to have it reviewed.`;
  if (!state.cause) {
    return `Stopped - marketing email from your account is switched off while we look into it. ${contact}`;
  }
  const bounce = state.cause.endsWith("bounce");
  return (
    `Stopped - ${what(state.cause, w)}. That is the level at which our email provider can suspend ` +
    `sending for the whole platform, so marketing email from your account is switched off until we ` +
    `have looked at it. The ${bounce ? "bounced" : "reported"} addresses have already been removed. ${contact}`
  );
}

export function pacingNotice(state: PacingState, w: Evaluation): string | null {
  return stoppedMessage(state, w) ?? pausedMessage(state, w);
}
