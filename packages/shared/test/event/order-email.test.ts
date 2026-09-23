/**
 * #597: one rule for which address a ticket goes to, shared by the main app
 * and the embed. Each case is a way a buyer could be stranded with no box to
 * type into, or a ticket (and a marketing opt-in) sent to the wrong person.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ORDER_EMAIL_FIELD_ID,
  orderFormShown,
  orderFormCollectsEmail,
  resolveBuyerEmail,
} from "../../src/event/order-email.js";
import type { OrderField } from "../../src/crypto/types.js";

const KEY = "ab".repeat(32);
const emailField: OrderField = { id: ORDER_EMAIL_FIELD_ID, type: "email", label: "Email", required: true };
const guestEmail: OrderField = { id: "guest", type: "email", label: "Guest's email", required: false };
const name: OrderField = { id: "name", type: "text", label: "Name", required: true };

test("the form is shown only with fields AND the organiser's key", () => {
  assert.equal(orderFormShown([name], KEY), true);
  assert.equal(orderFormShown([name], undefined), false);
  assert.equal(orderFormShown([], KEY), false);
  assert.equal(orderFormShown(undefined, KEY), false);
});

test("only the platform's __email field counts as collecting the ticket address", () => {
  assert.equal(orderFormCollectsEmail([emailField, name], KEY), true);
  assert.equal(orderFormCollectsEmail([guestEmail, name], KEY), false, "a guest's email field must not hide the buyer's box");
});

test("a form that is not shown collects nothing, so the surface keeps its own box", () => {
  // __email present but no key: neither surface renders the fields.
  assert.equal(orderFormCollectsEmail([emailField], undefined), false);
});

test("the address comes from the form's field when the form collects it", () => {
  const got = resolveBuyerEmail({ [ORDER_EMAIL_FIELD_ID]: "  buyer@example.com " }, [emailField], KEY, "other@example.com");
  assert.equal(got, "buyer@example.com");
});

test("the form's field is not second-guessed by a hidden box", () => {
  // The inline box is not on screen when the form collects email, so a stale
  // value in it must never be used in place of an empty form field.
  assert.equal(resolveBuyerEmail({}, [emailField], KEY, "stale@example.com"), null);
});

test("otherwise the surface's own box is the address", () => {
  assert.equal(resolveBuyerEmail({}, [name], KEY, "me@example.com"), "me@example.com");
  assert.equal(resolveBuyerEmail({}, undefined, undefined, "me@example.com"), "me@example.com");
  assert.equal(resolveBuyerEmail({ [ORDER_EMAIL_FIELD_ID]: "x@example.com" }, [emailField], undefined, "me@example.com"), "me@example.com");
});

test("a guest's email field never becomes the delivery address", () => {
  assert.equal(resolveBuyerEmail({ guest: "friend@example.com" }, [guestEmail], KEY, "me@example.com"), "me@example.com");
  assert.equal(resolveBuyerEmail({ guest: "friend@example.com" }, [guestEmail], KEY, ""), null);
});

test("blank or implausible values resolve to null", () => {
  for (const v of ["", "   ", "not-an-address"]) {
    assert.equal(resolveBuyerEmail({ [ORDER_EMAIL_FIELD_ID]: v }, [emailField], KEY, ""), null);
    assert.equal(resolveBuyerEmail({}, [name], KEY, v), null);
  }
});
