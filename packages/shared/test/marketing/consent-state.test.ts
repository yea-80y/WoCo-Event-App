/**
 * Which of the four consent states a contact is in.
 *
 * Small function, load-bearing rule: the precedence decides whether someone who
 * unsubscribed after opting in is shown as safe to mail. Getting it the wrong
 * way round would put a green tick next to a person who told you to stop.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { contactConsentState } from "../../src/marketing/types.js";

const none = new Set<string>();

test("a contact with a consent record is opted in", () => {
  assert.equal(contactConsentState("a@b.com", none, new Set(["a@b.com"]), none), "opted-in");
});

test("a contact with no record anywhere is imported, not refused", () => {
  // Silence is the CSV-warranty case, not a refusal — the same reading
  // parseConsent takes on a blank consent column.
  assert.equal(contactConsentState("a@b.com", none, none, none), "imported");
});

test("suppression outranks an earlier grant", () => {
  // Opted in at checkout in March, unsubscribed in June. The unsubscribe wins,
  // and it has to win here as well as at send time — an organiser reading
  // "opted in" would reasonably believe they could mail them.
  const state = contactConsentState("a@b.com", new Set(["a@b.com"]), new Set(["a@b.com"]), none);
  assert.equal(state, "unsubscribed");
});

test("comparison is on the normalised address", () => {
  // Suppression and consent are both keyed by a hash of the lowercased address,
  // so a list holding "Bob@X.COM " must not read as a different person.
  assert.equal(contactConsentState(" Bob@X.COM ", none, new Set(["bob@x.com"]), none), "opted-in");
  assert.equal(contactConsentState(" Bob@X.COM ", new Set(["bob@x.com"]), none, none), "unsubscribed");
});

test("a buyer who left 'Don't email me' alone is soft-opt-in - its own state, never 'opted in'", () => {
  assert.equal(contactConsentState("a@b.com", none, none, new Set(["a@b.com"])), "soft-opt-in");
});

test("consent outranks a soft opt-in, and suppression outranks both", () => {
  const both = new Set(["a@b.com"]);
  assert.equal(contactConsentState("a@b.com", none, both, both), "opted-in");
  assert.equal(contactConsentState("a@b.com", both, none, both), "unsubscribed");
  assert.equal(contactConsentState(" A@B.com ", none, none, both), "soft-opt-in", "normalised like the rest");
});
