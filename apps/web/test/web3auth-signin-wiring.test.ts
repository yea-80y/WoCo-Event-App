/**
 * Where the #803 rules sit in the Web3Auth call sites. The behaviour is
 * unit-tested in web3auth-survivor.test.ts; what those tests cannot see is that
 * every explicit sign-in goes through the fresh-instance rule, and that the boot
 * restore reads a session still loading as transient.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const account = read("../src/lib/auth/web3auth-account.ts");
const backup = read("../src/lib/wallet/backup-signer.ts");
const config = read("../src/lib/auth/web3auth-config.ts");

function body(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `${signature} must exist`);
  const end = src.indexOf("\nexport async function ", start + 10);
  return src.slice(start, end < 0 ? undefined : end);
}

test("primary sign-in: survivors are ended through the fresh-instance rule, before connect()", () => {
  const login = body(account, "export async function loginWithWeb3Auth(");
  const rule = login.indexOf("w = await instanceForExplicitSignIn(w,");
  const connect = login.indexOf("await w.connect()");
  assert.ok(rule > 0 && connect > rule, "connect() only on the instance the rule hands back");
  assert.ok(!login.includes("endSurvivingWeb3AuthSession("), "never end a survivor and keep the instance");
});

test("backup sign-in: the same rule, and connect() on the instance it hands back", () => {
  const connect = body(backup, "export async function connectWeb3AuthBackup(");
  const rule = connect.indexOf("await instanceForExplicitSignIn(asSurvivor(web3auth), async () => asSurvivor(await build()))");
  const swap = connect.indexOf("web3auth = ready as unknown as Instance;");
  const open = connect.indexOf("provider = await web3auth.connect();");
  assert.ok(rule > 0 && swap > rule && open > swap, "connect() runs on the instance the rule returned");
  assert.ok(!connect.includes("endSurvivingWeb3AuthSession("), "never end a survivor and keep the instance");
});

test("boot restore: a session still loading returns unavailable before any expired verdict", () => {
  const restore = body(account, "export async function restoreWeb3AuthSession(");
  const verdict = restore.indexOf("const verdict = restoreVerdict(rehydration, isWeb3AuthSessionLive(w) && !!w.provider);");
  const unavailable = restore.indexOf('if (verdict === "unavailable") {', verdict);
  const expired = restore.indexOf('if (verdict === "expired" || !w.provider) {', verdict);
  assert.ok(verdict > 0 && unavailable > verdict && expired > unavailable);
  assert.ok(
    restore.slice(unavailable, expired).includes('return { status: "unavailable" };'),
    "still loading keeps the session (the caller retries)",
  );
});

test("every instance asks for the 30-day session, the SDK's maximum", async () => {
  const { WEB3AUTH_SESSION_SECONDS } = await import("../src/lib/auth/web3auth-config.js");
  assert.equal(WEB3AUTH_SESSION_SECONDS, 30 * 86400);
  const options = config.slice(config.indexOf("export function buildWeb3AuthOptions("));
  assert.ok(options.includes("sessionTime: WEB3AUTH_SESSION_SECONDS,"), "unset = the dashboard's 1 day");
});

const store = read("../src/lib/auth/auth-store.svelte.ts");
const button = read("../src/lib/components/auth/Web3AuthLogin.svelte");
const gate = read("../src/lib/creator/gate/OrganiserNeedsPasskey.svelte");

test("the store passes Web3Auth's own outcomes through instead of a bare false", () => {
  const start = store.indexOf("async function loginWeb3Auth(");
  const fn = store.slice(start, store.indexOf("\nasync function ", start + 10));
  assert.ok(fn.includes("if (isOrphanedCredentialError(e) || isWeb3AuthSignInError(e)) throw e;"));
});

test("a missing Web3Auth key tells the person what to do, never a developer string", () => {
  assert.ok(!store.includes("Web3Auth key unavailable"), "no raw key message reaches the screen");
  assert.equal(store.split("throw _web3authKeyMissing();").length - 1, 3);
  assert.ok(
    store.includes("return new Error(_web3authKeyRetrying ? WEB3AUTH_KEY_LOADING_MESSAGE : WEB3AUTH_KEY_GONE_MESSAGE);"),
    "while the reload's retry runs, the key is loading - not gone",
  );
});

test("the retry flag is cleared on every way the background retry stops", () => {
  const start = store.indexOf("function _retryWeb3AuthKeyInBackground(");
  const fn = store.slice(start, store.indexOf("\nfunction ", start + 10));
  assert.equal(fn.split("_web3authKeyRetrying = true;").length - 1, 1);
  // two early exits + adopt + stop + clear + attempts exhausted
  assert.equal(fn.split("_web3authKeyRetrying = false;").length - 1, 6);
  assert.ok(fn.includes("else _web3authKeyRetrying = false;"), "giving up stops saying 'loading'");
  const clear = store.slice(store.indexOf("async function clearAllAuth("));
  assert.ok(clear.includes("_web3authKeyRetrying = false;"), "sign-out resets it");
});

test("the backup flow closes the modal as soon as connect() settles, and passes 'still loading' through", () => {
  const connect = body(backup, "export async function connectWeb3AuthBackup(");
  const open = connect.indexOf("provider = await web3auth.connect();");
  const close = connect.indexOf("  } finally {\n    closeModal();\n  }", open);
  const extract = connect.indexOf("extractRawPrivateKey(provider)");
  assert.ok(open > 0 && close > open && extract > close, "closed before anything else runs");
  assert.ok(connect.includes("if (e instanceof Error && e.message === SURVIVOR_STILL_LOADING_MESSAGE) throw e;"));
});

test("the sign-in button stays quiet on a cancel and shows every other outcome", () => {
  const quiet = button.indexOf("if (isWeb3AuthSignInError(e) && e.cancelled) {");
  const shown = button.indexOf("} else if (!isOrphanedCredentialError(e)) {", quiet);
  assert.ok(quiet > 0 && shown > quiet);
  assert.ok(button.slice(quiet, shown).includes("error = null;"));
});

test("the organiser gate shows a sign-out refusal instead of silently resetting", () => {
  const logout = gate.indexOf("await auth.logout();");
  const caught = gate.indexOf("} catch (e) {", logout);
  const login = gate.indexOf("loginRequest.request(", logout);
  assert.ok(logout > 0 && caught > logout && login > caught, "a failed sign-out never opens the passkey sheet");
  assert.ok(gate.slice(caught, login).includes("return;"));
  assert.ok(gate.includes('{#if error}<p class="error" role="alert">{error}</p>{/if}'));
});

test("both of the SDK's ways of backing out count as a cancel", async () => {
  const { isWeb3AuthCancel } = await import("../src/lib/auth/web3auth-signin-error.js");
  assert.equal(isWeb3AuthCancel(new Error("User closed the modal")), true);
  assert.equal(isWeb3AuthCancel(Object.assign(new Error("Wallet popup has been closed by the user"), { code: 5114 })), true);
  assert.equal(isWeb3AuthCancel(Object.assign(new Error("Failed to connect"), { code: 5111 })), false);
  assert.equal(isWeb3AuthCancel("User closed the modal"), false);
});
