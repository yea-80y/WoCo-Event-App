/**
 * The sign-in sheet's words when the browser refuses passkeys on this host. Shown
 * only after the refusal - nothing is guessed from the browser up front - and it
 * must stop a would-be organiser (organising needs a passkey) without turning away
 * someone who only wants tickets.
 *
 * MUTATION: drop the `invite` branch and the invite test goes red (it would offer
 * email the invite sheet does not show); route the refusal through the generic
 * `else` in PasskeyLogin and the wiring test goes red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { passkeyRefusalAdvice } from "../src/lib/auth/passkey-refusal-copy.ts";

const HOST = "woco.eth.limo";

test("the sign-in sheet: hosting needs a passkey in another browser; tickets can carry on with email", () => {
  const s = passkeyRefusalAdvice(HOST, false);
  assert.match(s, /can't use passkeys on woco\.eth\.limo/);
  assert.match(s, /To host events you need a passkey/);
  assert.match(s, /Chrome, Brave, Edge or Safari/);
  assert.match(s, /Sign in with email below/);
  assert.ok(!s.includes("—"), "owner copy: spaced hyphen, never an em dash");
});

test("an organiser invite offers no email, so the words never point at it", () => {
  const s = passkeyRefusalAdvice(HOST, true);
  assert.match(s, /hosting events needs one/);
  assert.match(s, /Chrome, Brave, Edge or Safari/);
  assert.ok(!/email/i.test(s), s);
});

test("PasskeyLogin shows that advice for the refusal, before its generic fallback", () => {
  const src = readFileSync(new URL("../src/lib/components/auth/PasskeyLogin.svelte", import.meta.url), "utf8");
  const branch = src.indexOf("res.error instanceof PasskeyBrowserRefusedError");
  assert.ok(branch > 0, "the refusal has its own branch");
  assert.ok(src.includes('passkeyRefusalAdvice(res.error.host, organiser)'));
  const fallback = src.indexOf('Passkey authentication failed. Try again or use another method.');
  assert.ok(fallback > branch, "the refusal is matched before the generic message");
});
