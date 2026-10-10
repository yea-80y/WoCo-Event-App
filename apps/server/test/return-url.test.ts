/**
 * The redirect-base helpers the event and shop checkouts share, pinned (#567).
 * None had a test; the event checkout's URL building now sits on top of them in
 * checkout-urls.ts, and the shop checkout still uses validateReturnUrl directly.
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { validateReturnUrl, getFrontendUrl, canonicalSuccessUrl } from "../src/lib/stripe/return-url.js";

process.env.ALLOWED_HOSTS = "woco.eth.limo,gateway.woco-net.com";
delete process.env.FRONTEND_URL;

const req = (headers: Record<string, string>) => ({ req: { header: (name: string) => headers[name.toLowerCase()] } });

test("an allowed host keeps its path and loses query, hash and trailing slash", () => {
  assert.equal(validateReturnUrl("https://gateway.woco-net.com/bzz/abc/?x=1#/e"), "https://gateway.woco-net.com/bzz/abc");
});

test("a host outside ALLOWED_HOSTS is refused", () => {
  assert.equal(validateReturnUrl("https://venue.example/tickets"), null);
});

test("localhost is trusted on any port", () => {
  assert.equal(validateReturnUrl("http://localhost:8787/page"), "http://localhost:8787/page");
});

test("an absent or malformed return URL is null", () => {
  assert.equal(validateReturnUrl(undefined), null);
  assert.equal(validateReturnUrl("not a url"), null);
});

test("a trusted Referer is used with its path", () => {
  assert.equal(getFrontendUrl(req({ referer: "https://gateway.woco-net.com/bzz/abc/" })), "https://gateway.woco-net.com/bzz/abc");
});

test("a trusted Origin is used without a path", () => {
  assert.equal(getFrontendUrl(req({ origin: "https://woco.eth.limo" })), "https://woco.eth.limo");
});

test("a localhost Referer is trusted, which is why a local test page gets its own origin back", () => {
  assert.equal(getFrontendUrl(req({ referer: "http://localhost:8787/" })), "http://localhost:8787");
});

test("an untrusted request falls back to the first ALLOWED_HOSTS entry", () => {
  const warn = mock.method(console, "warn", () => {});
  try {
    assert.equal(getFrontendUrl(req({ origin: "https://events-api.woco-net.com" })), "https://woco.eth.limo");
  } finally {
    warn.mock.restore();
  }
});

test("FRONTEND_URL wins over the ALLOWED_HOSTS fallback when it is set", () => {
  process.env.FRONTEND_URL = "https://frontend.example";
  try {
    assert.equal(getFrontendUrl(req({})), "https://frontend.example");
  } finally {
    delete process.env.FRONTEND_URL;
  }
});

test("a gateway bundle base is sent to the canonical app for success; any other base is kept", () => {
  assert.equal(canonicalSuccessUrl("https://gateway.woco-net.com/bzz/abc"), "https://woco.eth.limo");
  assert.equal(canonicalSuccessUrl("https://woco.eth.limo"), "https://woco.eth.limo");
});
