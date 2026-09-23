/**
 * The buy-flow rules, pinned. Each test corresponds to a way the widget
 * could sell something it must not, send a body the server would misread,
 * or let a broken seat-hold service block a sale it cannot protect.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { OrderField, PaymentConfig } from "@woco/shared";
import {
  seriesPayable,
  validateBuyPanel,
  maxSelectableQty,
  buildOrderPayload,
  buildCheckoutBody,
  reserveOutcome,
  MAX_QTY,
} from "../src/checkout.js";

const stripePayment = (over: Partial<PaymentConfig> = {}): PaymentConfig => ({
  price: "12.00",
  currency: "GBP",
  stripeEnabled: true,
  cryptoEnabled: false,
  ...over,
} as PaymentConfig);

// ---------------------------------------------------------------------------
// Rule 1 — only a series a card checkout can complete gets a buy button
// ---------------------------------------------------------------------------

test("a Stripe-enabled priced series is payable", () => {
  assert.equal(seriesPayable(stripePayment()), true);
});

test("no payment config at all is not payable (pre-#141 events, stale cache)", () => {
  assert.equal(seriesPayable(undefined), false);
});

test("a zero-price series is not payable", () => {
  assert.equal(seriesPayable(stripePayment({ price: "0" })), false);
});

test("a crypto-only series is not payable while the crypto rail is off", () => {
  assert.equal(
    seriesPayable(stripePayment({ stripeEnabled: false, cryptoEnabled: true })),
    false,
  );
});

// ---------------------------------------------------------------------------
// Rule 2 — the wire body matches what create-checkout destructures
// ---------------------------------------------------------------------------

const baseInputs = {
  eventId: "ev1",
  seriesId: "s1",
  claimerEmail: "a@b.co",
  quantity: 1,
  marketingConsent: false,
  pageUrl: "https://venue.example/tickets",
};

test("quantity 1 is omitted from the body (server default), >1 is sent", () => {
  assert.equal("quantity" in buildCheckoutBody(baseInputs), false);
  assert.equal(buildCheckoutBody({ ...baseInputs, quantity: 3 }).quantity, 3);
});

test("marketingConsent is always an explicit boolean — an untouched box is a refusal, never 'not asked'", () => {
  assert.equal(buildCheckoutBody(baseInputs).marketingConsent, false);
  assert.equal(buildCheckoutBody({ ...baseInputs, marketingConsent: true }).marketingConsent, true);
});

test("the page goes as pageUrl, and no returnUrl or cancelUrl is sent - the server derives both redirects from it (#567)", () => {
  const body = buildCheckoutBody({
    ...baseInputs,
    encryptedOrder: { ephemeralPublicKey: "e", iv: "i", ciphertext: "c" },
    reservationId: "r1",
  });
  assert.equal(body.pageUrl, "https://venue.example/tickets");
  assert.equal("returnUrl" in body, false);
  assert.equal("cancelUrl" in body, false);
});

test("with no known page, neither pageUrl nor cancelUrl is sent, so the server's WoCo pages apply", () => {
  const body = buildCheckoutBody({ ...baseInputs, pageUrl: undefined });
  assert.equal("pageUrl" in body, false);
  assert.equal("cancelUrl" in body, false);
});

test("absent encryptedOrder / reservationId are omitted, not sent as undefined", () => {
  const body = buildCheckoutBody(baseInputs);
  assert.equal("encryptedOrder" in body, false);
  assert.equal("reservationId" in body, false);
});

test("the sealed payload carries fields + seriesId + claimerEmail, the shape the dashboard decrypts", () => {
  assert.deepEqual(buildOrderPayload({ name: "Ada" }, "s1", "a@b.co"), {
    fields: { name: "Ada" },
    seriesId: "s1",
    claimerEmail: "a@b.co",
  });
});

// ---------------------------------------------------------------------------
// Rule 3 — a failed hold only stops the sale when seats definitively ran out
// ---------------------------------------------------------------------------

test("a granted hold is used", () => {
  const o = reserveOutcome({ ok: true, data: { reservationId: "abc" } });
  assert.deepEqual(o, { kind: "reserved", reservationId: "abc" });
});

test("'Insufficient seats' blocks the purchase honestly", () => {
  const o = reserveOutcome({ ok: false, error: "Insufficient seats" });
  assert.equal(o.kind, "blocked");
});

test("a rate-limited hold proceeds without one — the hold service must not block a sale it cannot protect", () => {
  assert.equal(reserveOutcome({ ok: false, error: "Rate limit exceeded" }).kind, "proceed");
});

test("a dead reservation endpoint (network throw → null) proceeds without a hold", () => {
  assert.equal(reserveOutcome(null).kind, "proceed");
});

test("an ok response with no reservationId proceeds rather than sending a phantom id", () => {
  assert.equal(reserveOutcome({ ok: true, data: {} }).kind, "proceed");
});

// ---------------------------------------------------------------------------
// Rule 4 — quantity and email plumbing
// ---------------------------------------------------------------------------

test("quantity picker is capped by availability and by the server clamp", () => {
  assert.equal(maxSelectableQty(3), 3);
  assert.equal(maxSelectableQty(500), MAX_QTY);
  assert.equal(maxSelectableQty(0), 1); // sold-out cards never render the picker; floor stays sane
  assert.equal(maxSelectableQty(NaN), MAX_QTY); // unreadable count falls back to the server clamp
});

// ── #597: the buy panel reads the order form's email field ──────────────────

const KEY = "ab".repeat(32);
const EMAIL: OrderField = { id: "__email", type: "email", label: "Email", required: true };
const NAME: OrderField = { id: "name", type: "text", label: "Name", required: true };
const GUEST: OrderField = { id: "guest", type: "email", label: "Guest's email", required: false };
const panel = (fields: OrderField[] | undefined, formData: Record<string, string>, inlineEmail = "", key: string | undefined = KEY) =>
  validateBuyPanel({ fields, encryptionKey: key, formData, inlineEmail });

test("the default order form's email field is the ticket address (the #597 dead-end)", () => {
  assert.deepEqual(panel([EMAIL, NAME], { __email: " buyer@example.com ", name: "Ann" }), { ok: true, email: "buyer@example.com" });
});

test("a blank email field is refused by its own label, even when the organiser left it optional", () => {
  // No wallet or account path here: that field is the only way a ticket arrives.
  const optional = { ...EMAIL, required: false, label: "Your email" };
  assert.deepEqual(panel([optional], {}), { ok: false, error: "Your email is required" });
});

test("an implausible email in the form names the field to fix", () => {
  assert.deepEqual(panel([EMAIL], { __email: "not-an-address" }), { ok: false, error: "Enter a valid email address in Email" });
});

test("an unlabelled field is named by its placeholder, never by its internal id", () => {
  const bare: OrderField = { id: "field_1727000000000", type: "text", label: "", required: true };
  assert.deepEqual(panel([bare], {}), { ok: false, error: "This field is required" });
  assert.deepEqual(panel([{ ...bare, placeholder: "Your name" }], {}), { ok: false, error: "Your name is required" });
});

test("errors come top to bottom, in the order the buyer sees the fields", () => {
  assert.deepEqual(panel([NAME, EMAIL], {}), { ok: false, error: "Name is required" });
  assert.deepEqual(panel([EMAIL, NAME], {}), { ok: false, error: "Email is required" });
});

test("with no email field in the form, the widget's own box is the address", () => {
  assert.deepEqual(panel([NAME], { name: "Ann" }, "me@example.com"), { ok: true, email: "me@example.com" });
  assert.deepEqual(panel([NAME], { name: "Ann" }, ""), { ok: false, error: "Enter a valid email address" });
  assert.deepEqual(panel(undefined, {}, " me@example.com "), { ok: true, email: "me@example.com" });
});

test("a guest's email field never becomes the ticket address", () => {
  assert.deepEqual(panel([GUEST], { guest: "friend@example.com" }, "me@example.com"), { ok: true, email: "me@example.com" });
});

test("a form that cannot be shown (no organiser key) falls back to the widget's box, never a dead-end", () => {
  const noKey = validateBuyPanel({ fields: [EMAIL], encryptionKey: undefined, formData: {}, inlineEmail: "me@example.com" });
  assert.deepEqual(noKey, { ok: true, email: "me@example.com" });
});
