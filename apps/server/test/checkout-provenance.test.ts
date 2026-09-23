/**
 * #645: fulfilment acts only on a Checkout Session we created, unaltered.
 *
 * Under a full Stripe Dashboard an organiser can create sessions and edit
 * metadata on their own account, and the connected-accounts webhook delivers
 * all of them. Each case below is one way a session could be acted on that
 * should not be, or refused that should not be.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.PAYMENT_QUOTE_SECRET = "test-secret-checkout-provenance-0123456789abcdef";

const {
  signCheckoutTag,
  verifyCheckoutTag,
  classifyPaidSession,
  noteProvenanceVerdict,
  checkoutProvenanceHealth,
  _resetProvenanceCountsForTest,
} = await import("../src/lib/stripe/checkout-provenance.js");
type Fields = Parameters<typeof signCheckoutTag>[0];
type Reads = Parameters<typeof classifyPaidSession>[2];

const ACCT = "acct_organiser_1";
const FIELDS: Fields = {
  account: ACCT,
  currency: "gbp",
  amountSubtotal: 2200,
  amountTotal: 2200,
  applicationFee: 33,
  metadata: { eventId: "ev1", seriesId: "s1", quantity: "2", claimerEmail: "a@b.co", connectedAccountId: ACCT },
};

// ── The tag ───────────────────────────────────────────────────────────────────

test("a tag verifies for exactly the fields it was made over", () => {
  const tag = signCheckoutTag(FIELDS);
  assert.ok(tag.startsWith("woco1."));
  assert.equal(verifyCheckoutTag(tag, FIELDS), true);
  // Metadata key order and currency case do not matter.
  const reordered = { ...FIELDS, currency: "GBP", metadata: Object.fromEntries(Object.entries(FIELDS.metadata).reverse()) };
  assert.equal(verifyCheckoutTag(tag, reordered), true);
});

test("changing any bound field breaks the tag", () => {
  const tag = signCheckoutTag(FIELDS);
  const changes: Array<[string, Fields]> = [
    ["account", { ...FIELDS, account: "acct_other" }],
    ["currency", { ...FIELDS, currency: "eur" }],
    ["subtotal", { ...FIELDS, amountSubtotal: 1 }],
    ["total", { ...FIELDS, amountTotal: 1 }],
    ["fee", { ...FIELDS, applicationFee: 0 }],
    ["metadata value", { ...FIELDS, metadata: { ...FIELDS.metadata, quantity: "5" } }],
    ["metadata added", { ...FIELDS, metadata: { ...FIELDS.metadata, extra: "x" } }],
    ["metadata removed", { ...FIELDS, metadata: { eventId: "ev1" } }],
  ];
  for (const [what, f] of changes) assert.equal(verifyCheckoutTag(tag, f), false, `${what} change must fail`);
});

test("an empty metadata value tags the same as an absent key", () => {
  // Stripe documents "" as the way to remove a key, so a wallet buyer's empty
  // claimerEmail may not come back; the sale must still verify.
  const withEmpty = { ...FIELDS, metadata: { ...FIELDS.metadata, claimerAddress: "", onChainEventId: "" } };
  const tag = signCheckoutTag(withEmpty);
  assert.equal(verifyCheckoutTag(tag, FIELDS), true);
  assert.equal(verifyCheckoutTag(tag, withEmpty), true);
  // A non-empty value is still bound.
  assert.equal(verifyCheckoutTag(tag, { ...FIELDS, metadata: { ...FIELDS.metadata, claimerAddress: "0xabc" } }), false);
});

test("missing or foreign-shaped tags do not verify", () => {
  for (const t of [null, undefined, "", "abc", "woco1.", "woco2." + "0".repeat(64)]) {
    assert.equal(verifyCheckoutTag(t as string, FIELDS), false);
  }
});

// ── The classification ────────────────────────────────────────────────────────

function session(over: Partial<Parameters<typeof classifyPaidSession>[0]> = {}) {
  return {
    id: "cs_1",
    client_reference_id: signCheckoutTag(FIELDS),
    metadata: FIELDS.metadata,
    currency: "gbp",
    amount_subtotal: 2200,
    amount_total: 2200,
    payment_intent: "pi_1",
    ...over,
  };
}

function reads(over: Partial<{ feeId: string | null; fee: { amount: number; account: string } | null; throws: boolean }> = {}): Reads {
  const o = { feeId: "fee_1", fee: { amount: 33, account: ACCT }, throws: false, ...over };
  return {
    async applicationFeeIdForPaymentIntent() {
      if (o.throws) throw Object.assign(new Error("network"), { name: "StripeConnectionError" });
      return o.feeId;
    },
    async retrievePlatformFee() {
      return o.fee;
    },
  };
}

test("our unaltered session is ours", async () => {
  assert.deepEqual(await classifyPaidSession(session(), ACCT, reads()), { kind: "ours" });
});

test("sessions this platform did not create are foreign - never ours, never refunded", async () => {
  const cases: Array<[string, Promise<{ kind: string }>]> = [
    ["no account on the event", classifyPaidSession(session(), undefined, reads())],
    ["no payment intent", classifyPaidSession(session({ payment_intent: null }), ACCT, reads())],
    ["no application fee on the charge", classifyPaidSession(session(), ACCT, reads({ feeId: null }))],
    ["a fee that is not ours", classifyPaidSession(session(), ACCT, reads({ fee: null }))],
    // An organiser can copy one of our tags into their own session; with no fee
    // of ours on its charge it is still foreign.
    ["a copied tag on an organiser's own session", classifyPaidSession(session(), ACCT, reads({ feeId: null }))],
  ];
  for (const [what, p] of cases) assert.equal((await p).kind, "foreign", what);
});

test("a session we created but that was altered after is tampered", async () => {
  const cases: Array<[string, Promise<{ kind: string }>]> = [
    ["tag missing", classifyPaidSession(session({ client_reference_id: null }), ACCT, reads())],
    ["metadata edited", classifyPaidSession(session({ metadata: { ...FIELDS.metadata, quantity: "9" } }), ACCT, reads())],
    ["price lowered", classifyPaidSession(session({ amount_total: 1, amount_subtotal: 1 }), ACCT, reads())],
    ["our fee differs from the tagged fee", classifyPaidSession(session(), ACCT, reads({ fee: { amount: 1, account: ACCT } }))],
    ["our fee on another account", classifyPaidSession(session(), ACCT, reads({ fee: { amount: 33, account: "acct_x" } }))],
    ["event from another account than the tag names", classifyPaidSession(session(), "acct_x", reads({ fee: { amount: 33, account: "acct_x" } }))],
  ];
  for (const [what, p] of cases) assert.equal((await p).kind, "tampered", what);
});

test("a Stripe read that fails decides nothing", async () => {
  assert.equal((await classifyPaidSession(session(), ACCT, reads({ throws: true }))).kind, "unverifiable");
});

// ── Health ────────────────────────────────────────────────────────────────────

beforeEach(() => _resetProvenanceCountsForTest());

test("health alarms on a tampered session and only counts foreign ones", () => {
  noteProvenanceVerdict({ kind: "ours" });
  noteProvenanceVerdict({ kind: "foreign", reason: "x" });
  assert.deepEqual(checkoutProvenanceHealth(), { ok: true, foreign: 1, tampered: 0, unverifiable: 0 });
  noteProvenanceVerdict({ kind: "tampered", reason: "x" });
  assert.equal(checkoutProvenanceHealth().ok, false);
});

// ── Wiring (text checks: the route needs Stripe signatures and a live account) ─

test("the webhook classifies before it consumes, and acts on nothing it did not verify", () => {
  const src = readFileSync(new URL("../src/routes/stripe.ts", import.meta.url), "utf-8");
  const c = src.slice(src.indexOf('case "checkout.session.completed"'));
  const at = (needle: string) => {
    const i = c.indexOf(needle);
    assert.ok(i >= 0, `webhook is missing ${needle}`);
    return i;
  };
  const classify = at("await classifyPaidSession(session, event.account");
  const retry = at('if (verdict.kind === "unverifiable")');
  const foreign = at('if (verdict.kind === "foreign")');
  const consume = at("checkAndConsumeSession(session.id)");
  const tampered = at('if (verdict.kind === "tampered")');
  const shop = at("handleShopOrderPaid(session)");
  const fulfil = at("fulfilPaidSession(session");
  assert.ok(classify < retry && retry < consume, "an unverifiable session is never consumed");
  assert.ok(foreign < consume, "a foreign session is never consumed");
  assert.ok(consume < tampered && tampered < shop && shop < fulfil, "shop and ticket flows run only for verified sessions");
});

test("both checkout routes tag the sessions they create", () => {
  for (const rel of ["../src/routes/stripe.ts", "../src/routes/shops.ts"]) {
    const src = readFileSync(new URL(rel, import.meta.url), "utf-8");
    assert.match(src, /client_reference_id: clientReferenceId/, `${rel} must set the integrity tag`);
    assert.match(src, /signCheckoutTag\(\{/, `${rel} must sign it`);
  }
});

test("create-checkout never returns an error's own text to the buyer", () => {
  const src = readFileSync(new URL("../src/routes/stripe.ts", import.meta.url), "utf-8");
  const c = src.slice(src.indexOf("Failed to create checkout session:"));
  const tail = c.slice(0, c.indexOf("});"));
  assert.doesNotMatch(tail, /err\.message/, "the catch must return a fixed string");
});
