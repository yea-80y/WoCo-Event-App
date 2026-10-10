/**
 * Inside an app's built-in browser the sign-in sheet leads with the way out
 * (owner decision 2026-10-10): no passkey buttons - the ceremony is refused there
 * before any sheet (#841) - and the Google / email sign-in only as a second choice,
 * whose wait is bounded and ends with Try again and the same way out.
 *
 * TEXT checks (the sheet is a Svelte component; this suite runs under plain tsx -
 * see login-surface-registration.test.ts for why), each pinned to the one line
 * that carries the behaviour.
 *
 * MUTATION: move `<PasskeyLogin` above the in-app branch and "no passkey button"
 * goes red; drop the `undefined` branch and "nothing flashes" goes red; drop
 * `onStall` from the store and "the store reports a stall" goes red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const modal = read("../src/lib/components/auth/LoginModal.svelte");
const email = read("../src/lib/components/auth/Web3AuthLogin.svelte");
const store = read("../src/lib/auth/auth-store.svelte.ts");
const account = read("../src/lib/auth/web3auth-account.ts");

/** The three branches of the method picker, in source order. */
function branches() {
  const unknown = modal.indexOf("{#if inAppBrowser === undefined}");
  const inApp = modal.indexOf("{:else if inAppBrowser}", unknown);
  // The real-browser branch is the `{:else}` right before the passkey button
  // (the in-app branch has an inner `{:else}` of its own, for the invite).
  const real = modal.lastIndexOf("{:else}", modal.indexOf("<PasskeyLogin"));
  const end = modal.indexOf("{#if view === \"wallet\"}", real);
  assert.ok(unknown > 0 && inApp > unknown && real > inApp && end > real, "the picker has its three branches");
  return { unknown: modal.slice(unknown, inApp), inApp: modal.slice(inApp, real), real: modal.slice(real, end) };
}

test("in an in-app browser the way out comes first, then the email sign-in as a second choice, and no passkey button", () => {
  const { inApp } = branches();
  const notice = inApp.indexOf('{#await import("./InAppBrowserNotice.svelte")');
  const anyway = inApp.indexOf("Or try here anyway", notice);
  const emailBtn = inApp.indexOf("<Web3AuthLogin", anyway);
  assert.ok(notice > 0 && anyway > notice && emailBtn > anyway, "notice, then the second choice, then the button");
  assert.ok(!inApp.includes("<PasskeyLogin"), "passkeys are not offered as if they could work");
  assert.ok(inApp.includes("inApp={inAppBrowser}"), "the email button knows the way out for its stalled state");
});

test("an organiser invite in an in-app browser gets the way out and an explanation, never a passkey ceremony", () => {
  const { inApp } = branches();
  const invite = inApp.indexOf("{#if !organiserSignIn}");
  const other = inApp.indexOf("{:else}", invite);
  assert.ok(invite > 0 && other > invite);
  assert.match(inApp.slice(other), /Organiser accounts use a passkey, which this browser can't create/);
});

test("until the in-app check has answered, nothing is rendered - no flash of buttons that are about to be hidden", () => {
  const { unknown } = branches();
  const markup = unknown.replace(/<!--[\s\S]*?-->/g, "").replace("{#if inAppBrowser === undefined}", "").trim();
  assert.equal(markup, "", `no element in the unknown branch: ${markup}`);
  assert.ok(modal.includes("$state<InAppBrowser | null | undefined>(undefined)"));
});

test("a real browser keeps the full picker: passkeys first, then email", () => {
  const { real } = branches();
  const passkey = real.indexOf("<PasskeyLogin");
  const emailBtn = real.indexOf("<Web3AuthLogin", passkey);
  assert.ok(passkey > 0 && emailBtn > passkey);
  assert.ok(real.includes("inApp={null}"));
});

test("a stalled wait brings the picker back in place of the spinner, with Try again and the way out", () => {
  assert.ok(modal.includes('const sceneShown = $derived(authing !== null && stage !== "stalled");'));
  assert.ok(modal.includes("{#if authing && sceneShown}"), "the scene hides on a stall");
  assert.ok(modal.includes("class:offstage={sceneShown}"), "the picker shows on a stall");
  assert.ok(email.includes('auth.loginStage === "stalled"'));
  assert.ok(email.includes(">Try again</button>"));
  assert.ok(email.includes("{escapeLabel}"), "the way out, labelled for the platform");
  const retry = email.slice(email.indexOf("async function retry()"), email.indexOf("</script>"));
  assert.ok(retry.includes("auth.cancelLogin();") && retry.indexOf("await attempt;") > retry.indexOf("auth.cancelLogin();"));
  assert.ok(retry.indexOf("await login();") > retry.indexOf("await attempt;"), "a fresh attempt only once the stalled one has settled");
});

test("the store reports a stall as its own stage, and the account module closes the SDK's loader on it", () => {
  const fn = store.slice(store.indexOf("async function loginWeb3Auth("), store.indexOf("\nfunction cancelLogin()"));
  assert.ok(fn.includes('_loginStage = "stalled";'));
  assert.ok(store.includes('$state<"waiting" | "stalled" | "finalizing" | null>'));
  const onStall = account.slice(account.indexOf("onStall: () => {"), account.indexOf("isCancel: isWeb3AuthCancel"));
  assert.ok(onStall.includes("_closeModal(instance);") && onStall.includes("opts.onStall?.();"));
  assert.ok(account.includes("_abortWait?.();"), "closing the sheet also ends a wait that outlived the SDK's promise");
});

test("the wait listens on focus, pageshow and visibilitychange, and counts only watched time", () => {
  const wait = read("../src/lib/auth/web3auth-signin-wait.ts");
  const deps = wait.slice(wait.indexOf("export function browserSignInWaitDeps()"));
  for (const ev of ['"focus"', '"pageshow"', '"visibilitychange"']) assert.ok(deps.includes(`addEventListener(${ev}, fn)`), ev);
  assert.ok(deps.includes('document.visibilityState === "visible" && document.hasFocus()'));
});

test("copy: never an em dash in the new lines", () => {
  for (const [name, text] of [
    ["Web3AuthLogin", email.slice(email.indexOf("<div class=\"w3a-login\">"), email.indexOf("<style>"))],
    ["web3auth-signin-error", read("../src/lib/auth/web3auth-signin-error.ts").split("WEB3AUTH_TIMED_OUT_MESSAGE")[1]],
  ] as const) {
    assert.ok(!text.includes("—"), `${name} carries an em dash`);
  }
});
