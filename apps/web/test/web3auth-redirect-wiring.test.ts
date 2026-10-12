/**
 * Where the redirect sign-in sits in the app (web3auth-redirect.ts): the boot
 * finishes a return INSTEAD of any stored-session restore, through the SAME
 * account set-up a pop-up sign-in reaches (never a second copy), the router
 * strips a result before its first read, and the sheet shows the finish.
 *
 * MUTATIONS (each went red, then restored): the finish run after the stored-kind
 * restore; the finish given its own copy of the account set-up; the capture
 * installed after the router's first update(); the sheet not opening on a finish.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const store = read("../src/lib/auth/auth-store.svelte.ts");
const router = read("../src/lib/router/router.svelte.ts");
const modal = read("../src/lib/components/auth/LoginModal.svelte");

test("boot: a captured return is finished BEFORE, and instead of, the stored-session restore", () => {
  const init = store.slice(store.indexOf("async function init(): Promise<void> {"));
  const take = init.indexOf("const redirect = takePendingWeb3AuthRedirect();");
  const kind = init.indexOf("const kind = await getKV<AuthKind>(StorageKeys.AUTH_KIND);");
  assert.ok(take > 0 && kind > take, "checked first");
  assert.match(init.slice(take, kind), /if \(redirect\) \{\s+void _finishWeb3AuthRedirect\(redirect\);\s+return;\s+\}/);
  assert.ok(init.slice(0, take).split("await ").length === 1, "nothing awaited before it (the sheet sees it at once)");
});

test("one account set-up for both ways a key arrives: the pop-up and the redirect return share _runWeb3AuthSignIn", () => {
  const login = store.slice(store.indexOf("async function loginWeb3Auth("), store.indexOf("let _redirectSignIn"));
  assert.match(login, /return _runWeb3AuthSignIn\("waiting", async \(m\) => \{/);
  assert.match(login, /return m\.loginWithWeb3Auth\(\{/);
  const finish = store.slice(store.indexOf("async function _finishWeb3AuthRedirect("), store.indexOf("async function _runWeb3AuthSignIn("));
  assert.match(finish, /await _runWeb3AuthSignIn\("finalizing", \(m\) => m\.finishWeb3AuthRedirectSignIn\(pending\)\);/);
  // The set-up lives in the shared path, and neither entry point has its own.
  const run = store.slice(store.indexOf("async function _runWeb3AuthSignIn("), store.indexOf("function cancelLogin(): void {"));
  for (const step of ['step = "tombstone";', "buildKernelFromPrivateKey", "await _clearStaleAuthForSwitch(kernel.address);", "await _establishFeedSignerEagerly();"]) {
    assert.ok(run.includes(step), step);
    assert.ok(!login.includes(step) && !finish.includes(step), `no second copy: ${step}`);
  }
});

test("router: the capture runs before the first read of the hash", () => {
  const install = router.indexOf("installWeb3AuthRedirectCapture(window);");
  const first = router.indexOf("update();", install);
  assert.ok(install > 0 && first > install);
  assert.ok(router.indexOf('window.addEventListener("hashchange", update);') > install);
});

test("sheet: opens on the email scene while a return is finished, closes on success, back to the picker on failure", () => {
  assert.match(modal, /if \(auth\.redirectSignIn === "finishing"\) \{\s+finishingRedirect = true;\s+if \(!visible\) void loginRequest\.request\(\);\s+authing = "email";/);
  assert.match(modal, /if \(auth\.isAuthenticated\) handleComplete\(\);\s+else settle\(\);/);
  assert.match(modal, /if \(takeStrayWeb3AuthRedirect\(\)\) void loginRequest\.request\(\);/);
});
