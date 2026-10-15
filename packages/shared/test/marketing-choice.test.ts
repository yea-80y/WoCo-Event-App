/**
 * The two checkout marketing controls (`legal/consent.ts`, PECR soft opt-in,
 * owner 2026-10-14), and the wording that names what the list keeps (2026-10-15).
 *
 * MUTATION (each went red, then restored): swap the own-events branch of
 * `marketingDecision` and "an untouched box" goes red; let `parseMarketingChoice`
 * accept an unknown version or surface and "a choice the server never showed"
 * goes red; drop the name fill and "the organiser named" goes red; edit a stored
 * wording in place and "never edited" goes red; drop the name from the keeps
 * clause and "name only" and "name and others" go red; join a lone name with a
 * comma and "name only" goes red; fill by two passes and "a name is filled once" goes red;
 * let `sameMarketingWording` ignore the sentence and "same wording" goes red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  isMarketingChanged,
  MARKETING_CURRENT_VERSION,
  MARKETING_OWN_EVENTS_BOX,
  MARKETING_WORDING,
  marketingChoice,
  marketingDecision,
  marketingWording,
  parseMarketingChoice,
  sameMarketingWording,
} from "../src/legal/consent.js";
import { listKeeps } from "../src/event/order-field-kinds.js";
import { ORDER_EMAIL_FIELD_ID } from "../src/event/order-email.js";
import type { OrderField } from "../src/crypto/types.js";

const NONE = { name: false, answers: [] };
const q = (label: string, over: Partial<OrderField> = {}): OrderField => ({ id: label, type: "text", label, required: false, ...over });
/** What the page and create-checkout both build, for an event's questions. */
const shown = (mode: "consent" | "own-events", fields: OrderField[], organiser = "Punk Pub Ltd") =>
  marketingWording(mode, MARKETING_CURRENT_VERSION[mode], organiser, listKeeps(fields))!;

test("an untouched box means yes in own-events mode and no in consent mode", () => {
  assert.equal(marketingDecision("consent", false), "declined");
  assert.equal(marketingDecision("consent", true), "consent");
  assert.equal(marketingDecision("own-events", false), "soft-opt-in");
  assert.equal(marketingDecision("own-events", true), "declined");
});

test("no extra questions: the wording keeps the email only", () => {
  assert.deepEqual(shown("consent", []), {
    box: "Email me about future events from this organiser. We'll keep your email for this. You can unsubscribe at any time.",
  });
  assert.deepEqual(shown("own-events", [q("Email", { id: ORDER_EMAIL_FIELD_ID, type: "email" })]), {
    sentence: "We'll email you about similar events from Punk Pub Ltd, and keep your email for this. You can unsubscribe from any email.",
    box: "Don't email me about similar events",
  });
});

test("name only: 'your email and name', with no answers clause", () => {
  assert.equal(
    shown("consent", [q("Full name")]).box,
    "Email me about future events from this organiser. We'll keep your email and name for this. You can unsubscribe at any time.",
  );
  assert.equal(
    shown("own-events", [q("First name"), q("Surname")]).sentence,
    "We'll email you about similar events from Punk Pub Ltd, and keep your email and name for this. You can unsubscribe from any email.",
  );
});

test("answers without a name: 'your email and your answers to: A'", () => {
  assert.equal(
    shown("consent", [q("Town")]).box,
    "Email me about future events from this organiser. We'll keep your email and your answers to: Town for this. You can unsubscribe at any time.",
  );
});

test("name and others: the name once, then every other answer by label", () => {
  const fields = [q("First name"), q("Town"), q("Surname"), q("How did you hear about us?")];
  assert.equal(
    shown("consent", fields).box,
    "Email me about future events from this organiser. We'll keep your email, name and your answers to: Town, How did you hear about us? for this. You can unsubscribe at any time.",
  );
  assert.equal(
    shown("own-events", fields).sentence,
    "We'll email you about similar events from Punk Pub Ltd, and keep your email, name and your answers to: Town, How did you hear about us? for this. You can unsubscribe from any email.",
  );
  assert.equal(shown("own-events", fields).box, MARKETING_OWN_EVENTS_BOX, "the box stays a refusal on its own");
});

test("a sensitive question is never named, flagged or read from its label", () => {
  const fields = [q("Allergies", { health: true }), q("Postcode"), q("Religion"), q("Seat", { health: "yes" as unknown as boolean })];
  assert.equal(
    shown("consent", fields).box,
    "Email me about future events from this organiser. We'll keep your email and your answers to: Postcode for this. You can unsubscribe at any time.",
  );
  assert.equal(shown("consent", [q("Halal meal?")]).box, shown("consent", []).box);
});

test("form order is kept, whatever the slot", () => {
  const a = shown("consent", [q("Phone"), q("Company"), q("Postcode")]).box;
  assert.match(a, /your answers to: Phone, Company, Postcode for this/);
  const b = shown("consent", [q("Postcode"), q("Company"), q("Phone")]).box;
  assert.match(b, /your answers to: Postcode, Company, Phone for this/);
});

test("the organiser named in the sentence; a blank name still reads as a sentence; a name is filled once", () => {
  assert.match(shown("own-events", [], "  ").sentence!, /from this organiser, and keep/);
  // One pass: a name or label that itself reads like a placeholder is never filled again.
  assert.equal(
    shown("own-events", [q("{organiser}")], "Pub {keeps} $& Co").sentence,
    "We'll email you about similar events from Pub {keeps} $& Co, and keep your email and your answers to: {organiser} for this. You can unsubscribe from any email.",
  );
  assert.equal(marketingWording("own-events", 99, "x", NONE), null);
  assert.equal(marketingWording("consent", 0, "x", NONE), null);
});

test("never edited: v1 is the wording every earlier record was captured under, and still resolves", () => {
  assert.equal(MARKETING_WORDING.consent[1]!.box, "Email me about future events from this organiser. You can unsubscribe at any time.");
  assert.equal(
    MARKETING_WORDING["own-events"][1]!.sentence,
    "We'll email you about similar events from {organiser}. You can unsubscribe from any email.",
  );
  // An old record's text, rebuilt by mode and version: what keeps says is ignored.
  assert.deepEqual(marketingWording("consent", 1, "P", { name: true, answers: ["Town"] }), {
    box: "Email me about future events from this organiser. You can unsubscribe at any time.",
  });
  assert.equal(
    marketingWording("own-events", 1, "Punk Pub Ltd", { name: true, answers: ["Town"] })!.sentence,
    "We'll email you about similar events from Punk Pub Ltd. You can unsubscribe from any email.",
  );
  assert.equal(MARKETING_CURRENT_VERSION.consent, 2);
  assert.equal(MARKETING_CURRENT_VERSION["own-events"], 2);
  for (const mode of ["consent", "own-events"] as const) {
    assert.ok(MARKETING_WORDING[mode][MARKETING_CURRENT_VERSION[mode]], `${mode} renders a version that exists`);
  }
});

test("same wording means the same sentence and the same box", () => {
  const w = shown("own-events", [q("Town")]);
  assert.equal(sameMarketingWording(w, { ...w }), true);
  assert.equal(sameMarketingWording(w, { box: w.box }), false, "a missing sentence is a difference");
  assert.equal(sameMarketingWording(w, { ...w, sentence: w.sentence + " " }), false);
  assert.equal(sameMarketingWording(w, { ...w, box: "Email me" }), false);
  assert.equal(sameMarketingWording({ box: "x" }, { box: "x" }), true);
});

test("the page's report of the control: what it showed, its words, and what the buyer did", () => {
  const w = shown("own-events", [q("Town")]);
  assert.deepEqual(marketingChoice("own-events", false, "embed", w), { mode: "own-events", ticked: false, version: 2, surface: "embed", wording: w });
  assert.deepEqual(marketingChoice("consent", true, "order-form", undefined), { mode: "consent", ticked: true, version: 2, surface: "order-form" });
  const ok = { mode: "own-events", ticked: true, version: 2, surface: "pay-panel", wording: w };
  assert.deepEqual(parseMarketingChoice(ok), ok);
  const metadataShape = { mode: "consent", ticked: true, version: 1, surface: "order-form" };
  assert.deepEqual(parseMarketingChoice(metadataShape), metadataShape, "a paid session carries no wording");
  assert.equal(parseMarketingChoice(undefined), undefined, "absent = no control shown, so nothing is recorded");
});

test("a choice the server never showed is refused, not guessed", () => {
  const ok = { mode: "consent", ticked: true, version: 2, surface: "order-form" };
  for (const bad of [
    null, "yes", [ok],
    { ...ok, mode: "soft" },
    { ...ok, ticked: "true" },
    { ...ok, ticked: undefined },
    { ...ok, version: 3 },
    { ...ok, version: "2" },
    { ...ok, surface: "agent" },
    { ...ok, surface: undefined },
    { ...ok, wording: "Email me" },
    { ...ok, wording: null },
    { ...ok, wording: [] },
    { ...ok, wording: { sentence: "x" } },
    { ...ok, wording: { box: 1 } },
    { ...ok, wording: { box: "x", sentence: 2 } },
    { ...ok, wording: { box: "x".repeat(16_001) } },
  ]) {
    assert.equal(parseMarketingChoice(bad), null, JSON.stringify(bad).slice(0, 120));
  }
});

test("both refusals send the page back to the control; nothing else does", () => {
  assert.equal(isMarketingChanged("MARKETING_MODE_CHANGED"), true);
  assert.equal(isMarketingChanged("MARKETING_WORDING_CHANGED"), true);
  for (const other of ["ORDER_KEY_STALE", undefined, null, "marketing_mode_changed"]) assert.equal(isMarketingChanged(other), false);
});

test("copy register: no em or en dashes in anything a buyer reads", () => {
  for (const mode of ["consent", "own-events"] as const) {
    for (const w of Object.values(MARKETING_WORDING[mode])) {
      assert.doesNotMatch(`${w.sentence ?? ""} ${w.box}`, /[–—]/);
    }
  }
});
