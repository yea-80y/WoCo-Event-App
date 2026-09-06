/**
 * Every sub-ENS refusal, as the user sees it (#484).
 *
 * The properties worth pinning: each server code maps to a sentence rather than
 * to itself; the two retry timestamps arrive in DIFFERENT units and both come
 * out as epoch milliseconds; and an unrecognised code passes the server's own
 * prose through instead of replacing it with something vaguer.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeSubEnsError,
  formatRetryAt,
  subEnsErrorDetail,
  subEnsErrorFrom,
} from "../src/lib/sub-ens/errors.js";
import { ApiError } from "../src/lib/api/errors.js";

const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);

test("the mint cap reports the wait, converting the contract's SECONDS to ms", () => {
  // WoCoRegistrar reverts with a block timestamp: unix seconds.
  const windowResetsAt = Math.floor(NOW / 1000) + 3600;
  const d = describeSubEnsError({ error: "mint_rate_cap", data: { windowResetsAt } });
  assert.equal(d.title, "You've registered as many names as you can for now.");
  assert.equal(d.detail, "You can register another one after the wait ends.");
  assert.equal(d.retryAt, windowResetsAt * 1000);
  // The conversion is the whole point: unconverted, the retry lands in 1970.
  assert.ok(d.retryAt! > NOW, "retryAt must be in the future, not a raw seconds value");
  assert.equal(formatRetryAt(d.retryAt!, NOW), "in 1 hour");
});

test("a mint cap with no window still describes itself, without a retry time", () => {
  const d = describeSubEnsError({ error: "mint_rate_cap" });
  assert.equal(d.retryAt, undefined);
  assert.match(d.title, /as many names as you can/);
});

test("the rename cooldown passes its epoch MS through unscaled", () => {
  const nextChangeAllowedAt = NOW + 3 * 86_400_000;
  const d = describeSubEnsError({ error: "name_change_cooldown", nextChangeAllowedAt });
  assert.equal(d.title, "Your profile name was changed recently.");
  assert.equal(d.detail, "You can change it again once the cooldown ends.");
  assert.equal(d.retryAt, nextChangeAllowedAt);
  assert.equal(formatRetryAt(d.retryAt!, NOW), "in 3 days");
});

test("a null nextChangeAllowedAt yields no retry time", () => {
  const d = describeSubEnsError({ error: "name_change_cooldown", nextChangeAllowedAt: null });
  assert.equal(d.retryAt, undefined);
  assert.equal(subEnsErrorDetail(d, NOW), "You can change it again once the cooldown ends.");
});

test("the profile name is refused as a site or event address, in words", () => {
  const d = describeSubEnsError({ error: "profile_name" });
  assert.equal(d.title, "That's your profile name.");
  assert.equal(d.detail, "It can't be used as a site or event address — pick a different name.");
  assert.equal(d.retryAt, undefined);
});

test("rate_limited, release_in_flight and expiration_out_of_range each say what to do", () => {
  assert.deepEqual(describeSubEnsError({ error: "rate_limited" }), {
    title: "Too many requests right now.",
    detail: "Wait a few minutes and try again.",
  });
  assert.deepEqual(describeSubEnsError({ error: "release_in_flight" }), {
    title: "That name is already being released.",
    detail: "Give it a minute, then refresh.",
  });
  assert.deepEqual(describeSubEnsError({ error: "expiration_out_of_range" }), {
    title: "That signature expired before it reached us.",
    detail: "Try again.",
  });
});

test("not_owner explains the loss; the two unverified spellings both mean 'we could not check'", () => {
  const lost = describeSubEnsError({ error: "not_owner" });
  assert.equal(lost.title, "You don't own that name any more.");
  // The deploy response says "unverified"; refuseUnlessOwner says
  // "ownership_unverified". Neither is evidence the name is gone.
  const a = describeSubEnsError({ error: "unverified" });
  const b = describeSubEnsError({ error: "ownership_unverified" });
  assert.deepEqual(a, b);
  assert.equal(a.title, "Couldn't confirm your name on-chain right now.");
  assert.match(a.detail!, /Nothing was changed/);
  assert.notEqual(a.title, lost.title, "an unanswered read must not read as dispossession");
});

test("ticket_required is left to the gate flow — a title, nothing else", () => {
  const d = describeSubEnsError({ error: "ticket_required" });
  assert.equal(d.title, "Link a ticket to unlock your account first");
  assert.equal(d.detail, undefined);
});

test("an unrecognised code falls through to the server's own sentence", () => {
  assert.equal(
    describeSubEnsError({ error: "You do not own that name" }).title,
    "You do not own that name",
  );
  assert.equal(describeSubEnsError({}).title, "Something went wrong");
  assert.equal(describeSubEnsError({ error: "" }).title, "Something went wrong");
});

test("formatRetryAt reads as a wait, and a past time reads as now", () => {
  assert.equal(formatRetryAt(NOW + 3 * 86_400_000, NOW), "in 3 days");
  assert.equal(formatRetryAt(NOW + 86_400_000, NOW), "in 1 day");
  assert.equal(formatRetryAt(NOW + 2 * 3_600_000, NOW), "in 2 hours");
  assert.equal(formatRetryAt(NOW + 5 * 60_000, NOW), "in 5 minutes");
  assert.equal(formatRetryAt(NOW + 60_000, NOW), "in 1 minute");
  // Sub-minute is still a wait, never "in 0 minutes".
  assert.equal(formatRetryAt(NOW + 900, NOW), "in 1 minute");
  // A cooldown that has already elapsed must not read as a future wait.
  assert.equal(formatRetryAt(NOW - 1, NOW), "now");
  assert.equal(formatRetryAt(NOW - 5 * 86_400_000, NOW), "now");
  assert.equal(formatRetryAt(NOW, NOW), "now");
  // The rounded value picks the unit, so no "in 60 minutes" / "in 24 hours".
  assert.equal(formatRetryAt(NOW + 3_599_999, NOW), "in 1 hour");
  assert.equal(formatRetryAt(NOW + 86_399_000, NOW), "in 1 day");
});

test("subEnsErrorDetail folds the wait into the sentence the user reads", () => {
  const d = describeSubEnsError({
    error: "name_change_cooldown",
    nextChangeAllowedAt: NOW + 2 * 86_400_000,
  });
  assert.equal(
    subEnsErrorDetail(d, NOW),
    "You can change it again once the cooldown ends. Try again in 2 days.",
  );
  assert.equal(subEnsErrorDetail({ title: "x" }, NOW), undefined);
  assert.equal(subEnsErrorDetail({ title: "x", retryAt: NOW + 60_000 }, NOW), "Try again in 1 minute.");
});

test("a thrown ApiError keeps the envelope, so the catch block can still describe it", () => {
  // This is the regression: `throw new Error(resp.error)` dropped
  // nextChangeAllowedAt, leaving "name_change_cooldown" as the only thing to show.
  const nextChangeAllowedAt = NOW + 30 * 86_400_000;
  const err = new ApiError("name_change_cooldown", {
    ok: false,
    error: "name_change_cooldown",
    status: 409,
    nextChangeAllowedAt,
    label: "nabil",
  });
  assert.equal(err.message, "name_change_cooldown", "message stays raw — isTicketRequired matches on it");
  assert.equal(err.status, 409);
  assert.equal(err.code, "name_change_cooldown");
  assert.equal(err.body.nextChangeAllowedAt, nextChangeAllowedAt);

  const d = subEnsErrorFrom(err, "fallback");
  assert.equal(d.title, "Your profile name was changed recently.");
  assert.equal(d.retryAt, nextChangeAllowedAt);
});

test("a plain Error and a mint-cap ApiError both survive the narrowing", () => {
  assert.equal(subEnsErrorFrom(new Error("profile_name"), "fallback").title, "That's your profile name.");
  assert.equal(subEnsErrorFrom({}, "fallback").title, "fallback");
  const windowResetsAt = Math.floor(NOW / 1000) + 120;
  const capped = new ApiError("mint_rate_cap", {
    ok: false,
    error: "mint_rate_cap",
    status: 429,
    data: { windowResetsAt },
  });
  assert.equal(subEnsErrorFrom(capped, "fallback").retryAt, windowResetsAt * 1000);
});
