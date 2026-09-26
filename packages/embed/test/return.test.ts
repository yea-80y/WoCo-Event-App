/**
 * The return-from-Stripe rules (#567), pinned. Each test is a way the widget
 * could send the buyer somewhere that is not their page, read a return that is
 * not one, or say "paid" without the server having confirmed it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReturn, resolvePageUrl, returnView, withoutReturnMarker } from "../src/checkout.js";

const SESSION = "cs_test_a1B2c3D4e5F6g7H8i9";

// ---------------------------------------------------------------------------
// Which page the buyer is on
// ---------------------------------------------------------------------------

test("the web component on the organiser's page uses that page", () => {
  assert.equal(resolvePageUrl(null, "https://venue.example/tickets", false), "https://venue.example/tickets");
});

test("inside the frame, only the snippet's page-url names the page", () => {
  assert.equal(resolvePageUrl("https://venue.example/tickets", "https://events-api.woco-net.com/embed/frame/ev", true), "https://venue.example/tickets");
  assert.equal(resolvePageUrl(null, "https://events-api.woco-net.com/embed/frame/ev", true), undefined);
});

test("a page-url that is not http(s) is ignored", () => {
  assert.equal(resolvePageUrl("javascript:alert(1)", "https://venue.example/tickets", false), "https://venue.example/tickets");
  assert.equal(resolvePageUrl("javascript:alert(1)", "https://events-api.woco-net.com/embed/frame/ev", true), undefined);
});

// ---------------------------------------------------------------------------
// Reading the return marker
// ---------------------------------------------------------------------------

test("a success marker with a checkout session id is a return", () => {
  assert.deepEqual(parseReturn(`https://venue.example/p?woco=success&session_id=${SESSION}`), { kind: "success", sessionId: SESSION });
});

test("a cancelled marker is a return with nothing to confirm", () => {
  assert.deepEqual(parseReturn("https://venue.example/p?woco=cancelled"), { kind: "cancelled" });
});

test("a success marker without a real session id is not a return", () => {
  assert.equal(parseReturn("https://venue.example/p?woco=success"), null);
  assert.equal(parseReturn("https://venue.example/p?woco=success&session_id={CHECKOUT_SESSION_ID}"), null);
  assert.equal(parseReturn("https://venue.example/p?woco=success&session_id=pi_123"), null);
});

test("no marker, a marker only in the hash, or no page at all is not a return", () => {
  assert.equal(parseReturn("https://venue.example/p?utm=x"), null);
  assert.equal(parseReturn(`https://venue.example/p#woco=success&session_id=${SESSION}`), null);
  assert.equal(parseReturn(undefined), null);
});

test("removing the marker leaves every other pair and the hash byte-for-byte", () => {
  assert.equal(
    withoutReturnMarker(`https://venue.example/p?a=b%20c&woco=success&session_id=${SESSION}&z=1#/route`),
    "https://venue.example/p?a=b%20c&z=1#/route",
  );
  assert.equal(withoutReturnMarker(`https://venue.example/p?woco=success&session_id=${SESSION}`), "https://venue.example/p");
  assert.equal(withoutReturnMarker("https://venue.example/p#x"), "https://venue.example/p#x");
});

// ---------------------------------------------------------------------------
// What may be said about it
// ---------------------------------------------------------------------------

test("a server-confirmed paid order is shown as paid", () => {
  assert.deepEqual(
    returnView({ ok: true, data: { status: "paid", quantity: 2, seriesId: "s1", emailMasked: "n***@example.com" } }),
    { kind: "paid", quantity: 2, emailMasked: "n***@example.com" },
  );
});

test("an open or expired session is an unfinished payment", () => {
  assert.equal(returnView({ ok: true, data: { status: "open", quantity: 1 } }).kind, "unpaid");
  // #644: a cancelled event is never read as paid.
  assert.equal(returnView({ ok: true, data: { status: "cancelled", quantity: 1 } }).kind, "cancelled");
  assert.equal(returnView({ ok: true, data: { status: "expired", quantity: 1 } }).kind, "unpaid");
});

test("no answer, a refusal or a malformed answer is never shown as paid", () => {
  assert.equal(returnView(null).kind, "unconfirmed");
  assert.equal(returnView({ ok: false }).kind, "unconfirmed");
  assert.equal(returnView({ ok: true, data: { status: "paid", quantity: 0 } }).kind, "unconfirmed");
  assert.equal(returnView({ ok: true, data: { status: "PAID", quantity: 1 } }).kind, "unconfirmed");
});
