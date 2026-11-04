/**
 * Allocated seating S4: the seated card checkout's lines (lib/seating/seated-checkout.ts).
 * Prices come from the hold and must still be the feed's; one Stripe line per band, the
 * cover fee one order line, and the lines add up to exactly what the hold's view showed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { cardOrderAmountsMulti, COVER_FEE_RATES } from "@woco/shared";
import { isSeatHoldLost, SEAT_HOLD_LOST_CODES } from "@woco/shared/seating/reserve";
import {
  holdFeeKey, openSeatedSession, PRICES_CHANGED, seatedCheckoutLines, seatedCheckoutRefusal, seatedPriceRefusal,
} from "../src/lib/seating/seated-checkout.js";
import type { Reservation } from "../src/lib/event/reservation-store.js";

const PIN = { planDigest: "0x" + "5f".repeat(32) };
const FEED = { bands: [{ id: "a", price: "28.00" }, { id: "b", price: "22.00" }] };
const PAY = { currency: "GBP", feePassedToCustomer: true, buyerFeePercent: 10 } as const;
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
    feeKey: holdFeeKey(PAY),
    ...over,
  };
}
const gate = (held: Reservation | null, over: Record<string, unknown> = {}) =>
  seatedCheckoutRefusal({ held, pin: PIN, contractVersion: "ledger2", persisting: true, feedSeating: FEED, feedPayment: PAY, ...over });

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
  assert.equal(gate(heldHold(), { feedPayment: { ...PAY, buyerFeePercent: 12 } })?.body.code, "PRICES_CHANGED", "the fee changed");
});

test("every refusal that ends a hold's use is one the pages treat as 'hold again'", async () => {
  const codes = [
    gate(null)?.body.code,
    gate(heldHold({ checkout: { sessionId: "cs_3", account: "acct_1", expiresAt: later(20), sessions: 3 } }))?.body.code,
    gate(heldHold(), { feedPayment: { ...PAY, currency: "EUR" } })?.body.code,
    (await openSeatedSession("h1", "acct_1", 0, created, sessionDeps("expired", false).deps) as { body: { code?: string } }).body.code,
  ];
  for (const c of codes) assert.ok(isSeatHoldLost(c), String(c));
  assert.equal(isSeatHoldLost("HOLD_PAID"), false, "paid: nothing to hold again");
  assert.deepEqual([...SEAT_HOLD_LOST_CODES].sort(), [...new Set(codes)].sort() as string[]);
});

function sessionDeps(expireAnswer: "expired" | "complete" | "error" = "expired", binds = true, hold: Reservation | null = heldHold()) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      get: (id: string) => { calls.push(`get:${id}`); return hold; },
      expire: async (c: { sessionId: string }) => { calls.push(`expire:${c.sessionId}`); return expireAnswer; },
      markClosed: (id: string, sessionId: string) => { calls.push(`closed:${id}:${sessionId}`); },
      bind: ((id: string, prev: string | null, s: { sessionId: string }) => { calls.push(`bind:${id}:${prev}:${s.sessionId}`); return binds; }) as never,
    },
  };
}
const created = async () => ({ id: "cs_new", expires_at: Math.floor(Date.now() / 1000) + 1920 });
const withSession = () => heldHold({ checkout: { sessionId: "cs_old", account: "acct_1", expiresAt: later(20), sessions: 1 } });

test("a hold's open session is closed (and marked ours) before a new one opens; the new one is bound to it", async () => {
  const d = sessionDeps("expired", true, withSession());
  const r = await openSeatedSession("h1", "acct_1", 0, created, d.deps);
  assert.ok(r.ok);
  assert.deepEqual(d.calls, ["get:h1", "expire:cs_old", "closed:h1:cs_old", "bind:h1:cs_old:cs_new"]);
  const first = sessionDeps();
  assert.ok((await openSeatedSession("h1", "acct_1", 0, created, first.deps)).ok);
  assert.deepEqual(first.calls, ["get:h1", "bind:h1:null:cs_new"], "no session yet: nothing to close");
});

test("the session another tab bound since the route's read is the one closed (the hold is read afresh)", async () => {
  // The route read the hold with no session; by now a sibling tab bound cs_old.
  const d = sessionDeps("expired", true, withSession());
  assert.ok((await openSeatedSession("h1", "acct_1", 0, created, d.deps)).ok);
  assert.ok(d.calls.includes("bind:h1:cs_old:cs_new"));
  const gone = await openSeatedSession("h1", "acct_1", 0, created, sessionDeps("expired", true, null).deps);
  assert.ok(!gone.ok);
  assert.equal(gone.body.code, "HOLD_EXPIRED");
});

test("the old session was paid: no second session; Stripe unreachable: none either", async () => {
  let made = 0;
  const make = async () => { made++; return created(); };
  const paidDeps = sessionDeps("complete", true, withSession());
  const paid = await openSeatedSession("h1", "acct_1", 0, make, paidDeps.deps);
  assert.ok(!paid.ok);
  assert.equal(paid.body.code, "HOLD_PAID");
  assert.ok(!paidDeps.calls.some((c) => c.startsWith("closed:")), "a paid session is not marked closed");
  const down = await openSeatedSession("h1", "acct_1", 0, make, sessionDeps("error", true, withSession()).deps);
  assert.ok(!down.ok);
  assert.equal(down.status, 503);
  assert.equal(made, 0);
});

test("a hold that ran out before the bind: the new session is closed at once, never left payable", async () => {
  const d = sessionDeps("expired", false);
  const r = await openSeatedSession("h1", "acct_1", 0, created, d.deps);
  assert.ok(!r.ok);
  assert.equal(r.status, 410);
  assert.deepEqual(d.calls, ["get:h1", "bind:h1:null:cs_new", "expire:cs_new"]);
});

const seat = (band: string, priceMinor: number, k: number) => ({ band, bandName: band === "a" ? "Stalls" : "Circle", label: `Row A, seat ${k}`, priceMinor });
const info = [seat("a", 2800, 1), seat("b", 2200, 2), seat("a", 2800, 3)];

test("pinned prices and fee settings must still be the feed's", () => {
  const feed = { bands: [{ id: "a", price: "28.00" }, { id: "b", price: "22.00" }] };
  const h = { seatInfo: info, feeKey: holdFeeKey(PAY) };
  assert.equal(seatedPriceRefusal(h, feed, PAY), null);
  assert.equal(seatedPriceRefusal(h, { bands: [{ id: "a", price: "30.00" }, { id: "b", price: "22.00" }] }, PAY), PRICES_CHANGED);
  assert.equal(seatedPriceRefusal(h, { bands: [{ id: "a", price: "28.00" }] }, PAY), PRICES_CHANGED, "a band gone");
  for (const bad of [undefined, null, {}, { bands: "x" }, { bands: [null] }]) assert.equal(seatedPriceRefusal(h, bad, PAY), PRICES_CHANGED);
  // Anything else the amounts depend on: the fee mode, its rate, cover rates, currency.
  for (const other of [
    { ...PAY, feePassedToCustomer: false }, { ...PAY, buyerFeePercent: 12 }, { ...PAY, currency: "EUR" },
    { currency: "GBP", feePassedToCustomer: true, coverFees: COVER_FEE_RATES },
  ]) assert.equal(seatedPriceRefusal(h, feed, other as never), PRICES_CHANGED, JSON.stringify(other));
  // An edit that changes no figure changes no key: a percent under the floor still prices at
  // the floor; cover rates count only in cover mode.
  const under = { currency: "GBP", feePassedToCustomer: true, buyerFeePercent: 1 };
  assert.equal(holdFeeKey(under), holdFeeKey({ ...under, buyerFeePercent: 2 }));
  const none = { currency: "GBP", feePassedToCustomer: false };
  assert.equal(holdFeeKey(none), holdFeeKey({ ...none, coverFees: COVER_FEE_RATES, buyerFeePercent: 12 }));
  assert.notEqual(holdFeeKey(none), holdFeeKey(PAY));
  assert.equal(seatedPriceRefusal({ seatInfo: info }, feed, PAY), PRICES_CHANGED, "no fee key pinned");
  assert.equal(seatedPriceRefusal({ feeKey: h.feeKey }, feed, PAY), PRICES_CHANGED, "no prices pinned");
  assert.equal(seatedPriceRefusal(h, feed, undefined), PRICES_CHANGED, "no payment on the feed");
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
