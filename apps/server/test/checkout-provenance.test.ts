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
// Constructs the SDK client only; every call on it below is mocked.
process.env.STRIPE_SECRET_KEY = "sk_test_checkout_provenance_never_sent";

const {
  signCheckoutTag,
  verifyCheckoutTag,
  classifyPaidSession,
  noteProvenanceVerdict,
  checkoutProvenanceHealth,
  _resetProvenanceCountsForTest,
  FEE_SETTLE_DELAYS_MS,
  UNRESOLVED_ALARM_MS,
} = await import("../src/lib/stripe/checkout-provenance.js");
const { liveProvenanceReads } = await import("../src/lib/stripe/checkout-provenance-live.js");
const { getStripe } = await import("../src/lib/stripe/client.js");
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

type ChargeFee = { requested: boolean; feeId: string | null };
const FEE_READY: ChargeFee = { requested: true, feeId: "fee_1" };
const FEE_PENDING: ChargeFee = { requested: true, feeId: null };
const NO_FEE: ChargeFee = { requested: false, feeId: null };
const NETWORK = () => Object.assign(new Error("network"), { name: "StripeConnectionError" });

/**
 * `charges` is what each successive charge read returns (the last one repeats);
 * an Error entry is thrown. `chargeReads` counts the reads made.
 */
function reads(
  over: Partial<{ charges: Array<ChargeFee | Error>; fee: { amount: number; account: string } | null; throws: boolean }> = {},
): Reads & { chargeReads: number } {
  const o = { charges: [FEE_READY], fee: { amount: 33, account: ACCT }, throws: false, ...over };
  const r = {
    chargeReads: 0,
    async chargeFeeForPaymentIntent() {
      if (o.throws) throw NETWORK();
      const next = o.charges[Math.min(r.chargeReads++, o.charges.length - 1)];
      if (next instanceof Error) throw next;
      return next;
    },
    async retrievePlatformFee() {
      return o.fee;
    },
  };
  return r;
}

/** Records the waits instead of taking them. */
function sleeper() {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => void slept.push(ms) };
}

test("our unaltered session is ours", async () => {
  assert.deepEqual(await classifyPaidSession(session(), ACCT, reads()), { kind: "ours" });
});

test("sessions this platform did not create are foreign - never ours, never refunded", async () => {
  const cases: Array<[string, Promise<{ kind: string }>]> = [
    ["no account on the event", classifyPaidSession(session(), undefined, reads())],
    ["no payment intent", classifyPaidSession(session({ payment_intent: null }), ACCT, reads())],
    ["no application fee on the charge", classifyPaidSession(session(), ACCT, reads({ charges: [NO_FEE] }))],
    ["a fee that is not ours", classifyPaidSession(session(), ACCT, reads({ fee: null }))],
    // An organiser can copy one of our tags into their own session; with no fee
    // of ours on its charge it is still foreign.
    ["a copied tag on an organiser's own session", classifyPaidSession(session(), ACCT, reads({ charges: [NO_FEE] }))],
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

// ── #666: the fee object arrives after checkout.session.completed ────────────
// Stripe creates the ApplicationFee ~2 s after it sends the event, so the first
// read of every one of our sales sees a fee requested but not yet there.

test("#666: a fee Stripe has not created yet is waited for, and the sale is ours", async () => {
  const r = reads({ charges: [FEE_PENDING, FEE_READY] });
  const { slept, sleep } = sleeper();
  assert.deepEqual(await classifyPaidSession(session(), ACCT, r, sleep), { kind: "ours" });
  assert.equal(r.chargeReads, 2);
  assert.deepEqual(slept, [FEE_SETTLE_DELAYS_MS[0]]);
});

test("#666: a requested fee that never appears is unverifiable (Stripe retries), never foreign", async () => {
  const r = reads({ charges: [FEE_PENDING] });
  const { slept, sleep } = sleeper();
  assert.deepEqual(await classifyPaidSession(session(), ACCT, r, sleep), {
    kind: "unverifiable",
    reason: "application fee not created yet",
  });
  assert.equal(r.chargeReads, 1 + FEE_SETTLE_DELAYS_MS.length);
  assert.deepEqual(slept, FEE_SETTLE_DELAYS_MS);
});

test("#666: a charge that requested no fee is foreign at once, with no wait", async () => {
  const r = reads({ charges: [NO_FEE] });
  const { slept, sleep } = sleeper();
  assert.equal((await classifyPaidSession(session(), ACCT, r, sleep)).kind, "foreign");
  assert.equal(r.chargeReads, 1);
  assert.deepEqual(slept, []);
});

test("#666: a fee that arrives and is not ours is still foreign", async () => {
  const { sleep } = sleeper();
  const v = await classifyPaidSession(session(), ACCT, reads({ charges: [FEE_PENDING, FEE_READY], fee: null }), sleep);
  assert.deepEqual(v, { kind: "foreign", reason: "application fee is not this platform's" });
});

test("#666: a fee our key can read is ours even if the charge does not report requesting one", async () => {
  // Not a state Stripe documents; the point is that the proof outranks the hint.
  const r = reads({ charges: [{ requested: false, feeId: "fee_1" }] });
  assert.deepEqual(await classifyPaidSession(session(), ACCT, r, sleeper().sleep), { kind: "ours" });
  assert.equal(r.chargeReads, 1);
});

test("#666: a read failing during the wait decides nothing", async () => {
  const { sleep } = sleeper();
  const v = await classifyPaidSession(session(), ACCT, reads({ charges: [FEE_PENDING, NETWORK()] }), sleep);
  assert.equal(v.kind, "unverifiable");
});

test("#666: the wait fits inside the buyer's redirect window", () => {
  // The buyer's redirect to success_url waits on our 2xx, and Stripe sends it
  // anyway 10 s after payment. The webhook lands ~2.4 s after payment and each
  // charge read takes ~0.2 s, so waits past ~5 s would leave the buyer on
  // Stripe's page with the ticket still undecided.
  assert.ok(FEE_SETTLE_DELAYS_MS.reduce((a, b) => a + b, 0) <= 5000);
});

// ── The live charge read (the one layer the stubs above cannot see) ──────────

test("#666: the live read reports a requested fee before Stripe has created it", async (t) => {
  const calls: unknown[][] = [];
  let latest: unknown = null;
  t.mock.method(getStripe().paymentIntents, "retrieve", async (...args: unknown[]) => {
    calls.push(args);
    return { latest_charge: latest };
  });
  const read = () => liveProvenanceReads.chargeFeeForPaymentIntent("pi_1", ACCT);
  const cases: Array<[string, unknown, ChargeFee]> = [
    ["the charge at checkout.session.completed", { application_fee_amount: 2, application_fee: null }, FEE_PENDING],
    ["the fee attached, as an id", { application_fee_amount: 2, application_fee: "fee_1" }, FEE_READY],
    ["the fee attached, expanded", { application_fee_amount: 2, application_fee: { id: "fee_1" } }, FEE_READY],
    ["no fee requested", { application_fee_amount: null, application_fee: null }, NO_FEE],
    ["a zero fee requested", { application_fee_amount: 0, application_fee: null }, NO_FEE],
    ["no charge", null, NO_FEE],
  ];
  for (const [what, charge, want] of cases) {
    latest = charge;
    assert.deepEqual(await read(), want, what);
  }
  // The charge is read on the event's account, where a direct charge lives.
  assert.deepEqual(calls[0], ["pi_1", { expand: ["latest_charge"] }, { stripeAccount: ACCT }]);
});

test("#666: an unexpanded charge is fetched on the same account", async (t) => {
  t.mock.method(getStripe().paymentIntents, "retrieve", async () => ({ latest_charge: "ch_1" }));
  const chargeCalls: unknown[][] = [];
  t.mock.method(getStripe().charges, "retrieve", async (...args: unknown[]) => {
    chargeCalls.push(args);
    return { application_fee_amount: 2, application_fee: null };
  });
  assert.deepEqual(await liveProvenanceReads.chargeFeeForPaymentIntent("pi_1", ACCT), FEE_PENDING);
  assert.deepEqual(chargeCalls, [["ch_1", {}, { stripeAccount: ACCT }]]);
});

// ── Health ────────────────────────────────────────────────────────────────────

beforeEach(() => _resetProvenanceCountsForTest());

test("health alarms on a tampered session and only counts foreign ones", () => {
  noteProvenanceVerdict("cs_a", { kind: "ours" });
  noteProvenanceVerdict("cs_b", { kind: "foreign", reason: "x" });
  assert.deepEqual(checkoutProvenanceHealth(), {
    ok: true,
    foreign: 1,
    tampered: 0,
    unverifiable: 0,
    unresolved: 0,
    stuck: 0,
  });
  noteProvenanceVerdict("cs_c", { kind: "tampered", reason: "x" });
  assert.equal(checkoutProvenanceHealth().ok, false);
});

test("#666: a session left unverifiable alarms after the seat hold, and a later verdict clears it", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const unverifiable = { kind: "unverifiable", reason: "application fee not created yet" } as const;
  noteProvenanceVerdict("cs_x", unverifiable);
  noteProvenanceVerdict("cs_y", unverifiable);
  noteProvenanceVerdict("cs_z", unverifiable);
  t.mock.timers.tick(UNRESOLVED_ALARM_MS - 1);
  // Stripe's retry lands and fails again: the clock runs from the FIRST failure.
  noteProvenanceVerdict("cs_x", unverifiable);
  // Other sessions settling leave cs_x alone.
  noteProvenanceVerdict("cs_y", { kind: "ours" });
  noteProvenanceVerdict("cs_z", { kind: "foreign", reason: "x" });
  noteProvenanceVerdict("cs_other", { kind: "ours" });
  assert.deepEqual(checkoutProvenanceHealth(), {
    ok: true,
    foreign: 1,
    tampered: 0,
    unverifiable: 4,
    unresolved: 1,
    stuck: 0,
  });
  t.mock.timers.tick(1);
  assert.equal(checkoutProvenanceHealth().ok, false);
  assert.equal(checkoutProvenanceHealth().stuck, 1);
  noteProvenanceVerdict("cs_x", { kind: "ours" });
  const h = checkoutProvenanceHealth();
  assert.equal(h.ok, true);
  assert.equal(h.unresolved, 0);
  assert.equal(h.stuck, 0);
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
  const note = at("noteProvenanceVerdict(session.id, verdict)");
  const retry = at('if (verdict.kind === "unverifiable")');
  const foreign = at('if (verdict.kind === "foreign")');
  const consume = at("checkAndConsumeSession(session.id)");
  const tampered = at('if (verdict.kind === "tampered")');
  const shop = at("handleShopOrderPaid(session)");
  const fulfil = at("fulfilPaidSession(session");
  assert.ok(classify < note && note < retry, "every verdict is noted against its session before any exit");
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
