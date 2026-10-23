/**
 * #799 — every Checkout Session the server creates offers cards and Link only.
 *
 * Fulfilment acts only on a session completed as `paid`; a delayed-notification
 * method would complete it unpaid and the buyer would be charged with no ticket.
 * Link always confirms immediately, so it is the one addition, and a session
 * Stripe refuses over Link is made again with cards alone.
 * The list is a create-time parameter, so the guarantee is that no session is
 * created without it — checked across the whole source tree, so a new route
 * that creates a session cannot skip it.
 *
 * MUTATION: drop the catch in createWithCardOnlyFallback, retry on every error,
 * or create a session with any other list, and a case below goes red.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CARD_ONLY_PAYMENT_METHOD_TYPES,
  CHECKOUT_PAYMENT_METHOD_TYPES,
  createWithCardOnlyFallback,
  type CheckoutPaymentMethodTypes,
} from "../src/lib/stripe/checkout-payment-methods.js";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

/** Each `checkout.sessions.create(` call: its options object, by brace matching, and the text before it. */
function sessionCreateCalls(src: string): Array<{ args: string; before: string }> {
  const out: Array<{ args: string; before: string }> = [];
  let at = src.indexOf("checkout.sessions.create(");
  while (at !== -1) {
    const open = src.indexOf("{", at);
    let depth = 0;
    let end = open;
    for (; end < src.length; end++) {
      if (src[end] === "{") depth++;
      else if (src[end] === "}" && --depth === 0) break;
    }
    out.push({ args: src.slice(open, end + 1), before: src.slice(Math.max(0, at - 120), at) });
    at = src.indexOf("checkout.sessions.create(", end);
  }
  return out;
}

const invalidRequest = () => Object.assign(new Error("payment method type link is invalid"), {
  type: "StripeInvalidRequestError",
  param: "payment_method_types",
});

test("the lists are cards and Link, and cards alone, nothing else", () => {
  assert.deepEqual(CHECKOUT_PAYMENT_METHOD_TYPES, ["card", "link"]);
  assert.deepEqual(CARD_ONLY_PAYMENT_METHOD_TYPES, ["card"]);
});

test("a session is created with Link first, and no fallback when Stripe accepts it", async () => {
  const seen: CheckoutPaymentMethodTypes[] = [];
  let fellBack = false;
  const out = await createWithCardOnlyFallback(async (types) => {
    seen.push(types);
    return "session";
  }, () => { fellBack = true; });
  assert.equal(out, "session");
  assert.deepEqual(seen, [["card", "link"]]);
  assert.equal(fellBack, false);
});

test("a refused session is made again with cards alone, and the refusal is reported", async () => {
  const seen: CheckoutPaymentMethodTypes[] = [];
  const reported: unknown[] = [];
  const out = await createWithCardOnlyFallback(async (types) => {
    seen.push(types);
    if (types.length === 2) throw invalidRequest();
    return "card-session";
  }, (err) => reported.push(err));
  assert.equal(out, "card-session");
  assert.deepEqual(seen, [["card", "link"], ["card"]]);
  assert.equal(reported.length, 1);
});

test("any other failure is thrown as before, never retried", async () => {
  let calls = 0;
  const timeout = Object.assign(new Error("socket hang up"), { type: "StripeConnectionError" });
  await assert.rejects(
    createWithCardOnlyFallback(async () => { calls++; throw timeout; }, () => {}),
    (err) => err === timeout,
  );
  assert.equal(calls, 1);
});

test("a refusal that is not about Link fails on cards too, and that error is thrown", async () => {
  let calls = 0;
  const second = invalidRequest();
  await assert.rejects(
    createWithCardOnlyFallback(async () => { calls++; throw calls === 1 ? invalidRequest() : second; }, () => {}),
    (err) => err === second,
  );
  assert.equal(calls, 2);
});

test("every Checkout Session created in the server pins the payment methods", () => {
  const calls = sourceFiles(SRC).flatMap((file) =>
    sessionCreateCalls(readFileSync(file, "utf8")).map((call) => ({ file, ...call })),
  );
  // The ticket checkout and the shop checkout. A third is fine, but it must pin too.
  assert.ok(calls.length >= 2, `found ${calls.length} session creations; the scan is not seeing the routes`);
  for (const { file, args, before } of calls) {
    const pinned = /payment_method_types:\s*(CHECKOUT_PAYMENT_METHOD_TYPES|CARD_ONLY_PAYMENT_METHOD_TYPES)\b/.test(args);
    // The fallback's own list, which can only be one of the two constants.
    const viaFallback = /payment_method_types\s*,/.test(args)
      && /createWithCardOnlyFallback\(\s*\(payment_method_types\)\s*=>\s*\w+\.$/.test(before);
    assert.ok(pinned || viaFallback, `${file.slice(SRC.length)} creates a Checkout Session without a pinned payment-method list`);
  }
});

test("the ticket checkout goes through the fallback", () => {
  const src = readFileSync(join(SRC, "routes/stripe.ts"), "utf8");
  assert.match(src, /createWithCardOnlyFallback\(\s*\(payment_method_types\)\s*=>\s*s\.checkout\.sessions\.create\(/);
});
