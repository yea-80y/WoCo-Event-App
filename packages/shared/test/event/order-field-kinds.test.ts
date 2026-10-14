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
