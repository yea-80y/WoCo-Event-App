/**
 * What an order-form question asks, read from its label (`event/order-field-kinds.ts`).
 *
 * MUTATION: let `isHealthField` accept any truthy value and "only a literal true"
 * goes red; drop `!isHealthField` from `isKeptOnList` and "a health answer never
 * reaches a list" goes red; drop the health early-return in `orderFieldRequired`
 * and "a health question is never required" goes red; drop its email exception and
 * "the platform's email field stays required" goes red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isHealthField, isKeptOnList, orderFieldKind } from "../../src/event/order-field-kinds.js";
import { ORDER_EMAIL_FIELD_ID, orderFieldRequired } from "../../src/event/order-email.js";
import type { OrderField } from "../../src/crypto/types.js";

test("health questions are recognised from everyday labels", () => {
  for (const label of ["Allergies", "Any food allergies?", "Dietary requirements", "Diet", "Access needs",
    "Accessibility requirements", "Wheelchair user?", "Medical conditions we should know about", "Special requirements"]) {
    const k = orderFieldKind(label);
    assert.equal(k.health, true, label);
    assert.equal(k.keepByDefault, false, label);
  }
  for (const label of ["Full name", "Area", "Instagram handle", "How did you hear about us?", "Access code", "T-shirt size"]) {
    assert.equal(orderFieldKind(label).health, false, label);
  }
});

test("every UK GDPR Art. 9 category and Art. 10 criminal convictions read as sensitive", () => {
  const categories: Record<string, string[]> = {
    "health, diet or access": ["Allergies", "Dietary requirements", "Access needs", "Any mental health needs?", "Do you need a hearing loop?", "BSL interpreter needed?"],
    "religion or belief": ["Religion", "Faith", "Religious beliefs", "Halal meal?", "Kosher option", "Do you need a prayer room?"],
    "racial or ethnic origin": ["Ethnicity", "Ethnic origin", "Racial background"],
    "sexual orientation or sex life": ["Sexual orientation", "Sexuality", "Are you LGBTQ+?"],
    "political opinions": ["Political views", "Which political party do you support?", "Party membership", "Who did you vote for?"],
    "trade union membership": ["Trade union", "Union membership number", "Are you a union member?"],
    "genetic or biometric": ["Genetic conditions", "DNA test kit opt-in", "Biometric data", "Fingerprint for entry"],
    "criminal convictions (Art. 10)": ["Criminal record", "Any unspent convictions?", "DBS check number", "Offences"],
  };
  for (const [category, labels] of Object.entries(categories)) {
    for (const label of labels) assert.equal(orderFieldKind(label).health, true, `${category}: ${label}`);
  }
});

test("the categories stay narrow where a word is ambiguous at events", () => {
  for (const label of ["Which race are you running?", "Race distance", "Rugby union or league?", "Party size",
    "Hen party name", "Orientation session", "Instrumental or vocal?", "Environmental group", "Christian name",
    "Union Street entrance", "Vote for your favourite band"]) {
    assert.equal(orderFieldKind(label).health, false, label);
  }
});

test("names and where someone lives are kept by default; phone and everything else are not", () => {
  const cases: [string, string | null, boolean][] = [
    ["First name", "firstName", true],
    ["Surname", "lastName", true],
    ["Full name", "fullName", true],
    ["Name", "fullName", true],
    ["Postcode", "postcode", true],
    ["Town / city", "city", true],
    ["Area", "city", true],
    ["Where do you live?", "city", true],
    ["Mobile number", "phone", false],
    ["Seating area", null, false],
    ["Company name", null, false],
    ["How did you hear about us?", null, false],
  ];
  for (const [label, slot, kept] of cases) {
    const k = orderFieldKind(label);
    assert.equal(k.slot, slot, label);
    assert.equal(k.keepByDefault, kept, label);
  }
});

test("only a literal true marks a health question", () => {
  assert.equal(isHealthField({ health: true }), true);
  assert.equal(isHealthField({ health: "yes" as unknown as boolean }), false);
  assert.equal(isHealthField({}), false);
});

test("a health answer never reaches a list, whatever the flags say", () => {
  assert.equal(isKeptOnList({ keepOnList: true }), true);
  assert.equal(isKeptOnList({ keepOnList: true, health: true }), false);
  assert.equal(isKeptOnList({ keepOnList: "yes" as unknown as boolean }), false);
});

test("a health question is never required, but the platform's email field stays required", () => {
  const health: OrderField = { id: "allergy", type: "text", label: "Allergies", required: true, health: true };
  assert.equal(orderFieldRequired(health, { canUseAccount: false }), false);
  const email: OrderField = { id: ORDER_EMAIL_FIELD_ID, type: "email", label: "Email", required: false, health: true };
  assert.equal(orderFieldRequired(email, { canUseAccount: false }), true);
});
