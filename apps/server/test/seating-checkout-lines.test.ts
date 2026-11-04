/**
 * Allocated seating S4: the seated card checkout's lines (lib/seating/seated-checkout.ts).
 * Prices come from the hold and must still be the feed's; one Stripe line per band, the
 * cover fee one order line, and the lines add up to exactly what the hold's view showed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { cardOrderAmountsMulti, COVER_FEE_RATES } from "@woco/shared";
import {
  openSeatedSession, PRICES_CHANGED, seatedCheckoutLines, seatedCheckoutRefusal, seatedPriceRefusal,
} from "../src/lib/seating/seated-checkout.js";
import type { Reservation } from "../src/lib/event/reservation-store.js";

const PIN = { planDigest: "0x" + "5f".repeat(32) };
const FEED = { bands: [{ id: "a", price: "28.00" }, { id: "b", price: "22.00" }] };
const later = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
function heldHold(over: Partial<Reservation> = {}): Reservation {
  return {
    id: "h1", eventId: "e", seriesId: "s", quantity: 3, createdAt: later(-1), expiresAt: later(9),
    seats: [1, 2, 3], planDigest: PIN.planDigest,
    seatInfo: [
      { band: "a", bandName: "Stalls", label: "A1", priceMinor: 2800 },
      { band: "b", bandName: "Circle", label: "B1", priceMinor: 2200 },
      { band: "a", bandName: "Stalls", label: "A3", priceMinor: 2800 },
    ],
    ...over,
  };
}
const gate = (held: Reservation | null, over: Record<string, unknown> = {}) =>
  seatedCheckoutRefusal({ held, pin: PIN, contractVersion: "ledger2", persisting: true, feedSeating: FEED, ...over });

test("checkout sells only a seated hold on the pin, on ledger2, under its cap, at its prices", () => {
  assert.equal(gate(heldHold()), null);
  for (const [why, r] of [
    ["no hold", gate(null)],
    ["a count hold", gate(heldHold({ seats: undefined }))],
    ["no pinned prices", gate(heldHold({ seatInfo: undefined }))],
    ["another plan", gate(heldHold({ planDigest: "0x" + "00".repeat(32) }))],
    ["not ledger2", gate(heldHold(), { contractVersion: "ledger" })],
  ] as const) assert.equal(r?.body.code, "SEATS_REQUIRED", why);
  assert.equal(gate(heldHold(), { persisting: false })?.status, 503);
  assert.equal(gate(heldHold({ checkout: { sessionId: "cs_3", account: "acct_1", expiresAt: later(20), sessions: 3 } }))?.body.code, "HOLD_AGAIN");
  assert.equal(gate(heldHold(), { feedSeating: { bands: [{ id: "a", price: "30.00" }, { id: "b", price: "22.00" }] } })?.body.code, "PRICES_CHANGED");
});

function sessionDeps(expireAnswer: "expired" | "complete" | "error" = "expired", binds = true) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      expire: async (c: { sessionId: string }) => { calls.push(`expire:${c.sessionId}`); return expireAnswer; },
      bind: ((id: string, prev: string | null, s: { sessionId: string }) => { calls.push(`bind:${id}:${prev}:${s.sessionId}`); return binds; }) as never,
    },
  };
}
const created = async () => ({ id: "cs_new", expires_at: Math.floor(Date.now() / 1000) + 1920 });

test("a hold's open session is closed before a new one opens; the new one is bound to it", async () => {
  const open = heldHold({ checkout: { sessionId: "cs_old", account: "acct_1", expiresAt: later(20), sessions: 1 } });
  const d = sessionDeps();
  const r = await openSeatedSession(open, "acct_1", 0, created, d.deps);
  assert.ok(r.ok);
  assert.deepEqual(d.calls, ["expire:cs_old", "bind:h1:cs_old:cs_new"]);
  const first = sessionDeps();
  assert.ok((await openSeatedSession(heldHold(), "acct_1", 0, created, first.deps)).ok);
  assert.deepEqual(first.calls, ["bind:h1:null:cs_new"], "no session yet: nothing to close");
});

test("the old session was paid: no second session; Stripe unreachable: none either", async () => {
  const open = heldHold({ checkout: { sessionId: "cs_old", account: "acct_1", expiresAt: later(20), sessions: 1 } });
  let made = 0;
  const make = async () => { made++; return created(); };
  const paid = await openSeatedSession(open, "acct_1", 0, make, sessionDeps("complete").deps);
  assert.ok(!paid.ok);
  assert.equal(paid.body.code, "HOLD_PAID");
  const down = await openSeatedSession(open, "acct_1", 0, make, sessionDeps("error").deps);
  assert.ok(!down.ok);
  assert.equal(down.status, 503);
  assert.equal(made, 0);
});

test("a hold that ran out before the bind: the new session is closed at once, never left payable", async () => {
  const d = sessionDeps("expired", false);
  const r = await openSeatedSession(heldHold(), "acct_1", 0, created, d.deps);
  assert.ok(!r.ok);
  assert.equal(r.status, 410);
  assert.deepEqual(d.calls, ["bind:h1:null:cs_new", "expire:cs_new"]);
});

const seat = (band: string, priceMinor: number, k: number) => ({ band, bandName: band === "a" ? "Stalls" : "Circle", label: `Row A, seat ${k}`, priceMinor });
const info = [seat("a", 2800, 1), seat("b", 2200, 2), seat("a", 2800, 3)];

test("pinned prices must still be the feed's", () => {
  const feed = { bands: [{ id: "a", price: "28.00" }, { id: "b", price: "22.00" }] };
  assert.equal(seatedPriceRefusal(info, feed), null);
  assert.equal(seatedPriceRefusal(info, { bands: [{ id: "a", price: "30.00" }, { id: "b", price: "22.00" }] }), PRICES_CHANGED);
  assert.equal(seatedPriceRefusal(info, { bands: [{ id: "a", price: "28.00" }] }), PRICES_CHANGED, "a band gone");
  for (const bad of [undefined, null, {}, { bands: "x" }, { bands: [null] }]) assert.equal(seatedPriceRefusal(info, bad), PRICES_CHANGED);
});

test("one line per band in first-seen order; the lines sum to the multi-price total", () => {
  for (const payment of [{}, { feePassedToCustomer: true, buyerFeePercent: 10 }, { feePassedToCustomer: true, coverFees: COVER_FEE_RATES }]) {
    const { amounts, lineItems } = seatedCheckoutLines(info, payment, "gbp", { series: "Seats", event: "Gig" });
    assert.deepEqual(amounts, cardOrderAmountsMulti(payment, [2800, 2200, 2800]));
    const sum = lineItems.reduce((s, l) => s + (l.price_data!.unit_amount as number) * (l.quantity as number), 0);
    assert.equal(sum, amounts.totalMinor, JSON.stringify(payment));
    assert.equal(lineItems[0].quantity, 2);
    assert.equal(lineItems[0].price_data!.product_data!.name, "Stalls — Seats — Gig");
    assert.equal(lineItems[0].price_data!.product_data!.description, "Row A, seat 1; Row A, seat 3");
    assert.equal(lineItems[1].quantity, 1);
    assert.equal(lineItems.length, amounts.orderFeeMinor > 0 ? 3 : 2);
  }
});
