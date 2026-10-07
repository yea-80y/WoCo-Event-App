/**
 * Server-side bounds on checkout input: the guest's email (#638) and the event's
 * order form (#720). Both used to be stored or forwarded as sent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { claimerEmailRefusal, MAX_EMAIL_LENGTH } from "../src/lib/stripe/claimer-email.js";
import {
  MAX_ORDER_FIELDS,
  MAX_ORDER_FIELD_MAXLENGTH,
  MAX_ORDER_FIELD_OPTIONS,
  MAX_ORDER_FIELD_TEXT,
  orderFieldsRefusal,
} from "../src/lib/event/order-fields.js";

// ---------------------------------------------------------------------------
// claimerEmail (#638)
// ---------------------------------------------------------------------------

test("absent is left to the presence check", () => {
  assert.equal(claimerEmailRefusal(undefined), null);
  assert.equal(claimerEmailRefusal(""), null);
});

test("a plausible address passes", () => {
  for (const e of ["a@b.co", "First.Last+tag@sub.example.org"]) assert.equal(claimerEmailRefusal(e), null, e);
});

test("anything else is refused with a sentence a buyer can read", () => {
  const bad: unknown[] = ["no-at-sign", "a@b", "a@@b.co", "a b@c.co", " a@b.co", "a@b.co\n", 42, ["a@b.co"], { e: 1 }];
  for (const e of bad) assert.equal(claimerEmailRefusal(e), "Please enter a valid email address.", String(e));
});

test("longer than the RFC 5321 path limit is refused", () => {
  const at = (n: number) => "a".repeat(n - "@b.co".length) + "@b.co";
  assert.equal(claimerEmailRefusal(at(MAX_EMAIL_LENGTH)), null);
  assert.notEqual(claimerEmailRefusal(at(MAX_EMAIL_LENGTH + 1)), null);
});

test("create-checkout runs the email check before the presence check", () => {
  const src = readFileSync(new URL("../src/routes/stripe.ts", import.meta.url), "utf-8");
  const check = src.indexOf("claimerEmailRefusal(claimerEmail)");
  assert.ok(check > 0, "create-checkout must call claimerEmailRefusal");
  assert.ok(check < src.indexOf("if (!claimerEmail && !verifiedAddress)"));
});

// ---------------------------------------------------------------------------
// orderFields (#720)
// ---------------------------------------------------------------------------

const field = (over: Record<string, unknown> = {}) => ({ id: "f1", type: "text", label: "Name", required: false, ...over });

test("no form, an empty form and the editor's own fields pass", () => {
  assert.equal(orderFieldsRefusal(undefined), null);
  assert.equal(orderFieldsRefusal([]), null);
  assert.equal(
    orderFieldsRefusal([
      { id: "__email", type: "email", label: "Email", required: true, placeholder: "your@email.com" },
      { id: "field_1759766400000", type: "select", label: "Size", required: false, options: ["S", "M", "L"] },
      { id: "field_1759766400001", type: "textarea", label: "", required: false, maxLength: 500 },
      { id: "field_1759766400002", type: "checkbox", label: "Agree", required: true },
    ]),
    null,
  );
});

test("the field count is bounded", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => field({ id: `f${i}` }));
  assert.equal(orderFieldsRefusal(many(MAX_ORDER_FIELDS)), null);
  assert.match(orderFieldsRefusal(many(MAX_ORDER_FIELDS + 1)) ?? "", /at most 20 fields/);
});

test("each field's shape is checked, and the message names the field", () => {
  const cases: [unknown, RegExp][] = [
    ["not-an-array", /must be an array/],
    [[null], /field 1 is not a field/],
    [[field({ id: "has space" })], /invalid id/],
    [[field({ id: "x".repeat(65) })], /invalid id/],
    [[field(), field()], /field 2 repeats the id "f1"/],
    [[field({ type: "file" })], /unknown type/],
    [[field({ label: 5 })], /label/],
    [[field({ label: "x".repeat(MAX_ORDER_FIELD_TEXT + 1) })], /label/],
    [[field({ required: "yes" })], /required/],
    [[field({ placeholder: "x".repeat(MAX_ORDER_FIELD_TEXT + 1) })], /placeholder/],
    [[field({ options: "a,b" })], /options/],
    [[field({ options: Array.from({ length: MAX_ORDER_FIELD_OPTIONS + 1 }, (_, i) => `o${i}`) })], /options/],
    [[field({ options: ["ok", 7] })], /options/],
    [[field({ maxLength: '1" onfocus="x' })], /maxLength/],
    [[field({ maxLength: 0 })], /maxLength/],
    [[field({ maxLength: 1.5 })], /maxLength/],
    [[field({ maxLength: MAX_ORDER_FIELD_MAXLENGTH + 1 })], /maxLength/],
  ];
  for (const [raw, re] of cases) assert.match(orderFieldsRefusal(raw) ?? "(passed)", re, JSON.stringify(raw).slice(0, 80));
});

test("event create runs the order-form check", () => {
  const src = readFileSync(new URL("../src/routes/events.ts", import.meta.url), "utf-8");
  assert.ok(src.includes("orderFieldsRefusal(orderFields)"), "POST /api/events must call orderFieldsRefusal");
});
