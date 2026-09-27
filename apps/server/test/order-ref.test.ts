/**
 * Checkout takes only order refs this server stored, as canonical bytes (#661).
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.PAYMENT_QUOTE_SECRET = "5".repeat(64);
const {
  canonicalOrderBox,
  issueOrderRefToken,
  verifyOrderRefToken,
  acceptedClientOrderRef,
  ORDER_REF_TOKEN_TTL_MS,
} = await import("../src/lib/stripe/order-ref.js");

const BOX = { v: 2, enc: "ab".repeat(1120), ct: "cd".repeat(64) };
const REF = "12".repeat(32);
const NOW = 1_800_000_000_000;

test("a box rearranged in any key order stores as the SAME bytes as its original", () => {
  const canonical = canonicalOrderBox(BOX);
  assert.equal(canonical, JSON.stringify({ v: 2, enc: BOX.enc, ct: BOX.ct }));
  assert.equal(canonicalOrderBox({ ct: BOX.ct, v: 2, enc: BOX.enc }), canonical);
  assert.equal(canonicalOrderBox({ enc: BOX.enc, ct: BOX.ct, v: 2 }), canonical);
});

test("only a strict v2 box within the cap has a canonical form", () => {
  for (const bad of [{ ...BOX, extra: 1 }, { ...BOX, v: 1 }, { ...BOX, ct: "cd".repeat(9000) }, null, "x"]) {
    assert.equal(canonicalOrderBox(bad), null);
  }
});

test("a token verifies only for its own ref, only in date, and cannot be forged", () => {
  const token = issueOrderRefToken(REF, NOW);
  assert.equal(verifyOrderRefToken(REF, token, NOW), true);
  assert.equal(verifyOrderRefToken(REF.toUpperCase(), token, NOW), true);
  assert.equal(verifyOrderRefToken("34".repeat(32), token, NOW), false, "another ref");
  assert.equal(verifyOrderRefToken(REF, token, NOW + ORDER_REF_TOKEN_TTL_MS + 1000), false, "expired");
  const [p, issued, mac] = token.split(".");
  assert.equal(verifyOrderRefToken(REF, `${p}.${Number(issued) + 1}.${mac}`, NOW), false, "moved issued-at");
  assert.equal(verifyOrderRefToken(REF, `${p}.${issued}.${"0".repeat(64)}`, NOW), false, "forged mac");
  for (const junk of [undefined, 42, "", "ort1..", "ort2." + issued + "." + mac]) {
    assert.equal(verifyOrderRefToken(REF, junk, NOW), false);
  }
});

test("checkout takes a client ref only with its token — a copied on-chain ref has none", () => {
  const token = issueOrderRefToken(REF, NOW);
  assert.equal(acceptedClientOrderRef(REF, token, NOW), REF);
  assert.equal(acceptedClientOrderRef(REF, undefined, NOW), undefined);
  assert.equal(acceptedClientOrderRef("34".repeat(32), token, NOW), undefined);
  assert.equal(acceptedClientOrderRef("not-hex", token, NOW), undefined);
});

test("both routes enforce it: prepare-order refuses a taken ref, checkout takes refs only with a token and refuses a taken one before charging", async () => {
  // The routes need a live upload to reach these lines, so they are pinned at
  // the source; the pieces they call are tested above and in ticket-sales.test.ts.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/routes/stripe.ts", import.meta.url), "utf8");
  const prepare = src.slice(src.indexOf('stripe.post("/prepare-order"'));
  assert.match(prepare.slice(0, 2000), /orderRefInOtherSale\(orderRef, null\)\) return c\.json\(\{ ok: false, error: ORDER_ALREADY_USED \}, 409\)/);
  assert.match(prepare.slice(0, 2000), /orderRefToken: issueOrderRefToken\(orderRef\)/);
  assert.match(src, /const preUploadedRef = acceptedClientOrderRef\(orderRef, orderRefToken\);/);
  const refusal = src.indexOf("if (finalOrderRef && orderRefInOtherSale(finalOrderRef, null))");
  const session = src.indexOf("checkout.sessions.create(");
  assert.ok(session > 0, "the Stripe session call must be found, or this check guards nothing");
  assert.ok(refusal > 0 && refusal < session, "refused before any Stripe session exists");
});

test("checkout refuses an event it could never record an order for, before charging (#642 F3)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/routes/stripe.ts", import.meta.url), "utf8");
  const refusal = src.indexOf("if (!finalOrderRef && !event.encryptionKeyRef)");
  const session = src.indexOf("checkout.sessions.create(");
  assert.ok(refusal > 0 && session > 0 && refusal < session);
});
