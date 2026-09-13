/**
 * Where Stripe sends a buyer after checkout (#567), pinned per caller: the embed
 * page, a WoCo-built site, and the main app. Every success URL must carry
 * Stripe's `{CHECKOUT_SESSION_ID}` placeholder verbatim, or the session id is
 * never substituted and the return cannot be confirmed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { acceptablePageUrl, checkoutRedirectUrls } from "../src/lib/stripe/checkout-urls.js";

delete process.env.FRONTEND_URL;

const EV = "83d23fab-16f7-42d6-922f-57eb95f437cf";
const SID = "{CHECKOUT_SESSION_ID}";
const woco = () => "https://woco.eth.limo";
const unused = () => {
  throw new Error("the WoCo frontend base was resolved for a checkout that does not use it");
};

// ---------------------------------------------------------------------------
// Embed: the organiser page
// ---------------------------------------------------------------------------

test("an embed checkout returns to the organiser page for both success and cancel", () => {
  const r = checkoutRedirectUrls({ eventId: EV, pageUrl: "https://venue.example/tickets", frontendUrl: unused });
  assert.equal(r.successUrl, `https://venue.example/tickets?woco=success&session_id=${SID}`);
  assert.equal(r.cancelUrl, "https://venue.example/tickets?woco=cancelled");
});

test("the page's own query and hash route are kept, with the marker ahead of the hash", () => {
  const r = checkoutRedirectUrls({ eventId: EV, pageUrl: "https://venue.example/p?utm=x#/buy", frontendUrl: unused });
  assert.equal(r.successUrl, `https://venue.example/p?utm=x&woco=success&session_id=${SID}#/buy`);
  assert.equal(r.cancelUrl, "https://venue.example/p?utm=x&woco=cancelled#/buy");
});

test("markers from an earlier return are replaced, not stacked", () => {
  const r = checkoutRedirectUrls({
    eventId: EV,
    pageUrl: "https://venue.example/p?woco=cancelled&session_id=cs_test_old123456789&a=1",
    frontendUrl: unused,
  });
  assert.equal(r.successUrl, `https://venue.example/p?a=1&woco=success&session_id=${SID}`);
});

test("only https pages, or http on localhost, without credentials, are destinations", () => {
  assert.ok(acceptablePageUrl("https://venue.example/p"));
  assert.ok(acceptablePageUrl("http://localhost:8787/embed-test.html"));
  assert.ok(acceptablePageUrl("http://127.0.0.1:8787/embed-test.html"));
  assert.equal(acceptablePageUrl("http://venue.example/p"), null);
  assert.equal(acceptablePageUrl("javascript:alert(1)"), null);
  assert.equal(acceptablePageUrl("https://user:pass@venue.example/"), null);
  assert.equal(acceptablePageUrl(`https://venue.example/${"a".repeat(3000)}`), null);
  assert.equal(acceptablePageUrl(42), null);
});

test("a refused page falls back to the platform pages", () => {
  const r = checkoutRedirectUrls({ eventId: EV, pageUrl: "http://venue.example/p", frontendUrl: woco });
  assert.equal(r.successUrl, `https://woco.eth.limo/#/event/${EV}/purchased?stripe=success&session_id=${SID}`);
  assert.equal(r.cancelUrl, `https://woco.eth.limo/#/event/${EV}?stripe=cancelled`);
});

// ---------------------------------------------------------------------------
// WoCo-built sites
// ---------------------------------------------------------------------------

test("a site on a sub-ENS name returns to its own event route", () => {
  const r = checkoutRedirectUrls({ eventId: EV, siteId: "site_abcdef123", returnUrl: "https://test.woco.eth.limo/", frontendUrl: unused });
  assert.equal(r.successUrl, `https://test.woco.eth.limo/#/events/${EV}?stripe=success&session_id=${SID}`);
});

test("a site served from a gateway path keeps the path", () => {
  const r = checkoutRedirectUrls({ eventId: EV, siteId: "site_abcdef123", returnUrl: "https://gateway.woco-net.com/bzz/abc/", frontendUrl: unused });
  assert.equal(r.successUrl, `https://gateway.woco-net.com/bzz/abc/#/events/${EV}?stripe=success&session_id=${SID}`);
});

test("a site with an unusable returnUrl uses the resolved frontend base, not the canonical app", () => {
  const r = checkoutRedirectUrls({
    eventId: EV,
    siteId: "site_abcdef123",
    returnUrl: "ftp://venue.example/",
    frontendUrl: () => "https://gateway.woco-net.com/bzz/abc",
  });
  assert.equal(r.successUrl, `https://gateway.woco-net.com/bzz/abc/#/events/${EV}?stripe=success&session_id=${SID}`);
});

// ---------------------------------------------------------------------------
// Main app
// ---------------------------------------------------------------------------

test("a platform checkout from a gateway bundle succeeds onto the canonical app", () => {
  const r = checkoutRedirectUrls({ eventId: EV, frontendUrl: () => "https://gateway.woco-net.com/bzz/abc" });
  assert.equal(r.successUrl, `https://woco.eth.limo/#/event/${EV}/purchased?stripe=success&session_id=${SID}`);
});

test("the app's cancel marker lands in the hash route's query", () => {
  const cancel = (cancelUrl: string) => checkoutRedirectUrls({ eventId: EV, cancelUrl, frontendUrl: woco }).cancelUrl;
  assert.equal(cancel("https://woco.eth.limo/#/event/abc"), "https://woco.eth.limo/#/event/abc?stripe=cancelled");
  assert.equal(cancel("https://woco.eth.limo/?ref=1#/event/abc"), "https://woco.eth.limo/?ref=1#/event/abc?stripe=cancelled");
  assert.equal(cancel("https://test.woco.eth.limo/"), "https://test.woco.eth.limo/?stripe=cancelled");
});

test("a cancel started from an already-cancelled page carries the marker once", () => {
  const r = checkoutRedirectUrls({ eventId: EV, cancelUrl: "https://woco.eth.limo/#/event/abc?stripe=cancelled", frontendUrl: woco });
  assert.equal(r.cancelUrl, "https://woco.eth.limo/#/event/abc?stripe=cancelled");
});

test("localhost and 127.0.0.1 are treated alike for cancel", () => {
  const r = checkoutRedirectUrls({ eventId: EV, cancelUrl: "http://127.0.0.1:5173/#/event/abc", frontendUrl: woco });
  assert.equal(r.cancelUrl, "http://127.0.0.1:5173/#/event/abc?stripe=cancelled");
});

test("every success shape carries the session placeholder verbatim, never encoded", () => {
  const shapes = [
    checkoutRedirectUrls({ eventId: EV, pageUrl: "https://venue.example/p", frontendUrl: unused }),
    checkoutRedirectUrls({ eventId: EV, siteId: "site_abcdef123", returnUrl: "https://test.woco.eth.limo/", frontendUrl: unused }),
    checkoutRedirectUrls({ eventId: EV, frontendUrl: woco }),
  ];
  for (const { successUrl } of shapes) {
    assert.ok(successUrl.endsWith(SID) || successUrl.includes(`${SID}#`), successUrl);
    assert.ok(!successUrl.includes("%7B"), successUrl);
  }
});
