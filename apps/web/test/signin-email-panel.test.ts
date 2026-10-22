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

test("Google, then one tile each for Apple, Facebook, X and Discord - each its own sign-in - and More for Web3Auth's list", () => {
  assert.ok(panel.includes('onclick={() => login({ kind: "social", connection: "google" })}'));
  const tiles = panel.slice(panel.indexOf('<div class="tiles">'), panel.indexOf('<div class="or"'));
  for (const [connection, label] of [["apple", "Apple"], ["facebook", "Facebook"], ["twitter", "X"], ["discord", "Discord"]]) {
    assert.ok(tiles.includes(`aria-label="Continue with ${label}" onclick={() => login({ kind: "social", connection: "${connection}" })}`), label);
    assert.ok(tiles.includes(`<span class="tile-label">${label}</span>`), `${label} is named, not just a logo`);
  }
  assert.ok(tiles.includes('aria-label="More ways to sign in" onclick={() => login()}'), "More is Web3Auth's own chooser");
  assert.ok(panel.indexOf('<div class="tiles">') < panel.indexOf("<form"), "the other sign-ins sit above the email box, in sight");
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

test("the hand-off to Web3Auth (MetaMask) is one plain line, first, for every way in on the screen - in-app browsers too", () => {
  const note = panel.indexOf('<p class="handoff-note">');
  assert.ok(note > 0, "the line is there");
  assert.ok(note < panel.indexOf("{#if !inApp}"), "outside the in-app gate: email goes through Web3Auth as well");
  assert.ok(note < panel.indexOf('connection: "google"') && note < panel.indexOf("<form"), "before any button that leaves WoCo");
  const text = panel.slice(note, panel.indexOf("</p>", note)).replace(/\s+/g, " ");
  assert.ok(text.includes("Sign-in by <strong>Web3Auth (MetaMask)</strong>. You'll see their name next."));
  assert.doesNotMatch(email.slice(email.indexOf(".handoff-note {"), email.indexOf("}", email.indexOf(".handoff-note {"))), /border|background/, "a line, not a box");
});

test("the screen ends with Web3Auth's own Powered by MetaMask mark, as their modal does", () => {
  assert.ok(panel.includes('<img class="powered-by" src="https://images.web3auth.io/metamask-footer-logo-dark.svg" alt="Powered by MetaMask"'));
  // The same file the modal's footer shows in dark mode (Footer.js), from a host the CSP already allows.
  const footer = readFileSync(new URL("../node_modules/@web3auth/modal/dist/lib.esm/packages/modal/src/ui/components/Footer/Footer.js", import.meta.url), "utf8");
  assert.ok(footer.includes('src: "https://images.web3auth.io/metamask-footer-logo-dark.svg"'));
  assert.ok(read("../vite-plugins/csp.ts").includes('"https://images.web3auth.io", // login-method icons in the Web3Auth modal'));
});

test("nothing of Web3Auth loads before the person picks email or social: no hover warm-up (cookie notice: 'only if you sign in')", () => {
  assert.ok(!email.includes("onpointerenter"), "a hover is not a choice");
  assert.ok(read("../../../docs/legal/COOKIE_NOTICE.md").includes("Only if you sign in with social or email"));
});

test("an app's built-in browser: the email box, then Web3Auth's list as a plain link (no tiles there)", () => {
  const after = panel.slice(panel.indexOf("</form>"));
  const inApp = after.slice(after.indexOf("{#if inApp}"), after.indexOf("{/if}", after.indexOf("{#if inApp}")));
  assert.ok(inApp.includes('class="more-ways" onclick={() => login()}'));
  assert.ok(panel.includes('<label class="sr-only" for="w3a-email">Email address</label>'), "the field keeps a name for screen readers");
});
