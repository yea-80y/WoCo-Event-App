/**
 * Chasing organisers for outstanding Stripe requirements.
 *
 * Two failure modes matter and they pull in opposite directions. Emailing on
 * every `account.updated` trains organisers to ignore the one that matters;
 * emailing too little leaves money held with nobody told. The cases below pin
 * the line between them, plus the liveness record that makes a long-stuck
 * account visible instead of merely emailed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideRequirementNudge,
  NUDGE_COOLDOWN_MS,
  type NudgeAccount,
  type NudgeState,
} from "../src/lib/stripe/requirement-nudge.js";
import { describeRequirements, buildRequirementNudge } from "../src/lib/email/requirement-nudge.js";

const NOW = new Date("2026-08-01T12:00:00.000Z");

function account(over: Partial<NudgeAccount> = {}): NudgeAccount {
  return {
    id: "acct_test",
    email: "organiser@example.com",
    details_submitted: true,
    requirements: { currently_due: ["external_account"], past_due: [], disabled_reason: null },
    ...over,
  } as NudgeAccount;
}

// ---------------------------------------------------------------------------
// When to send
// ---------------------------------------------------------------------------

test("a newly outstanding requirement is emailed once", () => {
  const d = decideRequirementNudge(account(), undefined, NOW);
  assert.equal(d.send, true);
  assert.equal(d.reason, "new-requirements");
  assert.equal(d.nextState?.firstDueAt, NOW.toISOString());
});

test("the same requirement does not email again inside the cooldown", () => {
  const previous = decideRequirementNudge(account(), undefined, NOW).nextState!;
  const soon = new Date(NOW.getTime() + 60 * 60 * 1000);

  const d = decideRequirementNudge(account(), previous, soon);
  assert.equal(d.send, false);
  assert.equal(d.reason, "recently-notified");
});

test("an unresolved requirement is chased again after the cooldown", () => {
  const previous = decideRequirementNudge(account(), undefined, NOW).nextState!;
  const later = new Date(NOW.getTime() + NUDGE_COOLDOWN_MS + 1000);

  const d = decideRequirementNudge(account(), previous, later);
  assert.equal(d.send, true);
  assert.equal(d.reason, "cooldown-elapsed");
});

test("a changed requirement set emails immediately, cooldown or not", () => {
  // Stripe asking for something NEW is new information, and sitting on it for
  // three days is how a payout silently misses an event.
  const previous = decideRequirementNudge(account(), undefined, NOW).nextState!;
  const soon = new Date(NOW.getTime() + 60 * 1000);
  const changed = account({
    requirements: { currently_due: ["company.tax_id"], past_due: [], disabled_reason: null },
  } as Partial<NudgeAccount>);

  const d = decideRequirementNudge(changed, previous, soon);
  assert.equal(d.send, true);
  assert.equal(d.reason, "changed-requirements");
});

test("an organiser still onboarding is never chased", () => {
  // A half-finished signup has a screen full of requirements by design.
  const d = decideRequirementNudge(
    account({ details_submitted: false } as Partial<NudgeAccount>),
    undefined,
    NOW,
  );
  assert.equal(d.send, false);
  assert.equal(d.reason, "still-onboarding");
  assert.equal(d.nextState, null);
});

test("nothing outstanding clears the record", () => {
  const previous: NudgeState = {
    signature: "old",
    firstDueAt: "2026-07-01T00:00:00.000Z",
    lastNotifiedAt: "2026-07-01T00:00:00.000Z",
  };
  const clean = account({
    requirements: { currently_due: [], past_due: [], disabled_reason: null },
  } as Partial<NudgeAccount>);

  const d = decideRequirementNudge(clean, previous, NOW);
  assert.equal(d.send, false);
  assert.equal(d.reason, "nothing-due");
  // Clearing is what "resolved" means — and it lets a future requirement read
  // as new rather than as a continuation of one already fixed.
  assert.equal(d.nextState, null);
});

test("a disabled account is chased even with an empty requirement list", () => {
  const disabled = account({
    requirements: { currently_due: [], past_due: [], disabled_reason: "requirements.past_due" },
  } as Partial<NudgeAccount>);

  const d = decideRequirementNudge(disabled, undefined, NOW);
  assert.equal(d.send, true);
  assert.equal(d.disabledReason, "requirements.past_due");
});

test("past_due requirements count, and are merged without duplicates", () => {
  const both = account({
    requirements: {
      currently_due: ["external_account", "company.tax_id"],
      past_due: ["external_account"],
      disabled_reason: null,
    },
  } as Partial<NudgeAccount>);

  const d = decideRequirementNudge(both, undefined, NOW);
  assert.deepEqual(d.due, ["company.tax_id", "external_account"]);
});

test("requirement order from Stripe does not fake a change", () => {
  // Stripe does not promise a stable order; sorting is what stops a reordered
  // but identical list from emailing every organiser again.
  const a = decideRequirementNudge(
    account({
      requirements: { currently_due: ["a", "b"], past_due: [], disabled_reason: null },
    } as Partial<NudgeAccount>),
    undefined,
    NOW,
  );
  const b = decideRequirementNudge(
    account({
      requirements: { currently_due: ["b", "a"], past_due: [], disabled_reason: null },
    } as Partial<NudgeAccount>),
    a.nextState!,
    new Date(NOW.getTime() + 60 * 1000),
  );

  assert.equal(b.send, false, "a reordered identical list is not a change");
});

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------

test("the liveness clock survives a change of requirement", () => {
  // The organiser has been blocked continuously. Resetting firstDueAt on every
  // new requirement would hide precisely the accounts stuck the longest.
  const first = decideRequirementNudge(account(), undefined, NOW).nextState!;
  const later = new Date(NOW.getTime() + 10 * 24 * 60 * 60 * 1000);
  const changed = account({
    requirements: { currently_due: ["company.tax_id"], past_due: [], disabled_reason: null },
  } as Partial<NudgeAccount>);

  const d = decideRequirementNudge(changed, first, later);
  assert.equal(d.nextState?.firstDueAt, NOW.toISOString());
});

test("an organiser with no email is still recorded as blocked", () => {
  // Unreachable AND blocked is the worst case; it must not vanish just because
  // no email could be sent.
  const d = decideRequirementNudge(
    account({ email: null } as Partial<NudgeAccount>),
    undefined,
    NOW,
  );
  assert.equal(d.send, false);
  assert.equal(d.reason, "no-email");
  assert.equal(d.nextState?.firstDueAt, NOW.toISOString());
});

test("a corrupt lastNotifiedAt does not suppress the chase forever", () => {
  // Fail toward telling the organiser. A silently un-nudgeable account is a
  // worse outcome than one extra email.
  const corrupt: NudgeState = {
    signature: JSON.stringify([["external_account"], null]),
    firstDueAt: NOW.toISOString(),
    lastNotifiedAt: "not-a-date",
  };
  const d = decideRequirementNudge(account(), corrupt, NOW);
  assert.equal(d.send, true);
});

// ---------------------------------------------------------------------------
// The email
// ---------------------------------------------------------------------------

test("machine requirement names are translated, and unknown ones are dropped", () => {
  const described = describeRequirements(["external_account", "some.future.stripe_key"]);
  assert.deepEqual(described, ["your bank account details"]);
});

test("requirements that mean one thing to a person are not repeated", () => {
  // dob.day/month/year are three keys and one question.
  const described = describeRequirements([
    "representative.dob.day",
    "representative.dob.month",
    "representative.dob.year",
  ]);
  assert.deepEqual(described, ["your date of birth"]);
});

test("a disabled account says payouts are on hold, not that they might be", () => {
  const held = buildRequirementNudge({
    to: "o@example.com",
    due: ["external_account"],
    disabledReason: "requirements.past_due",
    payoutsUrl: "https://woco.eth.limo/#/creator/payouts",
  });
  assert.match(held.subject, /on hold/);
  assert.match(held.text, /paused payouts/);

  const notYet = buildRequirementNudge({
    to: "o@example.com",
    due: ["external_account"],
    disabledReason: null,
    payoutsUrl: "https://woco.eth.limo/#/creator/payouts",
  });
  assert.doesNotMatch(notYet.subject, /on hold/);
});

test("the email always carries a link and never raw requirement keys", () => {
  const url = "https://woco.eth.limo/#/creator/payouts";
  const built = buildRequirementNudge({
    to: "o@example.com",
    due: ["some.future.stripe_key"],
    disabledReason: null,
    payoutsUrl: url,
  });

  assert.ok(built.html.includes(url), "html must link to payouts");
  assert.ok(built.text.includes(url), "text must link to payouts");
  assert.doesNotMatch(built.html, /some\.future\.stripe_key/);
  assert.doesNotMatch(built.text, /some\.future\.stripe_key/);
});

test("the payouts URL is escaped into the html", () => {
  const built = buildRequirementNudge({
    to: "o@example.com",
    due: [],
    disabledReason: "requirements.past_due",
    payoutsUrl: 'https://evil.test/"><script>alert(1)</script>',
  });
  assert.doesNotMatch(built.html, /<script>/);
});
