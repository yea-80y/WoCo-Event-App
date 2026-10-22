/**
 * WoCo's own email / Google / Apple screen (owner 2026-10-22): one tap from the
 * sheet's "Continue with email or social", in place of Web3Auth's chooser. The
 * request each button sends is pinned in web3auth-direct.test.ts and the flow in
 * web3auth-account.test.ts; this pins the screen's wiring.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const modal = read("../src/lib/components/auth/LoginModal.svelte");
const email = read("../src/lib/components/auth/Web3AuthLogin.svelte");
const script = email.slice(0, email.indexOf("</script>"));
const panel = email.slice(email.indexOf("{:else if panel}"), email.indexOf("<!-- Web3Auth's modal offers email, SMS"));

test("the sheet: both entry buttons open the email screen, which has a way back and one panel", () => {
  assert.ok(modal.includes('let view = $state<"main" | "wallet" | "email">("main");'));
  assert.equal(modal.split('onexpand={() => (view = "email")}').length - 1, 2, "the real browser's entry and the in-app one");
  const view = modal.slice(modal.indexOf('{#if view === "email"}'), modal.indexOf('{#if view === "wallet"}'));
  assert.ok(view.includes('onclick={() => (view = "main")} use:focusOnMount'), "back to all options");
  assert.ok(view.includes("<Web3AuthLogin panel oncomplete={handleComplete} onstart={() => start(\"email\")} onsettle={settle} inApp={inAppBrowser ?? null} />"));
  // The view resets with the sheet, as the wallet screen's does.
  assert.ok(modal.includes('view = "main";'));
});

test("the entry button opens the screen and warms the SDK on the way; without onexpand it is the modal as before", () => {
  assert.ok(email.includes("<button class=\"w3a-btn w3a-btn--main\" onclick={choose}"));
  const choose = script.slice(script.indexOf("function choose()"), script.indexOf("function focusOnDesktop"));
  assert.ok(choose.includes("if (!onexpand) return void login();"));
  assert.ok(choose.indexOf("auth.prewarmWeb3AuthSignIn();") < choose.indexOf("onexpand();"));
  assert.ok(script.includes("if (panel) auth.prewarmWeb3AuthSignIn();"), "the panel builds the instance before any tap");
});

test("each button starts its own sign-in; More ways is Web3Auth's chooser", () => {
  assert.ok(panel.includes('onclick={() => login({ kind: "social", connection: "google" })}'));
  assert.ok(panel.includes('onclick={() => login({ kind: "social", connection: "apple" })}'));
  assert.ok(panel.includes('class="more-ways" onclick={() => login()}'));
  // Google refuses an app's built-in browser (#812): there the email box leads.
  const gated = panel.slice(panel.indexOf("{#if !inApp}"), panel.indexOf("<form"));
  assert.ok(gated.includes('connection: "google"') && gated.includes('connection: "apple"'));
});

test("the email box: the modal's own check, and a field phones fill and type well", () => {
  const submit = script.slice(script.indexOf("function submitEmail("), script.indexOf("function choose()"));
  assert.ok(submit.includes("if (!EMAIL_PATTERN.test(value)) {"));
  assert.ok(submit.includes('void login({ kind: "email", email: value });'));
  for (const attr of ['type="email"', 'autocomplete="email"', 'inputmode="email"', 'autocapitalize="none"', 'spellcheck="false"', 'enterkeyhint="go"']) {
    assert.ok(panel.includes(attr), attr);
  }
  assert.ok(panel.includes("<form class=\"email-form\" onsubmit={submitEmail} novalidate>"), "Enter submits; our message, not the browser's");
  assert.match(email, /\.email-form input \{\s*width: 100%;\s*font-size: 1rem;/, "16px, so iOS does not zoom");
});

test("a blocked pop-up offers one tap that repeats the same sign-in", () => {
  const blocked = panel.slice(panel.indexOf("{#if blocked}"), panel.indexOf("{/if}", panel.indexOf("{#if blocked}")));
  assert.ok(blocked.includes("{WEB3AUTH_POPUP_BLOCKED_MESSAGE}"));
  assert.ok(blocked.includes("onclick={() => login(lastRoute)}"));
  assert.ok(script.includes("} else if (isWeb3AuthSignInError(e) && e.blocked) {\n        blocked = true;"));
});

test("the hand-off to Web3Auth is said before the Google and Apple buttons, never after", () => {
  const gated = panel.slice(panel.indexOf("{#if !inApp}"), panel.indexOf("<form"));
  const note = gated.indexOf('<p class="handoff-note">');
  assert.ok(note > 0 && note < gated.indexOf('connection: "google"'), "above the buttons it explains");
  assert.ok(gated.includes("handled by Web3Auth, our sign-in partner - you'll see their name next."));
});
