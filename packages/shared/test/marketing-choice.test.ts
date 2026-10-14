/**
 * The two checkout marketing controls (`legal/consent.ts`, PECR soft opt-in,
 * owner 2026-10-14).
 *
 * MUTATION: swap the own-events branch of `marketingDecision` and "an untouched
 * box" goes red; let `parseMarketingChoice` accept an unknown version or surface
 * and "a choice the server never showed" goes red; drop the name fill and "the
 * wording a buyer saw" goes red; edit a stored wording in place and "never edited"
 * goes red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  MARKETING_CONSENT_NOTICE,
  MARKETING_CURRENT_VERSION,
  MARKETING_OWN_EVENTS_BOX,
  MARKETING_WORDING,
  marketingChoice,
  marketingDecision,
  marketingWording,
  parseMarketingChoice,
} from "../src/legal/consent.js";

test("an untouched box means yes in own-events mode and no in consent mode", () => {
  assert.equal(marketingDecision("consent", false), "declined");
  assert.equal(marketingDecision("consent", true), "consent");
  assert.equal(marketingDecision("own-events", false), "soft-opt-in");
  assert.equal(marketingDecision("own-events", true), "declined");
});

test("the wording a buyer saw: the organiser named in the sentence, the box a refusal on its own", () => {
  const w = marketingWording("own-events", 1, "Punk Pub Ltd");
  assert.deepEqual(w, {
    sentence: "We'll email you about similar events from Punk Pub Ltd. You can unsubscribe from any email.",
    box: "Don't email me about similar events",
  });
  assert.match(MARKETING_OWN_EVENTS_BOX, /^Don't email me/);
  assert.deepEqual(marketingWording("consent", 1, "Punk Pub Ltd"), { box: MARKETING_CONSENT_NOTICE });
  // A name the page never had still reads as a sentence.
  assert.match(marketingWording("own-events", 1, "  ")!.sentence!, /from this organiser\./);
  assert.equal(marketingWording("own-events", 99, "x"), null);
  assert.equal(marketingWording("consent", 0, "x"), null);
});

test("never edited: consent v1 is the wording every earlier record was captured under", () => {
  assert.equal(MARKETING_WORDING.consent[1]!.box, "Email me about future events from this organiser. You can unsubscribe at any time.");
  assert.equal(MARKETING_CURRENT_VERSION.consent, 1);
  assert.equal(MARKETING_CURRENT_VERSION["own-events"], 1);
  for (const mode of ["consent", "own-events"] as const) {
    assert.ok(MARKETING_WORDING[mode][MARKETING_CURRENT_VERSION[mode]], `${mode} renders a version that exists`);
  }
});

test("the page's report of the control: what it showed and what the buyer did", () => {
  assert.deepEqual(marketingChoice("own-events", false, "embed"), { mode: "own-events", ticked: false, version: 1, surface: "embed" });
  const ok = { mode: "own-events", ticked: true, version: 1, surface: "pay-panel" };
  assert.deepEqual(parseMarketingChoice(ok), ok);
  assert.equal(parseMarketingChoice(undefined), undefined, "absent = no control shown, so nothing is recorded");
});

test("a choice the server never showed is refused, not guessed", () => {
  const ok = { mode: "consent", ticked: true, version: 1, surface: "order-form" };
  for (const bad of [
    null, "yes", [ok],
    { ...ok, mode: "soft" },
    { ...ok, ticked: "true" },
    { ...ok, ticked: undefined },
    { ...ok, version: 2 },
    { ...ok, version: "1" },
    { ...ok, surface: "agent" },
    { ...ok, surface: undefined },
  ]) {
    assert.equal(parseMarketingChoice(bad), null, JSON.stringify(bad));
  }
});

test("copy register: no em or en dashes in anything a buyer reads", () => {
  for (const mode of ["consent", "own-events"] as const) {
    for (const w of Object.values(MARKETING_WORDING[mode])) {
      assert.doesNotMatch(`${w.sentence ?? ""} ${w.box}`, /[–—]/);
    }
  }
});
