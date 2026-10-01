/**
 * The one thing an organiser should do next, for the card at the top of the
 * dashboard. Setup runs in order — verify with Stripe, claim a name, bring an
 * attendee list across (or skip), put the first event on sale — and once it is
 * done the card only appears when something needs them.
 *
 * Pure, so the suite can pin the rules that make it trustworthy:
 *   - A step counts as done only on an answer that says so. Every input is a
 *     read: still loading, could not answer, or answered.
 *   - The walk never skips past a check that has not answered. Loading means
 *     wait (the card shows nothing rather than a step that may be wrong), and
 *     a failed read means say so, never "done" and never "not done": either
 *     would be a claim the dashboard cannot back.
 *   - Stripe is "all good" only on a LIVE answer from Stripe. The status route
 *     falls back to the stored flag when Stripe is unreachable and then omits
 *     `requirements`; that fallback is a cached claim, so it reads as
 *     "couldn't check", not as verified.
 */

export type Read<T> =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "known"; value: T };

export const LOADING = { status: "loading" } as const;
export const UNAVAILABLE = { status: "unavailable" } as const;
export const known = <T>(value: T): Read<T> => ({ status: "known", value });

/** What the dashboard needs from GET /api/stripe/account-status. */
export interface StripeFacts {
  connected: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  currentlyDue: number;
  pendingVerification: number;
  disabledReason: string | null;
}

/** Minimal shape of the status response this module reads. */
export interface StripeStatusLike {
  ok: boolean;
  connected?: boolean;
  chargesEnabled?: boolean;
  payoutsEnabled?: boolean;
  requirements?: {
    currentlyDue: string[];
    pendingVerification: string[];
    disabledReason: string | null;
  };
}

/**
 * A status response as a read. Not connected is an answer (nothing to check);
 * connected without `requirements` is the server's cached fallback, so it is
 * not one.
 */
export function stripeRead(s: StripeStatusLike | null): Read<StripeFacts> {
  if (!s || !s.ok) return UNAVAILABLE;
  if (s.connected === false) {
    return known({
      connected: false, chargesEnabled: false, payoutsEnabled: false,
      currentlyDue: 0, pendingVerification: 0, disabledReason: null,
    });
  }
  if (!s.requirements || s.chargesEnabled === undefined || s.payoutsEnabled === undefined) {
    return UNAVAILABLE;
  }
  return known({
    connected: true,
    chargesEnabled: s.chargesEnabled,
    payoutsEnabled: s.payoutsEnabled,
    currentlyDue: s.requirements.currentlyDue.length,
    pendingVerification: s.requirements.pendingVerification.length,
    disabledReason: s.requirements.disabledReason,
  });
}

export type StripeState = "good" | "start" | "review" | "more";

/** Stripe reasons that mean "we are checking", where waiting is the only move. */
const REVIEW_REASONS = new Set(["requirements.pending_verification", "under_review"]);

/**
 * - good: can take card payments, can be paid out, nothing outstanding.
 * - start: not connected, or onboarding never got as far as enabling anything.
 * - more: was enabled, and Stripe now wants something (or has disabled it for
 *   a reason waiting will not fix).
 * - review: everything asked for is in and Stripe is checking it.
 */
export function stripeState(f: StripeFacts): StripeState {
  if (!f.connected) return "start";
  const due = f.currentlyDue > 0;
  const blocked = f.disabledReason !== null;
  if (f.chargesEnabled && f.payoutsEnabled && !due && !blocked) return "good";
  if (due) return f.chargesEnabled || f.payoutsEnabled ? "more" : "start";
  if (blocked && !REVIEW_REASONS.has(f.disabledReason!)) return "more";
  return "review";
}

export interface TodayEvent {
  eventId: string;
  title: string;
  startDate: string;
}

export interface NextStepInputs {
  stripe: Read<StripeFacts>;
  /** A profile name is held: from the owned-names read. */
  hasProfileName: Read<boolean>;
  /** The server's name-unlock answer (ticket, Stripe or a confirmed invite). */
  nameUnlocked: Read<boolean>;
  /** Events this organiser has published (any date). */
  eventCount: Read<number>;
  /** Attendee list size: asked only while the import step is undecided. */
  audienceCount: Read<number>;
  /** Device-local: the importer finished here, or the organiser chose Skip. */
  importSettledOnDevice: boolean;
  /** The soonest of their events starting today and not yet over, if any. */
  today: TodayEvent | null;
}

export type CheckName = "stripe" | "name" | "audience" | "events";

export type NextStep =
  /** A check this step depends on has not answered: show nothing yet. */
  | { kind: "wait" }
  | { kind: "unavailable"; check: CheckName }
  | { kind: "stripe-start" }
  | { kind: "stripe-review" }
  | { kind: "stripe-more" }
  | { kind: "name" }
  | { kind: "import" }
  | { kind: "first-event" }
  | { kind: "doors"; event: TodayEvent }
  | { kind: "none" };

/** The setup steps in order, for the "2 of 4" on the card. */
export const SETUP_STEPS = ["stripe", "name", "import", "first-event"] as const;

export function nextStep(i: NextStepInputs): NextStep {
  // 1. Stripe. First at every stage: "Stripe wants more" outranks everything.
  if (i.stripe.status === "loading") return { kind: "wait" };
  if (i.stripe.status === "unavailable") return { kind: "unavailable", check: "stripe" };
  const stripe = stripeState(i.stripe.value);
  if (stripe === "start") return { kind: "stripe-start" };
  if (stripe === "review") return { kind: "stripe-review" };
  if (stripe === "more") return { kind: "stripe-more" };

  // 2. Name. A held profile name settles it; otherwise the unlock must say yes.
  //    Stripe is verified by now, so a "locked" answer is out of step with
  //    Stripe (the stored flag lagging the live one) and is shown as a check
  //    to retry, never as a step the server would refuse.
  if (i.hasProfileName.status === "loading") return { kind: "wait" };
  if (i.hasProfileName.status === "unavailable") return { kind: "unavailable", check: "name" };
  if (!i.hasProfileName.value) {
    if (i.nameUnlocked.status === "loading") return { kind: "wait" };
    if (i.nameUnlocked.status === "unavailable" || !i.nameUnlocked.value) {
      return { kind: "unavailable", check: "name" };
    }
    return { kind: "name" };
  }

  // 3 + 4 belong to setup, which ends with the first event.
  if (i.eventCount.status === "loading") return { kind: "wait" };
  if (i.eventCount.status === "unavailable") return { kind: "unavailable", check: "events" };
  if (i.eventCount.value === 0) {
    if (!i.importSettledOnDevice) {
      if (i.audienceCount.status === "loading") return { kind: "wait" };
      if (i.audienceCount.status === "unavailable") return { kind: "unavailable", check: "audience" };
      if (i.audienceCount.value === 0) return { kind: "import" };
    }
    return { kind: "first-event" };
  }

  // Set up. Only what needs them now.
  if (i.today) return { kind: "doors", event: i.today };
  return { kind: "none" };
}

/** Which reads the walk can use, so the dashboard only fetches what it needs. */
export function needsAudienceRead(i: Pick<NextStepInputs, "importSettledOnDevice" | "eventCount">): boolean {
  return !i.importSettledOnDevice && i.eventCount.status === "known" && i.eventCount.value === 0;
}

/** The soonest event starting on the local calendar day of `now` and not yet over. */
export function todayEvent<T extends { eventId: string; title: string; startDate: string; endDate?: string }>(
  events: readonly T[],
  now: number,
): TodayEvent | null {
  const day = new Date(now).toDateString();
  const todays = events
    .filter((e) => {
      const start = new Date(e.startDate);
      if (isNaN(start.getTime()) || start.toDateString() !== day) return false;
      const end = new Date(e.endDate && e.endDate.length > 0 ? e.endDate : e.startDate).getTime();
      // An event with no end time stays "today" until the day is out.
      return e.endDate ? end >= now : true;
    })
    .sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());
  const e = todays[0];
  return e ? { eventId: e.eventId, title: e.title, startDate: e.startDate } : null;
}
