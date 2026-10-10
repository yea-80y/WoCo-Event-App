/**
 * A friend's iPhone in real Safari on woco.eth.limo (iOS 26.6.2, 2026-10-10):
 *
 *  - "Create a passkey account" opened iOS's "Choose how to manage your passkeys"
 *    sheet - no password manager set up for passkeys - and closing it left WoCo's
 *    "cancelled or not permitted", with no word of what iOS wanted.
 *  - The email sign-in (code entered in Web3Auth's modal, which signs in through
 *    Web3Auth's auth iframe) ended in "Sign-in failed" with the cause only in the
 *    console. The cause cannot be read from here, so the line now carries a short
 *    code: where it failed and what kind of error, never what the error said.
 *
 * MUTATIONS (each went red, then restored): the extra part read for any error
 * name, or copied instead of described (the pop-up-path tests); an unknown rejection string copied
 * instead of reduced to its length and topic words (the leak test); `describeSignInError` reading `.message` (6 tests); the store's
 * catch back to `return false` (the wiring test); the PasskeyLogin iOS branch
 * disabled (the order test); no iPad touch check; the invite branch dropped; a
 * non-Error rejection replaced instead of kept, or the connect step unmarked
 * (web3auth-account.test.ts as well).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SignInFailedError,
  describeSignInError,
  isSignInFailedError,
  markSignInStep,
  describeRejectionString,
  signInFailureCode,
  signInStepOf,
  SIGN_IN_FAILED_MESSAGE,
} from "../src/lib/auth/signin-failure.ts";
import { appleTouchDevice, passkeyCreateRefusedAdvice } from "../src/lib/auth/passkey-refusal-copy.ts";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** The SDK's own error shape (`@web3auth/no-modal` WalletLoginError: name set explicitly, numeric code). */
function walletLoginError(code: number, message: string, cause?: unknown): Error {
  const e = new Error(message) as Error & { code: number; cause?: unknown };
  Object.defineProperty(e, "name", { value: "WalletLoginError" });
  e.code = code;
  if (cause !== undefined) e.cause = cause;
  return e;
}

const EMAIL = "friend.name@example.com";
const KEY = "0x" + "ab".repeat(32);

// --- the code -------------------------------------------------------------------

test("the auth iframe's failure, as Web3Auth wraps it, reads as step + SDK error + its cause's words", () => {
  // AuthProvider LOGIN_FAILED rejects with a string; authConnector.connect wraps
  // any non-Web3AuthError as connectionError(5111) with it as the cause.
  const sdk = walletLoginError(5111, "Failed to connect with wallet. Failed to login with auth", "Login failed, reason: unknown");
  const marked = markSignInStep(sdk, "connect", ["st.ready"]);
  const code = signInFailureCode(marked, { step: "sdk", elapsedMs: 41_400 });
  assert.equal(code, "W3A-connect-WalletLoginError.5111(auth-login-failed)~login-failed-unknown-t41-st.ready");
});

test("the pop-up path (her iPhone, 2026-10-10): the iframe's reason survives only in the SDK message's extra part", () => {
  // authConnector.connectWithSocialLogin: connectionError(error.message ?? error), NO cause.
  // Her code before this read: W3A-connect-WalletLoginError.5111-t60-st.errored
  const sdk = walletLoginError(5111, "Failed to connect with wallet. Login failed, reason: unknown");
  assert.equal(
    signInFailureCode(markSignInStep(sdk, "connect", ["st.errored"]), { step: "sdk", elapsedMs: 60_000 }),
    "W3A-connect-WalletLoginError.5111(login-failed-unknown)-t60-st.errored",
  );
  const reason = `Third party cookies are blocked for ${EMAIL}`;
  const withEmail = walletLoginError(5111, `Failed to connect with wallet. ${reason}`);
  assert.equal(describeSignInError(withEmail), `WalletLoginError.5111(str${reason.length}:cookie+blocked)`);
  assert.ok(!describeSignInError(withEmail).includes("example"));
  const nothingExtra = walletLoginError(5113, "Wallet is not connected. ");
  assert.equal(describeSignInError(nothingExtra), "WalletLoginError.5113");
});

test("only Web3Auth's own error classes have their extra part read", () => {
  const viemish = new Error(`HTTP request failed. URL: https://rpc.example/v3/secret, ${EMAIL}`);
  Object.defineProperty(viemish, "name", { value: "HttpRequestError" });
  assert.equal(describeSignInError(viemish), "HttpRequestError");
});

test("never a message: an Error's text is not read at any depth", () => {
  const inner = new Error(`could not reach https://rpc.example/v3/secret-project for ${EMAIL}`);
  const outer = Object.assign(new Error(`login ${EMAIL} key ${KEY}`), { cause: inner });
  const d = describeSignInError(outer);
  assert.equal(d, "Error~Error");
  for (const leak of [EMAIL, "example", "secret", "rpc", KEY.slice(2, 20)]) assert.ok(!d.includes(leak), leak);
});

test("an unknown string is never copied: only its length and which fixed topic words it mentions", () => {
  const hint = `Invalid login hint ${EMAIL} for verifier woco-prod`;
  assert.equal(describeSignInError(hint), `str${hint.length}:verifier+invalid`);
  assert.equal(describeRejectionString(`jane at example dot com ${KEY}`), `str${`jane at example dot com ${KEY}`.length}`);
  assert.equal(describeRejectionString("Third-party cookies blocked: session storage denied"), "str51:cookie+storage+session+blocked+denied");
  for (const leak of ["jane", "example", "woco-prod", KEY.slice(2, 12)]) {
    assert.ok(!describeSignInError(hint).includes(leak) && !describeRejectionString(`jane ${KEY}`).includes(leak), leak);
  }
});

test("strings the SDK itself is known to send map to fixed words", () => {
  assert.equal(describeRejectionString("Login failed, reason: unknown"), "login-failed-unknown");
  assert.equal(describeRejectionString("popup window is blocked"), "popup-blocked");
  assert.equal(describeRejectionString(" Failed to login with social "), "social-login-failed");
});

test("names that are not plain identifiers, and codes that are not small integers, are dropped", () => {
  const odd = Object.assign(new Error("x"), { code: "E_SECRET_abc" });
  Object.defineProperty(odd, "name", { value: "Weird name <script>" });
  assert.equal(describeSignInError(odd), "obj");
  assert.equal(describeSignInError(Object.assign(new Error("x"), { status: 503 })), "Error.503");
  assert.equal(describeSignInError(new DOMException("quota", "QuotaExceededError")), "QuotaExceededError.22", "a DOMException keeps its legacy numeric code");
  assert.equal(describeSignInError(undefined), "undefined");
});

test("a non-object rejection is wrapped, marked, and keeps its value as the clue", () => {
  const thrown = markSignInStep("Login failed, reason: unknown", "connect");
  assert.ok(thrown instanceof Error);
  assert.equal(signInStepOf(thrown)?.step, "connect");
  assert.equal(describeSignInError(thrown), "Rejected~login-failed-unknown");
});

test("the first mark wins, the store's step is the fallback, and flags are named", () => {
  const e = new TypeError("Load failed");
  markSignInStep(e, "key");
  markSignInStep(e, "connect");
  assert.equal(signInStepOf(e)?.step, "key");
  const unmarked = new TypeError("Load failed");
  assert.equal(
    signInFailureCode(unmarked, { step: "kernel", elapsedMs: 3_200, fast: false, hidden: true, offline: true }),
    "W3A-kernel-TypeError-t3-hidden-offline",
  );
  assert.equal(signInFailureCode(unmarked, { step: "feed", elapsedMs: 0, fast: true }), "W3A-feed-TypeError-t0-fast");
});

test("notes from the SDK must be identifier-like words", () => {
  const e = markSignInStep(new Error("x"), "connect", [`st.${EMAIL}`, "no-client-id"]);
  assert.equal(signInFailureCode(e, { step: "sdk", elapsedMs: 0 }), "W3A-connect-Error-t0-no-client-id");
});

test("the coded error is recognised by name, with the owner's copy (spaced hyphen)", () => {
  const e = new SignInFailedError("W3A-sdk-Error-t1", new Error("x"));
  assert.ok(isSignInFailedError(e));
  assert.equal(e.message, SIGN_IN_FAILED_MESSAGE);
  assert.ok(!SIGN_IN_FAILED_MESSAGE.includes("—"));
  const lookalike = new Error("x");
  lookalike.name = "SignInFailedError";
  assert.ok(!isSignInFailedError(lookalike), "a name with no code is not one");
});

// --- where it is wired ----------------------------------------------------------

const store = read("../src/lib/auth/auth-store.svelte.ts");
const account = read("../src/lib/auth/web3auth-account.ts");
const button = read("../src/lib/components/auth/Web3AuthLogin.svelte");
const passkeyButton = read("../src/lib/components/auth/PasskeyLogin.svelte");

function loginWeb3AuthBody(): string {
  const start = store.indexOf("async function loginWeb3Auth(");
  return store.slice(start, store.indexOf("\nfunction cancelLogin(", start));
}

test("the store throws the coded failure instead of a bare false, after passing WoCo's own outcomes through", () => {
  const fn = loginWeb3AuthBody();
  const catchAt = fn.lastIndexOf("} catch (e) {");
  const tail = fn.slice(catchAt);
  const passThrough = tail.indexOf("if (isOrphanedCredentialError(e) || isWeb3AuthSignInError(e)) throw e;");
  const coded = tail.indexOf("throw new SignInFailedError(code, e);");
  assert.ok(passThrough > 0 && coded > passThrough, "own outcomes first, then the code");
  assert.ok(!tail.slice(0, tail.indexOf("} finally {")).includes("return false"), "no silent false from the catch");
  assert.equal(fn.match(/return false;/g)?.length, 1, "only the busy guard returns false");
});

test("every await after the key is reached with its step set", () => {
  const fn = loginWeb3AuthBody();
  const pairs: Array<[string, string]> = [
    ['step = "lookup";', "await _recoveryKernelFor(address)"],
    ['step = "owner";', "await readKernelEcdsaOwner(override)"],
    ['step = "kernel";', "await buildKernelFromPrivateKey("],
    ['step = "signer";', "await readKernelSignerFor(kernel.address, address)"],
    ['step = "switch";', "await _clearStaleAuthForSwitch(kernel.address)"],
    ['step = "store";', "await putKV(StorageKeys.AUTH_KIND"],
    ['step = "restore";', "await _restoreCachedAuth()"],
    ['step = "feed";', "await _establishFeedSignerEagerly()"],
  ];
  for (const [set, call] of pairs) {
    const at = fn.indexOf(call);
    assert.ok(at > 0, call);
    const lastStep = fn.lastIndexOf('step = "', at);
    assert.ok(fn.startsWith(set, lastStep), `${call} runs under ${set}`);
  }
});

test("inside the Web3Auth chunk, each raw failure is marked with its step and passed on unchanged", () => {
  assert.ok(account.includes('throw markSignInStep(e, "sdk");'));
  assert.ok(account.includes('throw markSignInStep(e, "connect", [`st.${w.status}`]);'));
  assert.ok(account.includes('throw markSignInStep(e, "key");'));
  assert.ok(account.includes('throw markSignInStep(new Error(NOT_CONFIGURED), "sdk", ["no-client-id"]);'));
  assert.ok(!account.includes('new Error("Email sign-in failed - please try again.")'), "the rejection's value is kept, not replaced");
});

test("the email button shows the code, selectable, under the error - no em dash in the new lines", () => {
  assert.ok(button.includes("if (isSignInFailedError(e)) errorCode = e.code;"));
  assert.ok(button.includes('<p class="error-code">Code: <code>{errorCode}</code></p>'));
  assert.ok(button.includes("user-select: all;"));
  assert.ok(!button.includes("Sign-in failed —"), "the old em-dash line is gone");
});

// --- the passkey sheet ----------------------------------------------------------

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const IPAD_DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36";

test("an iPhone, an iPad posing as a Mac, a real Mac and Android", () => {
  assert.equal(appleTouchDevice(IPHONE, 5), "iPhone");
  assert.equal(appleTouchDevice(IPAD_DESKTOP_UA, 5), "iPad");
  assert.equal(appleTouchDevice(IPAD_DESKTOP_UA, 0), null, "a Mac has no touch screen");
  assert.equal(appleTouchDevice(ANDROID, 5), null);
});

test("the advice names the sheet, the exact Settings path and the way past More Options", () => {
  const s = passkeyCreateRefusedAdvice("iPhone", false);
  assert.match(s, /your iPhone said "Choose how to manage your passkeys"/);
  assert.match(s, /Settings › General › AutoFill & Passwords, turn on Passwords/);
  assert.match(s, /not More Options - that puts the passkey on another device or a security key/);
  assert.match(s, /If you closed the prompt yourself, just tap Create again\./);
  assert.match(s, /Continue with Email below/);
  assert.ok(!s.includes("—"), "owner copy: spaced hyphen, never an em dash");
});

test("an organiser invite offers no email, so the words never point at it", () => {
  const s = passkeyCreateRefusedAdvice("iPad", true);
  assert.match(s, /your iPad said/);
  assert.ok(!/email/i.test(s), s);
});

test("PasskeyLogin: the iOS advice is for a creation refused after a sheet, after noSheet and before the generic line", () => {
  const noSheet = passkeyButton.indexOf("} else if (res.noSheet) {");
  const ios = passkeyButton.indexOf(
    '} else if (mode === "create" && res.error?.name === "PasskeyCeremonyCancelledError" && (apple = appleDevice())) {',
  );
  const generic = passkeyButton.indexOf("Passkey authentication failed. Try again or use another method.");
  assert.ok(noSheet > 0 && ios > noSheet && generic > ios);
  assert.ok(passkeyButton.includes('passkeyCreateRefusedAdvice(apple, loginRequest.context === "invite")'));
  assert.ok(passkeyButton.includes("appleTouchDevice(navigator.userAgent, navigator.maxTouchPoints ?? 0)"));
});
