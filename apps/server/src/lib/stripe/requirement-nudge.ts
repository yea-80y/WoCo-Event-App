/**
 * Chasing an organiser for what Stripe still needs.
 *
 * Under Managed Risk, Stripe collects requirements directly and can raise new
 * ones long after onboarding — a document expires, a threshold is crossed, an
 * owner changes. When that happens the organiser's payouts stop, and the only
 * signal is inside a Stripe UI they have no reason to open. Nobody notices
 * until an event ends and the money does not arrive.
 *
 * So the webhook chases them. Two things make that safe to automate:
 *
 *  - Deduplication. `account.updated` fires on many unrelated changes; emailing
 *    on each one trains organisers to ignore the one that matters. A nudge goes
 *    out when the outstanding set CHANGES, or when it has gone unresolved for
 *    longer than the cooldown — not on every webhook.
 *  - Liveness. `firstDueAt` is kept for as long as the requirement is
 *    outstanding, so "who has been stuck, and since when" is an answerable
 *    question rather than an inference from mail logs. Clearing the record is
 *    what "resolved" means.
 *
 * The decision is pure and the store is separate, so every branch below is
 * testable without Stripe, a mailbox or a filesystem.
 */

import type Stripe from "stripe";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../marketing/persist.js";

/** Long enough not to nag, short enough that held money is not forgotten. */
export const NUDGE_COOLDOWN_MS = 72 * 60 * 60 * 1000;

export interface NudgeState {
  /** Identifies the outstanding set, so a CHANGE can be told from a repeat. */
  signature: string;
  /** When this account first had something outstanding — the liveness clock. */
  firstDueAt: string;
  /** When we last emailed about it. */
  lastNotifiedAt: string;
}

export type NudgeReason =
  | "new-requirements"
  | "changed-requirements"
  | "cooldown-elapsed"
  | "recently-notified"
  | "still-onboarding"
  | "nothing-due"
  | "no-email";

export interface NudgeDecision {
  send: boolean;
  reason: NudgeReason;
  /** What to persist. `null` clears the record — the account is clean again. */
  nextState: NudgeState | null;
  /** The outstanding requirement keys, for the email body and the log. */
  due: string[];
  /** Set when Stripe has actively disabled something. */
  disabledReason: string | null;
}

/** The slice of a Stripe account this decision reads. */
export type NudgeAccount = Pick<Stripe.Account, "id" | "email" | "details_submitted"> & {
  requirements?: Stripe.Account.Requirements | null;
};

function outstanding(account: NudgeAccount): string[] {
  const r = account.requirements;
  const merged = [...(r?.currently_due ?? []), ...(r?.past_due ?? [])];
  return [...new Set(merged)].sort();
}

export function decideRequirementNudge(
  account: NudgeAccount,
  previous: NudgeState | undefined,
  now: Date,
  cooldownMs: number = NUDGE_COOLDOWN_MS,
): NudgeDecision {
  const due = outstanding(account);
  const disabledReason = account.requirements?.disabled_reason ?? null;
  const iso = now.toISOString();

  // Nothing outstanding: clear the record so the liveness clock resets and a
  // future requirement reads as new rather than as a continuation.
  if (due.length === 0 && !disabledReason) {
    return { send: false, reason: "nothing-due", nextState: null, due, disabledReason };
  }

  // An organiser who has not finished onboarding has a screen full of
  // requirements BY DESIGN. Emailing them mid-signup to say Stripe needs
  // information is noise at best and alarming at worst.
  if (!account.details_submitted) {
    return { send: false, reason: "still-onboarding", nextState: null, due, disabledReason };
  }

  const signature = JSON.stringify([due, disabledReason]);

  // Track it even when we cannot email — the liveness record is the point, and
  // an organiser with no email on file is exactly the one who gets stranded.
  if (!account.email) {
    return {
      send: false,
      reason: "no-email",
      nextState: {
        signature,
        firstDueAt: previous?.firstDueAt ?? iso,
        lastNotifiedAt: previous?.lastNotifiedAt ?? "",
      },
      due,
      disabledReason,
    };
  }

  // firstDueAt deliberately survives a change of signature: the organiser has
  // been blocked continuously, and resetting the clock would hide exactly the
  // long-stuck accounts this exists to surface.
  const firstDueAt = previous?.firstDueAt ?? iso;

  if (!previous) {
    return {
      send: true,
      reason: "new-requirements",
      nextState: { signature, firstDueAt, lastNotifiedAt: iso },
      due,
      disabledReason,
    };
  }

  if (previous.signature !== signature) {
    return {
      send: true,
      reason: "changed-requirements",
      nextState: { signature, firstDueAt, lastNotifiedAt: iso },
      due,
      disabledReason,
    };
  }

  const last = Date.parse(previous.lastNotifiedAt);
  const elapsed = Number.isNaN(last) ? Infinity : now.getTime() - last;
  if (elapsed >= cooldownMs) {
    return {
      send: true,
      reason: "cooldown-elapsed",
      nextState: { signature, firstDueAt, lastNotifiedAt: iso },
      due,
      disabledReason,
    };
  }

  return {
    send: false,
    reason: "recently-notified",
    nextState: { ...previous, signature, firstDueAt },
    due,
    disabledReason,
  };
}

// ---------------------------------------------------------------------------
// Store — same file-backed pattern as stripe-accounts.json
// ---------------------------------------------------------------------------

const DATA_DIR = join(process.cwd(), ".data");
const NUDGE_FILE = join(DATA_DIR, "stripe-requirement-nudges.json");

/** stripeAccountId → NudgeState */
let store: Record<string, NudgeState> = {};
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    store = JSON.parse(readFileSync(NUDGE_FILE, "utf-8"));
    console.log(`[stripe-nudge] Loaded ${Object.keys(store).length} outstanding requirement records`);
  } catch {
    // No file yet — nobody has been chased.
  }
}

function persist(): void {
  // 600: this names organisers who are blocked, alongside Stripe account ids.
  // Losing it degrades to over-emailing, never to a missed requirement.
  writeJsonAtomic(NUDGE_FILE, store, "stripe-nudge", { pretty: true });
}

export function getNudgeState(stripeAccountId: string): NudgeState | undefined {
  ensureLoaded();
  return store[stripeAccountId];
}

export function setNudgeState(stripeAccountId: string, state: NudgeState | null): void {
  ensureLoaded();
  if (state === null) delete store[stripeAccountId];
  else store[stripeAccountId] = state;
  persist();
}

/** Every account with something outstanding, oldest first — the liveness view. */
export function listOutstanding(): Array<{ stripeAccountId: string } & NudgeState> {
  ensureLoaded();
  return Object.entries(store)
    .map(([stripeAccountId, state]) => ({ stripeAccountId, ...state }))
    .sort((a, b) => a.firstDueAt.localeCompare(b.firstDueAt));
}

export function _resetNudgeStoreForTest(): void {
  store = {};
  loaded = true;
}
