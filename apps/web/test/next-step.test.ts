/**
 * The dashboard's next-step card. It is only worth showing if it is right, so
 * these pin the rules that keep it right: a step is done only on an answer
 * that says so, the walk never skips past a check that has not answered, and a
 * check that could not answer is said out loud rather than read as either
 * answer.
 *
 * MUTATION: delete any `return` in nextStep() or stripeState(), or treat the
 * status route's cached fallback as live, and a case below goes red.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nextStep,
  stripeRead,
  stripeState,
  todayEvent,
  needsAudienceRead,
  known,
  LOADING,
  UNAVAILABLE,
  type NextStepInputs,
  type StripeFacts,
} from "../src/lib/creator/home/next-step.js";

const GOOD: StripeFacts = {
  connected: true, chargesEnabled: true, payoutsEnabled: true,
  currentlyDue: 0, pendingVerification: 0, disabledReason: null,
};

/** Fully set up, nothing on today: the card has nothing to say. */
const DONE: NextStepInputs = {
  stripe: known(GOOD),
  hasProfileName: known(true),
  nameUnlocked: known(true),
  eventCount: known(2),
  audienceCount: known(40),
  importSettledOnDevice: false,
  today: null,
};

const kind = (over: Partial<NextStepInputs>) => nextStep({ ...DONE, ...over }).kind;

// ── Stripe: what "all good" means ──────────────────────────────────────────

test("Stripe is all good only with charges, payouts and nothing outstanding", () => {
  assert.equal(stripeState(GOOD), "good");
  assert.equal(stripeState({ ...GOOD, payoutsEnabled: false }), "review");
  assert.equal(stripeState({ ...GOOD, chargesEnabled: false }), "review");
  assert.equal(stripeState({ ...GOOD, currentlyDue: 1 }), "more");
  assert.equal(stripeState({ ...GOOD, disabledReason: "requirements.past_due" }), "more");
});

test("not connected, or nothing enabled with items due, is the start of Stripe", () => {
  assert.equal(stripeState({ ...GOOD, connected: false }), "start");
  assert.equal(
    stripeState({ ...GOOD, chargesEnabled: false, payoutsEnabled: false, currentlyDue: 4 }),
    "start",
  );
});

test("Stripe checking what was sent is a wait, not a to-do", () => {
  const sent = { ...GOOD, chargesEnabled: false, payoutsEnabled: false, pendingVerification: 2 };
  assert.equal(stripeState(sent), "review");
  assert.equal(stripeState({ ...sent, disabledReason: "requirements.pending_verification" }), "review");
  assert.equal(stripeState({ ...sent, disabledReason: "under_review" }), "review");
  assert.equal(stripeState({ ...sent, disabledReason: "rejected.other" }), "more");
});

test("the status route's cached fallback is not a live answer", () => {
  // Stripe unreachable: the server serves the stored flag and no requirements.
  assert.deepEqual(stripeRead({ ok: true, connected: true }), UNAVAILABLE);
  assert.deepEqual(stripeRead({ ok: false }), UNAVAILABLE);
  assert.deepEqual(stripeRead(null), UNAVAILABLE);
  assert.equal(stripeRead({ ok: true, connected: false }).status, "known");
  const live = stripeRead({
    ok: true, connected: true, chargesEnabled: true, payoutsEnabled: true,
    requirements: { currentlyDue: [], pendingVerification: [], disabledReason: null },
  });
  assert.deepEqual(live, known(GOOD));
});

// ── The walk ───────────────────────────────────────────────────────────────

test("setup runs Stripe, then name, then import, then first event", () => {
  const fresh: NextStepInputs = {
    stripe: known({ ...GOOD, connected: false }),
    hasProfileName: known(false),
    nameUnlocked: known(false),
    eventCount: known(0),
    audienceCount: known(0),
    importSettledOnDevice: false,
    today: null,
  };
  assert.equal(nextStep(fresh).kind, "stripe-start");
  const verified = { ...fresh, stripe: known(GOOD), nameUnlocked: known(true) };
  assert.equal(nextStep(verified).kind, "name");
  const named = { ...verified, hasProfileName: known(true) };
  assert.equal(nextStep(named).kind, "import");
  assert.equal(nextStep({ ...named, importSettledOnDevice: true }).kind, "first-event");
  assert.equal(nextStep({ ...named, audienceCount: known(12) }).kind, "first-event");
  assert.equal(nextStep({ ...named, eventCount: known(1) }).kind, "none");
});

test("Stripe asking for more outranks everything, at any stage", () => {
  assert.equal(kind({ stripe: known({ ...GOOD, currentlyDue: 2 }) }), "stripe-more");
  assert.equal(
    kind({ stripe: known({ ...GOOD, currentlyDue: 2 }), today: { eventId: "e", title: "t", startDate: "" } }),
    "stripe-more",
  );
});

test("nothing after Stripe shows while Stripe is checking", () => {
  const review = known({ ...GOOD, payoutsEnabled: false });
  assert.equal(kind({ stripe: review, hasProfileName: known(false) }), "stripe-review");
  assert.equal(kind({ stripe: review, eventCount: known(0) }), "stripe-review");
});

test("a check still loading shows nothing, never the step after it", () => {
  assert.equal(kind({ stripe: LOADING }), "wait");
  assert.equal(kind({ hasProfileName: LOADING }), "wait");
  assert.equal(kind({ hasProfileName: known(false), nameUnlocked: LOADING }), "wait");
  assert.equal(kind({ eventCount: LOADING }), "wait");
  assert.equal(kind({ eventCount: known(0), audienceCount: LOADING }), "wait");
});

test("a check that could not answer is said, and never skipped", () => {
  assert.deepEqual(nextStep({ ...DONE, stripe: UNAVAILABLE }), { kind: "unavailable", check: "stripe" });
  assert.deepEqual(nextStep({ ...DONE, hasProfileName: UNAVAILABLE }), { kind: "unavailable", check: "name" });
  assert.deepEqual(
    nextStep({ ...DONE, hasProfileName: known(false), nameUnlocked: UNAVAILABLE }),
    { kind: "unavailable", check: "name" },
  );
  assert.deepEqual(nextStep({ ...DONE, eventCount: UNAVAILABLE }), { kind: "unavailable", check: "events" });
  assert.deepEqual(
    nextStep({ ...DONE, eventCount: known(0), audienceCount: UNAVAILABLE }),
    { kind: "unavailable", check: "audience" },
  );
});

test("a name unlock out of step with a verified Stripe is a retry, not a step the server refuses", () => {
  assert.deepEqual(
    nextStep({ ...DONE, hasProfileName: known(false), nameUnlocked: known(false) }),
    { kind: "unavailable", check: "name" },
  );
});

test("a held name settles the name step without asking about the unlock", () => {
  assert.equal(kind({ hasProfileName: known(true), nameUnlocked: UNAVAILABLE }), "none");
});

test("the attendee list is only asked about during setup, and not once settled here", () => {
  assert.equal(needsAudienceRead({ importSettledOnDevice: false, eventCount: known(0) }), true);
  assert.equal(needsAudienceRead({ importSettledOnDevice: true, eventCount: known(0) }), false);
  assert.equal(needsAudienceRead({ importSettledOnDevice: false, eventCount: known(3) }), false);
  assert.equal(needsAudienceRead({ importSettledOnDevice: false, eventCount: LOADING }), false);
  // Once events exist the list read is never consulted, whatever it says.
  assert.equal(kind({ audienceCount: UNAVAILABLE }), "none");
});

// ── After setup ────────────────────────────────────────────────────────────

test("an event today brings the doors card; otherwise there is nothing", () => {
  const today = { eventId: "e1", title: "Riverside v Harbour Town", startDate: "2026-10-03T15:00:00" };
  assert.deepEqual(nextStep({ ...DONE, today }), { kind: "doors", event: today });
  assert.equal(nextStep(DONE).kind, "none");
});

test("today means started today on this device's calendar and not yet over", () => {
  const now = new Date("2026-10-03T12:00:00").getTime();
  const ev = (eventId: string, startDate: string, endDate?: string) =>
    ({ eventId, title: eventId, startDate, endDate });
  assert.equal(todayEvent([ev("tomorrow", "2026-10-04T12:00:00")], now), null);
  assert.equal(todayEvent([ev("ended", "2026-10-03T08:00:00", "2026-10-03T10:00:00")], now), null);
  assert.equal(todayEvent([ev("open", "2026-10-03T09:00:00")], now)?.eventId, "open");
  assert.equal(
    todayEvent([ev("late", "2026-10-03T20:00:00"), ev("early", "2026-10-03T15:00:00")], now)?.eventId,
    "early",
  );
});
