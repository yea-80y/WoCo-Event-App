/**
 * Which of the three consent states a contact is in.
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
  assert.equal(contactConsentState("a@b.com", none, new Set(["a@b.com"])), "opted-in");
});

test("a contact with no record anywhere is imported, not refused", () => {
  // Silence is the CSV-warranty case, not a refusal — the same reading
  // parseConsent takes on a blank consent column.
  assert.equal(contactConsentState("a@b.com", none, none), "imported");
});

test("suppression outranks an earlier grant", () => {
  // Opted in at checkout in March, unsubscribed in June. The unsubscribe wins,
  // and it has to win here as well as at send time — an organiser reading
  // "opted in" would reasonably believe they could mail them.
  const state = contactConsentState("a@b.com", new Set(["a@b.com"]), new Set(["a@b.com"]));
  assert.equal(state, "unsubscribed");
});

test("comparison is on the normalised address", () => {
  // Suppression and consent are both keyed by a hash of the lowercased address,
  // so a list holding "Bob@X.COM " must not read as a different person.
  assert.equal(contactConsentState(" Bob@X.COM ", none, new Set(["bob@x.com"])), "opted-in");
  assert.equal(contactConsentState(" Bob@X.COM ", new Set(["bob@x.com"]), none), "unsubscribed");
});
