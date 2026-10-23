/**
 * #799 — every Checkout Session the server creates offers cards and Link only.
 *
 * Fulfilment acts only on a session completed as `paid`; a delayed-notification
 * method would complete it unpaid and the buyer would be charged with no ticket.
 * Link always confirms immediately, so it is the one addition.
 * The list is a create-time parameter, so the guarantee is that no session is
 * created without it — checked across the whole source tree, so a new route
 * that creates a session cannot skip it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHECKOUT_PAYMENT_METHOD_TYPES } from "../src/lib/stripe/checkout-payment-methods.js";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

/** The options object passed to each `checkout.sessions.create(` call, by brace matching. */
function sessionCreateArgs(src: string): string[] {
  const out: string[] = [];
  let at = src.indexOf("checkout.sessions.create(");
  while (at !== -1) {
    const open = src.indexOf("{", at);
    let depth = 0;
    let end = open;
    for (; end < src.length; end++) {
      if (src[end] === "{") depth++;
      else if (src[end] === "}" && --depth === 0) break;
    }
    out.push(src.slice(open, end + 1));
    at = src.indexOf("checkout.sessions.create(", end);
  }
  return out;
}

test("the list is cards and Link, nothing else", () => {
  assert.deepEqual(CHECKOUT_PAYMENT_METHOD_TYPES, ["card", "link"]);
});

test("every Checkout Session created in the server pins the payment methods", () => {
  const calls = sourceFiles(SRC).flatMap((file) =>
    sessionCreateArgs(readFileSync(file, "utf8")).map((args) => ({ file, args })),
  );
  // The ticket checkout and the shop checkout. A third is fine, but it must pin too.
  assert.ok(calls.length >= 2, `found ${calls.length} session creations; the scan is not seeing the routes`);
  for (const { file, args } of calls) {
    assert.match(
      args,
      /payment_method_types:\s*CHECKOUT_PAYMENT_METHOD_TYPES\b/,
      `${file.slice(SRC.length)} creates a Checkout Session without CHECKOUT_PAYMENT_METHOD_TYPES`,
    );
  }
});
