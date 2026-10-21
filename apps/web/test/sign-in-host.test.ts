/**
 * Where the sign-in sheet offers a picker, and where it only offers
 * "Sign in on woco.eth.limo" (#186). The passkey window answers the app's own origin
 * and nothing else (passkey-window.ts), so every other page sends people there.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mustSignInElsewhere } from "../src/lib/auth/sign-in-host.ts";

test("the app's own origin signs in here, and nothing else does", () => {
  assert.equal(mustSignInElsewhere("https://woco.eth.limo"), false);
  for (const origin of [
    "https://a.b.woco.eth.limo",
    "https://nabil.woco.eth.limo",
    "https://auth.woco.eth.limo",
    "https://gateway.woco-net.com",
    "https://woco.eth.link",
    "http://woco.eth.limo",
    "https://203.0.113.7",
    "http://localhost:5173",
    "null",
  ]) {
    assert.equal(mustSignInElsewhere(origin), true, origin);
  }
});

test("the sheet asks by origin, not by hostname", () => {
  const modal = readFileSync(fileURLToPath(new URL("../src/lib/components/auth/LoginModal.svelte", import.meta.url)), "utf8");
  assert.match(modal, /mustSignInElsewhere\(window\.location\.origin\)/);
});
