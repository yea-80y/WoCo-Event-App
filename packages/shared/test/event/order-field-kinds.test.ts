/**
 * What an order-form question asks, read from its label (`event/order-field-kinds.ts`).
 *
 * MUTATION (each went red, then restored): drop a category from SENSITIVE_RE and
 * its line of "every UK GDPR Art. 9 category" goes red; drop any line of the
 * dietary/access/health additions, `offender|caution`, or food|meal|menu and
 * "everyday ... labels" goes red, and drop the `christian` or `vote` lookahead and
 * "stay narrow" goes red (2026-10-15 sign-off); let `isHealthField` read
 * only a literal true and "doubt reads as sensitive" goes red; drop
 * `!isHealthField` from `isKeptOnList` and "a sensitive answer never reaches a
 * list" goes red; drop its email exception and "the platform's email field is not
 * an answer" goes red; let `listKeeps` keep the name question among the answers
 * and "the name is said once" goes red; drop the health early-return in
 * `orderFieldRequired` and "a sensitive question is never required" goes red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isHealthField, isKeptOnList, listKeeps, listPlacement, orderFieldKind } from "../../src/event/order-field-kinds.js";
import { ORDER_EMAIL_FIELD_ID, orderFieldRequired } from "../../src/event/order-email.js";
import type { OrderField } from "../../src/crypto/types.js";

test("health questions are recognised from everyday labels", () => {
  for (const label of ["Allergies", "Any food allergies?", "Dietary requirements", "Diet", "Access needs",
    "Accessibility requirements", "Wheelchair user?", "Medical conditions we should know about", "Special requirements"]) {
    assert.equal(orderFieldKind(label).health, true, label);
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

test("everyday dietary, access, health, belief, political and criminal labels read as sensitive", () => {
  for (const label of [
    "Vegetarian?", "Vegan or vegetarian", "Gluten free?", "Meal choice", "Food requirements", "Dairy free",
    "Additional needs", "Support needs", "Reasonable adjustments", "Guide dog / assistance dog",
    "Carer or companion ticket needed?", "Blue badge holder?", "Vaccination status", "Covid vaccinated?",
    "HIV status", "Dyslexia", "Impairment", "Hard of hearing", "Partially sighted", "Seizures / photosensitive",
    "Lift access", "Christian?", "Which party do you vote for?", "Offender", "Caution",
    // Owner 2026-10-15: a food question reads as dietary; "Not sensitive?" keeps it.
    "Favourite food type?",
  ]) {
    assert.equal(orderFieldKind(label).health, true, label);
  }
  for (const label of ["T-shirt size", "Favourite music genre?", "Town", "Company", "Job title"]) {
    assert.equal(orderFieldKind(label).health, false, label);
  }
});

test("the categories stay narrow where a word is ambiguous at events", () => {
  for (const label of ["Which race are you running?", "Race distance", "Rugby union or league?", "Party size",
    "Hen party name", "Orientation session", "Instrumental or vocal?", "Environmental group", "Christian name",
    "Union Street entrance", "Vote for your favourite band"]) {
    assert.equal(orderFieldKind(label).health, false, label);
  }
});

test("names, postcode, town and phone land in the list entry's own fields", () => {
  const cases: [string, string | null][] = [
    ["First name", "firstName"],
    ["Surname", "lastName"],
    ["Full name", "fullName"],
    ["Name", "fullName"],
    ["Postcode", "postcode"],
    ["Town / city", "city"],
    ["Area", "city"],
    ["Where do you live?", "city"],
    ["Mobile number", "phone"],
    ["Seating area", null],
    ["Company name", null],
    ["How did you hear about us?", null],
  ];
  for (const [label, slot] of cases) assert.equal(orderFieldKind(label).slot, slot, label);
});

const f = (over: Partial<OrderField> & { label: string }): OrderField => ({ id: over.label, type: "text", required: false, ...over });

test("the organiser's saved answer decides; a question saved without one is read from its label; doubt reads as sensitive", () => {
  assert.equal(isHealthField(f({ label: "Allergies", health: true })), true);
  assert.equal(isHealthField(f({ label: "Area", health: true })), true);
  assert.equal(isHealthField(f({ label: "Allergies", health: false })), false, "the Not sensitive? override");
  assert.equal(isHealthField(f({ label: "Religion" })), true, "no saved answer: the label");
  assert.equal(isHealthField(f({ label: "Area" })), false);
  for (const doubt of ["yes", "no", 1, 0, null, "false"]) {
    assert.equal(isHealthField(f({ label: "Area", health: doubt as unknown as boolean })), true, JSON.stringify(doubt));
  }
  assert.equal(isHealthField({ health: undefined, label: 7 as unknown as string }), false, "a label that is not text never throws");
});

test("a sensitive answer never reaches a list, whatever else the flags say", () => {
  assert.equal(isKeptOnList(f({ label: "Area", health: false })), true);
  assert.equal(isKeptOnList(f({ label: "Area" })), true);
  assert.equal(isKeptOnList(f({ label: "Area", health: true })), false);
  assert.equal(isKeptOnList(f({ label: "Halal meal?" })), false);
  // The retired key cannot bring one back.
  assert.equal(isKeptOnList({ ...f({ label: "Allergies", health: true }), keepOnList: true } as OrderField), false);
  assert.equal(isKeptOnList(f({ label: "Area", health: "true" as unknown as boolean })), false);
});

test("the platform's email field is not an answer: it is the entry's own address", () => {
  assert.equal(isKeptOnList(f({ id: ORDER_EMAIL_FIELD_ID, label: "Email" })), false);
  assert.equal(isKeptOnList(f({ id: "guest_email", type: "email", label: "Guest's email" })), true, "an organiser's own email question is an answer");
});

test("listKeeps: the name is said once, every other kept answer by label in form order", () => {
  assert.deepEqual(listKeeps(undefined), { name: false, answers: [] });
  assert.deepEqual(listKeeps([]), { name: false, answers: [] });
  assert.deepEqual(listKeeps([f({ label: "Full name" })]), { name: true, answers: [] });
  assert.deepEqual(
    listKeeps([
      f({ id: ORDER_EMAIL_FIELD_ID, type: "email", label: "Email" }),
      f({ label: "Town" }),
      f({ label: "First name" }),
      f({ label: "Allergies", health: true }),
      f({ label: "Surname" }),
      f({ label: "How   did you hear about us?" }),
      f({ label: "Religion" }),
      f({ label: "Postcode" }),
      f({ id: "dup", label: "Town" }),
      f({ label: "   " }),
    ]),
    { name: true, answers: ["Town", "How did you hear about us?", "Postcode"] },
  );
  // A crafted feed: anything but an array of objects keeps nothing, and never throws.
  assert.deepEqual(listKeeps({} as unknown as OrderField[]), { name: false, answers: [] });
  assert.deepEqual(listKeeps([null, 3] as unknown as OrderField[]), { name: false, answers: [] });
});

test("listPlacement names a kept answer by its tidied label; an unnamed or sensitive one is not placed", () => {
  assert.deepEqual(listPlacement(f({ label: "  Your   postcode " })), { slot: "postcode", label: "Your postcode" });
  assert.deepEqual(listPlacement(f({ label: "Allergies", health: false })), { slot: null, label: "Allergies" });
  assert.equal(listPlacement(f({ label: "" })), null);
  assert.equal(listPlacement(f({ label: "Allergies" })), null);
});

test("a sensitive question is never required, but the platform's email field stays required", () => {
  const health: OrderField = { id: "allergy", type: "text", label: "Allergies", required: true, health: true };
  assert.equal(orderFieldRequired(health, { canUseAccount: false }), false);
  const unflagged: OrderField = { id: "faith", type: "text", label: "Religion", required: true };
  assert.equal(orderFieldRequired(unflagged, { canUseAccount: false }), false);
  const email: OrderField = { id: ORDER_EMAIL_FIELD_ID, type: "email", label: "Email", required: false, health: true };
  assert.equal(orderFieldRequired(email, { canUseAccount: false }), true);
});
