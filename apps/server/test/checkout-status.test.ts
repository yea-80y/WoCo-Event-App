/**
 * The checkout-status answer (#567), pinned. The session id behind it arrives
 * from page URLs on hosts WoCo does not control, so the view must stay exactly
 * four fields and must never carry anything from the session metadata beyond
 * them — the deep-equal below fails on any added field.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { checkoutStatusView, isCheckoutSessionId, maskEmail } from "../src/lib/stripe/checkout-status.js";

const EV = "83d23fab-16f7-42d6-922f-57eb95f437cf";

const metadata = (over: Record<string, string> = {}) => ({
  eventId: EV,
  seriesId: "s1",
  quantity: "2",
  claimerEmail: "nabil@example.com",
  claimerAddress: "0xabc0000000000000000000000000000000000001",
  orderRef: "f".repeat(64),
  reservationId: "rsv-1",
  connectedAccountId: "acct_123",
  onChainEventId: "0x4621",
  ...over,
});

test("a paid session is exactly status, quantity, series and a masked email", () => {
  const view = checkoutStatusView({ status: "complete", payment_status: "paid", metadata: metadata() }, EV);
  assert.deepEqual(view, { status: "paid", quantity: 2, seriesId: "s1", emailMasked: "n***@example.com" });
});

test("nothing else in the session metadata reaches the answer", () => {
  const text = JSON.stringify(checkoutStatusView({ status: "complete", payment_status: "paid", metadata: metadata() }, EV));
  for (const leaked of ["nabil@", "0xabc", "acct_", "rsv-1", "ffff", "0x4621"]) {
    assert.ok(!text.includes(leaked), `leaked ${leaked}`);
  }
});

test("a session from another event is not answered", () => {
  assert.equal(checkoutStatusView({ status: "complete", payment_status: "paid", metadata: metadata({ eventId: "other" }) }, EV), null);
  assert.equal(checkoutStatusView({ status: "complete", payment_status: "paid", metadata: null }, EV), null);
});

test("only a complete, paid session reads as paid", () => {
  const status = (s: string, p: string) => checkoutStatusView({ status: s, payment_status: p, metadata: metadata() }, EV)?.status;
  assert.equal(status("expired", "unpaid"), "expired");
  assert.equal(status("open", "unpaid"), "open");
  assert.equal(status("complete", "unpaid"), "open");
});

test("an unreadable quantity reads as one ticket", () => {
  assert.equal(checkoutStatusView({ status: "complete", payment_status: "paid", metadata: metadata({ quantity: "x" }) }, EV)?.quantity, 1);
});

test("an email is masked to its first character and full domain", () => {
  assert.equal(maskEmail("a@b.co"), "a***@b.co");
  assert.equal(maskEmail("  Nabil@Example.com "), "N***@Example.com");
  assert.equal(maskEmail("no-at-sign"), null);
  assert.equal(maskEmail("@example.com"), null);
  assert.equal(maskEmail("nabil@"), null);
  assert.equal(maskEmail(undefined), null);
});

test("only a Stripe checkout session id is accepted", () => {
  assert.equal(isCheckoutSessionId("cs_test_a1B2c3D4e5F6g7H8"), true);
  assert.equal(isCheckoutSessionId("cs_live_a1B2c3D4e5F6g7H8"), true);
  assert.equal(isCheckoutSessionId("pi_3NxYz"), false);
  assert.equal(isCheckoutSessionId("cs_test_"), false);
  assert.equal(isCheckoutSessionId("cs_test_a1B2c3D4e5&x=1"), false);
  assert.equal(isCheckoutSessionId(undefined), false);
});
