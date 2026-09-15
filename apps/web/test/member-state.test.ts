/**
 * Home's decisions: the name block, the invite line (an unanswered read must
 * never read as "no invites"), and which unlock turns the Studio link on.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Hex0x } from "@woco/shared";
import { inviteStatusText, nameStateFrom, organisesFromUnlock } from "../src/lib/attendee/home/member-state.js";

const A = "0xabcdef1111111111111111111111111111111111" as Hex0x;

test("a claimed profile name wins over any unlock status", () => {
  assert.equal(nameStateFrom("nabil", { gated: false }), "claimed");
  assert.equal(nameStateFrom("nabil", null), "claimed");
});

test("with no name, the unlock status decides", () => {
  assert.equal(nameStateFrom(null, { gated: true }), "unlocked");
  assert.equal(nameStateFrom(null, { gated: false }), "locked");
});

test("no status yet says nothing rather than guessing locked", () => {
  assert.equal(nameStateFrom(null, null), "unknown");
});

test("an unanswered invite read says so and never reads as none", () => {
  const text = inviteStatusText({ status: "unavailable" });
  assert.equal(text, "Couldn't check your invites right now.");
});

test("no index and an empty index both read as no invites yet", () => {
  assert.match(inviteStatusText({ status: "absent" }) ?? "", /^No verified invites yet/);
  assert.match(inviteStatusText({ status: "found", referees: [] }) ?? "", /^No verified invites yet/);
});

test("one invite is singular and more are plural", () => {
  assert.equal(inviteStatusText({ status: "found", referees: [A] }), "1 verified invite.");
  assert.equal(inviteStatusText({ status: "found", referees: [A, A, A] }), "3 verified invites.");
});

test("nothing to say before the read has answered", () => {
  assert.equal(inviteStatusText(null), null);
});

test("only an organiser unlock turns the Studio link on", () => {
  assert.equal(organisesFromUnlock("organiser"), true);
  assert.equal(organisesFromUnlock("ticket"), false);
  assert.equal(organisesFromUnlock("disabled"), false);
  assert.equal(organisesFromUnlock(undefined), false);
});
