/**
 * What a lap count is allowed to say, given what the counter actually returned.
 *
 * PURE AND DOM-FREE ON PURPOSE. Every honesty rule this rail has lives in this
 * file rather than in the element that paints it, so the rules can be tested in
 * Node and so a later surface (a third size, a different host) cannot quietly
 * acquire its own dialect of them. `test/count-display.test.ts` is the ratchet.
 *
 * The rules, and why each one exists:
 *
 * 1. NOTHING BEFORE THE FIRST SUCCESSFUL READ. A count of zero is a real
 *    answer; a dead API is not. Painting `0 laps` while we have never heard
 *    from the counter would be a false claim in the same family as inflating
 *    one, and on a stream it is the more likely direction to get wrong, because
 *    zero is also the honest answer today.
 * 2. `unreadable > 0` MAKES THE FIGURE A FLOOR. Some logbooks could not be read
 *    this pass, so the total is at least this and possibly more. It is rendered
 *    with a trailing plus — the "500+" idiom, which a general audience reads as
 *    "at least" without a footnote there is no room for. Presenting a floor as
 *    a total is the exact failure `/api/social/manifest` warns about.
 * 3. THE COUNT IS COMMUNITY-SCOPED. `count` sums every rider who has published
 *    for this subject, so the moment a second rider appears the number stops
 *    meaning one person's laps while looking identical. The rider count is
 *    therefore surfaced as soon as it exceeds one, which makes the scope
 *    self-labelling instead of silently shifting under a challenge kicker.
 * 4. A STALE NUMBER IS HONEST ONLY WHILE IT IS MARKED. A number vanishing
 *    mid-broadcast is worse than a slightly old one, so failures keep the last
 *    figure on screen — but they mark it, and the mark is driven by consecutive
 *    failed polls, never by the response's own `ageMs`. `ageMs` is bounded at
 *    the cache TTL by construction: it reports the design's freshness contract,
 *    not a fault, and wiring it to an alarm would cry wolf every cache cycle.
 * 5. EQUIVOCATIONS GET NO TREATMENT HERE. A holder publishing two conflicting
 *    heads is resolved deterministically by the tally (lower digest wins), so
 *    both heads were read and one was chosen. That is an integrity signal about
 *    one participant, not incompleteness in the count — unlike `unreadable`, it
 *    makes the figure neither a floor nor a guess. Surfacing it as a caveat on
 *    the number would imply a doubt the arithmetic does not have.
 *
 * Vocabulary is load-bearing and is checked by the tests: a repeat ride is a
 * LAP, never a "credit" (a credit is a coaster ridden once, ever); a rider's
 * feed is their LOGBOOK. No crypto words reach a fan.
 */

/** The `data` block of a successful `GET /api/social/count`. */
export interface CountData {
  count: number;
  participants: number;
  contributors: number;
  unreadable: number;
}

/**
 * Everything the counter has told us so far. `figure` is deliberately absent
 * until a read succeeds rather than defaulted to zero — see rule 1.
 */
export type CountState =
  | { kind: "pending" }
  | { kind: "known"; data: CountData; consecutiveFailures: number };

/**
 * The verbatim line, matching the counter page (`VerifyApp.svelte`) exactly.
 * Not a template and not paraphrasable: the overlay, the widget and the counter
 * page are one artifact at three sizes, and a second surface inventing its own
 * wording is how that stops being true.
 *
 * "THE RIDER IT BELONGS TO", never "the rider who rode it". The second phrasing
 * asserts that somebody rode, which is precisely what this rail must never
 * claim — a tier-1 statement is self-signed and nobody vouches for the ride.
 * The signature establishes whose logbook the entry is in, not that the lap
 * happened. An earlier draft of this file carried the "who rode it" wording;
 * the test below is what stops it coming back.
 */
export const SIGNED_LINE =
  "Every lap here is signed by the rider it belongs to. Nothing is taken on our word.";

/** Shown instead of {@link SIGNED_LINE} when there is nothing to have signed. */
export const NO_LAPS_LINE = "No laps logged yet.";

/** Why the figure carries a plus. Only rendered where there is room for it. */
export const FLOOR_NOTE = "Some logbooks couldn't be read this update.";

/** Consecutive failed polls before the figure on screen is marked as not current. */
export const STALE_AFTER_FAILURES = 2;

/**
 * The rest of the fan-facing copy. It lives here rather than inline in the
 * element for one reason: the vocabulary ratchet in the tests can only scan
 * what this module exports, and copy the ratchet cannot see is copy that can
 * drift back into the words this rail has agreed not to use.
 */
export const COPY = {
  /** Card only. The overlay renders nothing at all in this state. */
  waiting: "Waiting for the counter…",
  /** Overlay badge — room for two words and no more. */
  staleShort: "not updating",
  /** Card badge, where there is room to say what is actually on screen. */
  staleLong: "Not updating — showing the last count we read.",
  /** The counter page's own phrase, reused rather than invented, so the two
   *  surfaces do not name the same evidence differently. */
  seeWorking: "See the working →",
  /** Deliberately "counted", not "verified": this surface serves the figure. */
  mark: "Counted by WoCo",
} as const;

export interface Display {
  /** "109", or "109+" when the figure is a floor. Null until a read succeeds. */
  figure: string | null;
  /** "laps" or "lap", agreeing with `figure`. */
  unit: string;
  /** "3 riders" once more than one rider has contributed, else null. */
  riders: string | null;
  /** True when `figure` is a floor rather than a total. */
  isFloor: boolean;
  /** True when the figure on screen is not current and must be marked as such. */
  notUpdating: boolean;
  /** The supporting line, for surfaces that have room for one. */
  line: string;
}

/**
 * Reject a payload rather than render it. A malformed or hostile response would
 * otherwise reach a broadcast as `NaN laps` or as a number no arithmetic
 * produced, and on this rail a wrong figure is worse than no figure. Anything
 * that is not a whole, non-negative, finite count fails the whole read, which
 * the caller then treats as a failed poll — so the last honest number stays up.
 */
export function parseCountData(value: unknown): CountData | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const whole = (x: unknown): x is number =>
    typeof x === "number" && Number.isInteger(x) && x >= 0 && Number.isFinite(x);
  if (!whole(v.count) || !whole(v.participants) || !whole(v.contributors) || !whole(v.unreadable)) {
    return null;
  }
  return {
    count: v.count,
    participants: v.participants,
    contributors: v.contributors,
    unreadable: v.unreadable,
  };
}

/** The single place a `CountState` becomes words. */
export function describe(state: CountState): Display {
  if (state.kind === "pending") {
    return {
      figure: null,
      unit: "laps",
      riders: null,
      isFloor: false,
      notUpdating: false,
      line: "",
    };
  }

  const { count, contributors, unreadable } = state.data;
  const isFloor = unreadable > 0;

  return {
    figure: `${count}${isFloor ? "+" : ""}`,
    // Agrees with the figure, not the floor: "1+ laps" is right, because a
    // floor of one is a statement about several possible totals, none of which
    // is necessarily one.
    unit: count === 1 && !isFloor ? "lap" : "laps",
    riders: contributors > 1 ? `${contributors} riders` : null,
    isFloor,
    notUpdating: state.consecutiveFailures >= STALE_AFTER_FAILURES,
    // Gated on the COUNT, not on whether anyone has published: a rider whose
    // logbook is readable and totals zero still means "no laps logged yet", and
    // the signed-by line over an empty set reads as boilerplate.
    //
    // But a zero that is ALSO a floor states nothing: the laps may be sitting in
    // the logbooks that could not be read this pass, so "no laps logged yet"
    // would assert an absence the read did not establish. There the floor note
    // is the whole honest answer and the line stays empty rather than guessing
    // in either direction.
    line: count === 0 ? (isFloor ? "" : NO_LAPS_LINE) : SIGNED_LINE,
  };
}
