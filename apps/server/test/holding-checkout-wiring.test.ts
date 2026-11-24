/**
 * Ticket receipts at create-checkout (routes/stripe.ts): the wiring, read from source
 * as checkout-order-key and marketing-mode-checkout pin theirs. The logic it calls is
 * tested where it lives (holding-store.test.ts, shared holding/request.test.ts).
 *
 * Pinned: a request is read ONLY behind the flag AND a verified session (never a body
 * address); it is parsed against the order's quantity; it is kept under the session
 * Stripe just created, so it is AFTER the create call; and it can never fail the
 * checkout (no return or throw on its path).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/routes/stripe.ts", import.meta.url), "utf8");
const start = src.indexOf("if (FEATURES.holdingReceiptsAllowed && verifiedAddress && rawHolding !== undefined)");
const block = src.slice(start, src.indexOf("\n    }\n", start) + 6);

test("read only behind the flag and a verified session", () => {
  assert.ok(start > 0, "the gated block exists");
  assert.match(block, /recordHoldingRequest\(\{ sessionId: session\.id, eventId, seriesId, account: verifiedAddress, request \}\)/);
  assert.doesNotMatch(block, /claimerAddress|body\./, "never an address from the body");
});

test("parsed against the order's quantity", () => {
  assert.match(block, /parseHoldingRequest\(rawHolding, quantity\)/);
});

test("after Stripe created the session, so it is keyed by that session", () => {
  const create = src.lastIndexOf("session = await createSession();", start);
  assert.ok(create > 0 && create < start);
  assert.ok(src.indexOf("return c.json({ ok: true, url: session.url });", start) > start);
});

test("it can never fail the checkout", () => {
  assert.doesNotMatch(block, /return |throw /);
});
