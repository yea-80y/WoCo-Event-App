/**
 * The buy-flow rules, pinned. Each test corresponds to a way the widget
 * could sell something it must not, send a body the server would misread,
 * or let a broken seat-hold service block a sale it cannot protect.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { PaymentConfig } from "@woco/shared";
import {
  seriesPayable,
  validateEmail,
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
  cancelUrl: "https://venue.example/tickets",
};

test("quantity 1 is omitted from the body (server default), >1 is sent", () => {
  assert.equal("quantity" in buildCheckoutBody(baseInputs), false);
  assert.equal(buildCheckoutBody({ ...baseInputs, quantity: 3 }).quantity, 3);
});

test("marketingConsent is always an explicit boolean — an untouched box is a refusal, never 'not asked'", () => {
  assert.equal(buildCheckoutBody(baseInputs).marketingConsent, false);
  assert.equal(buildCheckoutBody({ ...baseInputs, marketingConsent: true }).marketingConsent, true);
});

test("no returnUrl is ever sent — the organiser's domain cannot pass ALLOWED_HOSTS", () => {
  const body = buildCheckoutBody({
    ...baseInputs,
    encryptedOrder: { ephemeralPublicKey: "e", iv: "i", ciphertext: "c" },
    reservationId: "r1",
  });
  assert.equal("returnUrl" in body, false);
  assert.equal(body.cancelUrl, "https://venue.example/tickets");
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

test("email is trimmed; an address that cannot receive a ticket is refused", () => {
  assert.equal(validateEmail("  a@b.co  "), "a@b.co");
  assert.equal(validateEmail("nope"), null);
  assert.equal(validateEmail("   "), null);
});
