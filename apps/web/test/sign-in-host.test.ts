/**
 * Where the sign-in sheet offers a picker, and where it only offers
 * "Sign in on woco.eth.limo" (#186). Off the canonical host a passkey is a
 * different account and the gateway host shares storage with organisers'
 * deployed sites, so the picker must not appear there.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

test("every passkey ceremony takes its RP ID through the off-host refusal; restore-time reads do not", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/lib/auth/passkey-account.ts", import.meta.url)), "utf8");
  assert.equal(src.match(/const rpId = ceremonyRpId\(\);/g)?.length, 5, "authenticate, mint, add, backup create, backup get");
  assert.equal(src.match(/const rpId = getPasskeyRpId\(\);/g), null, "no ceremony bypasses the refusal");
  const fn = src.slice(src.indexOf("function ceremonyRpId("), src.indexOf("\n}\n", src.indexOf("function ceremonyRpId(")));
  assert.match(fn, /if \(mustSignInElsewhere\(window\.location\.hostname, buildEnv\(\(\) => import\.meta\.env\.DEV\) === true\)\) \{\s*throw/);
});
