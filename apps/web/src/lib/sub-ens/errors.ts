/**
 * Sub-ENS server failures, as sentences a person can act on.
 *
 * Every name route answers with a machine code in `error` — `mint_rate_cap`,
 * `name_change_cooldown`, `profile_name` — and the UI rendered that code
 * verbatim, so a user hitting the rename cooldown read the literal string
 * "name_change_cooldown" (#484). The codes are the right wire format; they are
 * simply not the right thing to show. This module is the one place that turns
 * one into the other, so the copy cannot drift between the profile page, the
 * event builder and the site builder.
 *
 * Pure by design: no DOM, no `Date` formatting, no fetch. `retryAt` is handed
 * back as a number and `formatRetryAt` takes `now` as an argument, so both are
 * testable without a clock or a browser.
 */

import { ApiError } from "../api/errors.js";

/**
 * The failure body as it arrives on the client. `safeJson` spreads the whole
 * JSON body into the response object, so these route-specific fields DO reach
 * us — `data.windowResetsAt` from the mint cap, `nextChangeAllowedAt` and
 * `label` from the rename cooldown.
 */
export interface SubEnsErrorEnvelope {
  error?: string;
  status?: number;
  data?: { windowResetsAt?: number } | null;
  nextChangeAllowedAt?: number | null;
  label?: string;
}

export interface SubEnsErrorDescription {
  /** One sentence naming what happened. Always present. */
  title: string;
  /** One sentence saying what to do about it, when there is anything to do. */
  detail?: string;
  /**
   * When the action becomes possible again, in epoch MILLISECONDS — always,
   * whatever unit the server sent. The two sources disagree: the registrar's
   * `MintRateCapExceeded` carries a block timestamp (unix SECONDS), while the
   * rename ledger's `nextChangeAllowedAt` is already ms. Converting at the edge
   * means no caller has to know which one it is holding.
   */
  retryAt?: number;
}

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

export function describeSubEnsError(env: SubEnsErrorEnvelope): SubEnsErrorDescription {
  switch (env.error) {
    case "mint_rate_cap": {
      // `WoCoRegistrar._consumeMintAllowance` reverts with
      // `w.start + mintWindowSeconds` — a block timestamp, so UNIX SECONDS.
      const secs = env.data?.windowResetsAt;
      return {
        title: "You've registered as many names as you can for now.",
        detail: "You can register another one after the wait ends.",
        ...(typeof secs === "number" && secs > 0 ? { retryAt: secs * MS_PER_SECOND } : {}),
      };
    }
    case "name_change_cooldown": {
      // `nameChangeStatus` returns `lastChangedAt + NAME_CHANGE_COOLDOWN_MS`,
      // both already epoch ms — scaling this one would put the retry 50 years out.
      const at = env.nextChangeAllowedAt;
      return {
        title: "Your profile name was changed recently.",
        detail: "You can change it again once the cooldown ends.",
        ...(typeof at === "number" && at > 0 ? { retryAt: at } : {}),
      };
    }
    case "profile_name":
      return {
        title: "That's your profile name.",
        detail: "It can't be used as a site or event address — pick a different name.",
      };
    case "rate_limited":
      return { title: "Too many requests right now.", detail: "Wait a few minutes and try again." };
    case "release_in_flight":
      return { title: "That name is already being released.", detail: "Give it a minute, then refresh." };
    case "expiration_out_of_range":
      return { title: "That signature expired before it reached us.", detail: "Try again." };
    case "not_owner":
      return {
        title: "You don't own that name any more.",
        detail: "It was transferred or released, so it can't be updated from here.",
      };
    // Two spellings of one outcome: the deploy response says `unverified`, the
    // shared ownership gate (`refuseUnlessOwner`) says `ownership_unverified`.
    // Both mean "the chain did not answer", which is NOT evidence of loss.
    case "unverified":
    case "ownership_unverified":
      return {
        title: "Couldn't confirm your name on-chain right now.",
        detail: "Nothing was changed — try again in a minute.",
      };
    // Handled by the attendee-gate flow, which opens the gate rather than
    // showing text. Described here only so a caller that reaches the fallback
    // path still shows a sentence.
    case "ticket_required":
      return { title: "Link a ticket to unlock your account first" };
    default:
      // Several routes answer with prose already ("You do not own that name").
      // Pass it through rather than replacing a specific message with a vague one.
      return { title: env.error || "Something went wrong" };
  }
}

/** `in 3 days` / `in 2 hours` / `in 5 minutes` / `now`. */
export function formatRetryAt(ms: number, now: number = Date.now()): string {
  const delta = ms - now;
  if (!Number.isFinite(delta) || delta <= 0) return "now";
  const minutes = Math.round(delta / MS_PER_MINUTE);
  // Rounded value picks the unit, so 59.9 minutes reads "in 1 hour" rather
  // than "in 60 minutes".
  if (minutes < 60) return phrase(Math.max(1, minutes), "minute");
  const hours = Math.round(delta / MS_PER_HOUR);
  if (hours < 24) return phrase(hours, "hour");
  return phrase(Math.round(delta / MS_PER_DAY), "day");
}

function phrase(n: number, unit: string): string {
  return `in ${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** The detail sentence with the wait folded in, or undefined when there is none. */
export function subEnsErrorDetail(
  d: SubEnsErrorDescription,
  now: number = Date.now(),
): string | undefined {
  if (d.retryAt === undefined) return d.detail;
  const when = `Try again ${formatRetryAt(d.retryAt, now)}.`;
  return d.detail ? `${d.detail} ${when}` : when;
}

/**
 * Describe a caught value. `ApiError.body` is deliberately open (its fields are
 * route-specific), so the narrowing lives here — a caller in a `catch` block
 * gets a description without an unchecked cast.
 */
export function subEnsErrorFrom(err: unknown, fallback: string): SubEnsErrorDescription {
  const body: Readonly<Record<string, unknown>> = err instanceof ApiError ? err.body : {};
  const data = body.data;
  const windowResetsAt = (data as { windowResetsAt?: unknown } | null | undefined)?.windowResetsAt;
  const next = body.nextChangeAllowedAt;
  return describeSubEnsError({
    error:
      (typeof body.error === "string" && body.error) ||
      (err instanceof Error ? err.message : "") ||
      fallback,
    ...(typeof body.status === "number" ? { status: body.status } : {}),
    ...(typeof windowResetsAt === "number" ? { data: { windowResetsAt } } : {}),
    ...(typeof next === "number" ? { nextChangeAllowedAt: next } : {}),
    ...(typeof body.label === "string" ? { label: body.label } : {}),
  });
}
