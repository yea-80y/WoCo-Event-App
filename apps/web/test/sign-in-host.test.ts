/**
 * Where the sign-in sheet offers a picker, and where it only offers
 * "Sign in on woco.eth.limo" (#186). Off the canonical host a passkey is a
 * different account and the gateway host shares storage with organisers'
 * deployed sites, so the picker must not appear there.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mustSignInElsewhere } from "../src/lib/auth/sign-in-host.ts";

test("the canonical host signs in here, and so does a deeper subdomain (same passkey scope, not a name)", () => {
  assert.equal(mustSignInElsewhere("woco.eth.limo", false), false);
  assert.equal(mustSignInElsewhere("a.b.woco.eth.limo", false), false);
});

test("a WoCo name host always redirects, dev or not", () => {
  assert.equal(mustSignInElsewhere("nabil.woco.eth.limo", false), true);
  assert.equal(mustSignInElsewhere("nabil.woco.eth.link", true), true);
});

test("any other production host redirects: the gateway, another ENS gateway, an IP", () => {
  assert.equal(mustSignInElsewhere("gateway.woco-net.com", false), true);
  assert.equal(mustSignInElsewhere("woco.eth.link", false), true);
  assert.equal(mustSignInElsewhere("203.0.113.7", false), true);
});

test("local development keeps the picker", () => {
  assert.equal(mustSignInElsewhere("localhost", false), false);
  assert.equal(mustSignInElsewhere("127.0.0.1", false), false);
  assert.equal(mustSignInElsewhere("192.168.0.20", true), false);
});
