/**
 * The typed-error bridge and the #256 discriminator.
 *
 * `isSessionInvalid` is what keeps "the server rejected the session" from
 * rendering as "you have no data" — the properties pinned here are that it
 * fires ONLY on the exact envelope shape (`ok: false` + the SESSION_INVALID
 * code) and never on a success, a codeless failure, or a different code.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isSessionInvalid, apiError, MarketingSenderUnavailable, refusalText } from "../src/lib/api/errors.js";

test("a rejected session is recognised by code, not by text", () => {
  assert.ok(isSessionInvalid({ ok: false, code: "SESSION_INVALID" }));
});

test("no other envelope counts as a rejected session", () => {
  assert.ok(!isSessionInvalid({ ok: true }));
  // ok:true with a stray code must never read as a failure.
  assert.ok(!isSessionInvalid({ ok: true, code: "SESSION_INVALID" }));
  assert.ok(!isSessionInvalid({ ok: false }));
  assert.ok(!isSessionInvalid({ ok: false, code: "SESSION_CLOCK_SKEW" }));
  assert.ok(!isSessionInvalid({ ok: false, code: "SESSION_REPLAY" }));
});

test("apiError keeps the marketing-sender code across the throw, and only that one", () => {
  const typed = apiError({ error: "no sender", code: MarketingSenderUnavailable.CODE }, "fallback");
  assert.ok(typed instanceof MarketingSenderUnavailable);
  const plain = apiError({ error: "boom", code: "SESSION_INVALID" }, "fallback");
  assert.ok(!(plain instanceof MarketingSenderUnavailable));
  assert.equal(plain.message, "boom");
  assert.equal(apiError({}, "fallback").message, "fallback");
});

// #937: `register-on-chain` answers `{ error: "registry_unavailable", message: "<sentence>" }`,
// and the publish screen showed the code.
test("refusalText shows the sentence, not the code, when a route sends both", () => {
  const sentence = "We can't set up tickets right now because of a problem on our side - please contact support.";
  assert.equal(refusalText({ error: "registry_unavailable", message: sentence }, "please try again"), sentence);
  assert.equal(
    refusalText({ error: "registration_conflict", message: "Please contact support." }, "please try again"),
    "Please contact support.",
  );
});

test("refusalText keeps a route's error when it sends no sentence, and the fallback when it sends neither", () => {
  assert.equal(refusalText({ error: "Your tickets are still being set up." }, "please try again"), "Your tickets are still being set up.");
  // A blank or non-string message is no sentence.
  assert.equal(refusalText({ error: "boom", message: "  " }, "fallback"), "boom");
  assert.equal(refusalText({ error: "boom", message: 42 }, "fallback"), "boom");
  assert.equal(refusalText({}, "please try again"), "please try again");
  assert.equal(refusalText({ error: "" }, "please try again"), "please try again");
});

// `api/events.ts` imports the auth store, which declares `$state` and cannot
// load under Node, so the wiring is checked by source scan.
test("the publish screen's ticket set-up throws refusalText, not the raw error field", () => {
  const src = readFileSync(new URL("../src/lib/api/events.ts", import.meta.url), "utf-8");
  const start = src.indexOf("export async function registerSeriesOnChain(");
  assert.ok(start >= 0, "registerSeriesOnChain must exist - a rename would make this pass vacuously");
  const body = src.slice(start, src.indexOf("\n}", start));
  assert.match(body, /throw new Error\(refusalText\(resp, "please try again"\)\)/);
  assert.doesNotMatch(body, /resp\.error \|\|/);
});
