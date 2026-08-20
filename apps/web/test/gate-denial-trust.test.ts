/**
 * Which 403s may be believed.
 *
 * `probeSoc` treats a 403 from OUR chunk gate as `absent`, which removes a
 * ~2-3s server round trip from every absent probe — the largest single cost in
 * a cold read (measured 2026-08-20). That is only sound because the gate is
 * authoritative about what exists behind it: it refuses exactly the addresses
 * it has never been told about, and every write whitelists its own address
 * before uploading.
 *
 * Everything else that can emit a 403 — Cloudflare, a WAF, a captive portal, a
 * corporate proxy — is saying "I would not ask", and #138/#156 exist because a
 * "couldn't ask" once got cached as an answer. So the cost of a false positive
 * here is a rider's real lap reading as absent. These cases are the boundary.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { isOurGateDenial } from "../src/lib/swarm/gate-denial.js";

test("a Headers-style object carrying the tag is trusted", () => {
  const err = { response: { headers: new Map([["x-chunk-gate", "not-whitelisted"]]) } };
  assert.equal(isOurGateDenial(err), true);
});

test("a plain-object header bag carrying the tag is trusted", () => {
  assert.equal(isOurGateDenial({ response: { headers: { "x-chunk-gate": "not-whitelisted" } } }), true);
});

test("the body code is trusted when headers are absent — bee-js surfaces bodies more reliably", () => {
  assert.equal(isOurGateDenial({ responseBody: '{"error":"Access denied","code":"NOT_WHITELISTED"}' }), true);
  assert.equal(isOurGateDenial({ response: { data: { error: "Access denied", code: "NOT_WHITELISTED" } } }), true);
});

test("a Cloudflare 403 is NOT trusted", () => {
  // The exact shape that must never become `absent`: an intermediary refusing,
  // with no idea whether the chunk exists.
  const err = {
    message: "Request failed with status code 403",
    response: { data: "<!DOCTYPE html><title>403 Forbidden</title><h1>cloudflare</h1>" },
  };
  assert.equal(isOurGateDenial(err), false);
});

test("prose alone is NOT trusted — only the machine-readable code", () => {
  // The proxy's human message says "This hash is not whitelisted" in lowercase
  // prose. Matching that would make a reworded message silently change trust.
  assert.equal(isOurGateDenial({ responseBody: '{"message":"This hash is not whitelisted"}' }), false);
});

test("an empty or unrecognisable error is NOT trusted", () => {
  assert.equal(isOurGateDenial(undefined), false);
  assert.equal(isOurGateDenial(null), false);
  assert.equal(isOurGateDenial({}), false);
  assert.equal(isOurGateDenial({ message: "Network Error" }), false);
  assert.equal(isOurGateDenial({ response: { headers: { "x-chunk-gate": "something-else" } } }), false);
});

test("an ArrayBuffer body is decoded — this is bee-js's REAL shape", () => {
  // `BeeResponseError` carries no headers and no `response` object; its
  // `responseBody` is an ArrayBuffer. Confirmed against the live error in a
  // browser on 2026-08-20. The first version of this rule JSON.stringify'd it
  // to "{}", so trust never fired and the fix looked deployed while doing
  // nothing. Every other case here is secondary to this one.
  const json = '{"error":"Access denied","code":"NOT_WHITELISTED","message":"This hash is not whitelisted"}';
  const buf = new TextEncoder().encode(json).buffer;
  assert.equal(isOurGateDenial({ status: 403, responseBody: buf }), true);
});

test("a binary body WITHOUT the code is still not trusted", () => {
  const buf = new TextEncoder().encode('<html>403 Forbidden — cloudflare</html>').buffer;
  assert.equal(isOurGateDenial({ status: 403, responseBody: buf }), false);
});

test("a Uint8Array view is decoded too, honouring byteOffset", () => {
  const full = new TextEncoder().encode('XXXX{"code":"NOT_WHITELISTED"}');
  const view = new Uint8Array(full.buffer, 4, full.byteLength - 4);
  assert.equal(isOurGateDenial({ responseBody: view }), true);
});
