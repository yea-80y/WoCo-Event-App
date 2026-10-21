/**
 * What a refused passkey ceremony is told (an iPhone, 2026-10-09). The browser
 * says NotAllowedError for a cancelled sheet, for a ceremony it would not start
 * (no gesture it accepts, another ceremony pending, an app's embedded browser) and
 * for the follow-up after a creation that gave no secret. One sentence for all three
 * sent a person whose passkey HAD been created to make another, and one whose prompt
 * never opened to "try again" with no idea why.
 *
 * The window times each refusal (`quick`, auth-window-ceremonies.test.ts); this runs
 * the REAL passkey-account code against a scripted window and checks the words.
 *
 * MUTATION: drop the quick mark in `errorFromWindow` and both "no sheet" tests go red;
 * map CreatedWithoutSecret to a cancel and "created without its secret" goes red; swap
 * the noSheet branch in PasskeyLogin below the noAssertion one and the wiring test goes red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { installFakeIndexedDB, scriptedWindow } from "./fake-passkey-window.ts";

installFakeIndexedDB();
const win = scriptedWindow();

const {
  createPasskeyAccount,
  authenticatePasskey,
  PasskeyCeremonyCancelledError,
  PasskeyCreatedWithoutSecretError,
  PasskeyAssertionUnavailableError,
  PROMPT_DID_NOT_OPEN_MESSAGE,
  isQuickRefusal,
  __setPasskeyWindowForTests,
} = await import("../src/lib/auth/passkey-account.ts");
__setPasskeyWindowForTests(win.run);

const refused = (quick: boolean) => ({ name: "NotAllowedError" as const, quick });

test("a creation refused after a sheet (seconds) keeps the cancelled-or-not-permitted wording", async () => {
  win.answer(refused(false));
  await assert.rejects(createPasskeyAccount(), (e: unknown) => {
    assert.ok(e instanceof PasskeyCeremonyCancelledError);
    assert.equal(e.noSheet, false);
    assert.equal(e.message, "Passkey creation was cancelled or not permitted by your device.");
    assert.ok(isQuickRefusal(e.cause) === false);
    return true;
  });
});

test("a creation refused before any sheet could open says the prompt did not open", async () => {
  win.answer(refused(true));
  await assert.rejects(createPasskeyAccount(), (e: unknown) => {
    assert.ok(e instanceof PasskeyCeremonyCancelledError);
    assert.equal(e.noSheet, true);
    assert.equal(e.message, PROMPT_DID_NOT_OPEN_MESSAGE);
    assert.match(e.message, /Safari or Chrome/, "names the way out of an app's built-in browser");
    return true;
  });
});

test("created, but the fallback assertion for its secret was refused: said as that, never as a cancelled creation", async () => {
  // No PRF at creation (a third-party password manager), then the follow-up was
  // refused: the window says so as its own refusal.
  win.answer({ name: "CreatedWithoutSecret" });
  await assert.rejects(createPasskeyAccount(), (e: unknown) => {
    assert.ok(e instanceof PasskeyCreatedWithoutSecretError);
    assert.match(e.message, /was created/);
    assert.match(e.message, /Sign in with Passkey/, "the passkey they have is the way to finish");
    assert.ok(!(e instanceof PasskeyCeremonyCancelledError));
    return true;
  });
  // However it was refused, it is still the created passkey's story.
  win.answer({ name: "CreatedWithoutSecret" });
  await assert.rejects(createPasskeyAccount(), PasskeyCreatedWithoutSecretError);
});

test("a sign-in refused before any sheet is not 'you may have cancelled', and offers no create", async () => {
  win.answer(refused(true));
  await assert.rejects(authenticatePasskey(), (e: unknown) => {
    assert.ok(e instanceof PasskeyAssertionUnavailableError);
    assert.equal(e.noSheet, true);
    assert.equal(e.message, PROMPT_DID_NOT_OPEN_MESSAGE);
    return true;
  });
  win.answer(refused(false));
  await assert.rejects(authenticatePasskey(), (e: unknown) => {
    assert.ok(e instanceof PasskeyAssertionUnavailableError);
    assert.equal(e.noSheet, false);
    assert.match(e.message, /You may have cancelled/);
    return true;
  });
});

test("the quick-refusal mark is per error object and only for NotAllowedError", async () => {
  assert.equal(isQuickRefusal(new DOMException("x", "NotAllowedError")), false, "unmarked until the window said quick");
  assert.equal(isQuickRefusal(null), false);
  assert.equal(isQuickRefusal("NotAllowedError"), false);
});

// --- wiring ----------------------------------------------------------------------

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

test("the passkey button reads 'no sheet' before 'no assertion', so a prompt that never opened offers no create", () => {
  const button = read("../src/lib/components/auth/PasskeyLogin.svelte");
  const noSheet = button.indexOf("} else if (res.noSheet) {");
  const noAssertion = button.indexOf('} else if (res.noAssertion && mode === "signin") {');
  assert.ok(noSheet > 0 && noAssertion > noSheet);
  assert.ok(!button.slice(noSheet, noAssertion).includes("offerCreate = true"));
  const store = read("../src/lib/auth/auth-store.svelte.ts");
  assert.ok(store.includes("noSheet: (err as { noSheet?: boolean }).noSheet === true,"));
});

test("closing the sign-in sheet mid-attempt cancels the Web3Auth pop-up wait, and the hook never outlives the attempt", () => {
  const modal = read("../src/lib/components/auth/LoginModal.svelte");
  const close = modal.indexOf("function close() {");
  assert.ok(modal.slice(close, modal.indexOf("function handleComplete()")).includes("if (authing) auth.cancelLogin();"));
  const store = read("../src/lib/auth/auth-store.svelte.ts");
  const start = store.indexOf("async function loginWeb3Auth(");
  const fn = store.slice(start, store.indexOf("\nfunction cancelLogin()", start));
  // Armed only inside the pop-up's key acquisition (the redirect finish has nothing to cancel)...
  const armed = fn.indexOf("_cancelLogin = m.cancelWeb3AuthSignIn;");
  const asked = fn.indexOf("return m.loginWithWeb3Auth(", armed);
  // ...and disarmed by the shared path as soon as the key is in.
  const awaited = fn.indexOf("await acquire(await import(\"./web3auth-account.js\"));", asked);
  const disarmed = fn.indexOf("_cancelLogin = null;", awaited);
  assert.ok(armed > 0 && asked > armed && awaited > asked && disarmed > awaited, "armed for the pop-up wait only");
  assert.ok(fn.slice(fn.indexOf("} finally {")).includes("_cancelLogin = null;"), "cleared however the attempt ends");
  assert.ok(store.includes("\n  cancelLogin,\n"), "exposed to the sheet");
});
