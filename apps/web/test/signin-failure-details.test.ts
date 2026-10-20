/**
 * "Show details" wherever a sign-in failure can be shown (signin-failure-notice.ts,
 * SignInFailureDetails.svelte). An iPhone, 2026-10-12: a redirect sign-in failed on
 * the page it came back to, the sheet's banner showed only a flattened line, and
 * the one thing that decides the fix - Web3Auth's own reason - had no way out.
 *
 * MUTATIONS (each went red, then restored): the store flattening the failure back
 * into a line; the banner not rendering the component; details shown without the
 * tap; the take not single-use; an over-long detail accepted; a second component
 * rendering its own code line.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, relative } from "node:path";

const { signInFailureView, postSignInFailure, takeSignInFailure, SIGN_IN_FAILURE_KEY } = await import(
  "../src/lib/auth/signin-failure-notice.ts"
);
const { SignInFailedError, SIGN_IN_FAILED_MESSAGE, markSignInStep, signInFailureCode } = await import(
  "../src/lib/auth/signin-failure.ts"
);

function tab() {
  const m = new Map<string, string>();
  return {
    map: m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

/** The iPhone's failure: Web3Auth's frame refusing with a sentence (here one with an email in it). */
function framesRefusal() {
  const reason = "Login was refused for someone@example.com because the session could not be verified here";
  const e = markSignInStep(reason, "connect", ["redirect", "r.b64", "r.nonce", "r.lp", "st.ready"]);
  return new SignInFailedError(signInFailureCode(e, { step: "connect", elapsedMs: 4000 }), e);
}

test("view: a coded failure keeps its code and Web3Auth's reason REDACTED; anything else is just its line", () => {
  const v = signInFailureView(framesRefusal());
  assert.equal(v.message, SIGN_IN_FAILED_MESSAGE);
  assert.match(v.code!, /^W3A-connect-Rejected~str\d+(?::[a-z+]+)?-t4-redirect-r\.b64-r\.nonce-r\.lp-st\.ready$/);
  assert.ok(v.detail && v.detail.includes("[email]") && !v.detail.includes("@"), "the email never reaches the screen");
  assert.deepEqual(signInFailureView(new Error("Sign-in was cancelled.")), { message: "Sign-in was cancelled.", code: null, detail: null });
});

test("post/take: whole, once, and nothing malformed or over-long gets through", () => {
  const s = tab();
  const v = signInFailureView(framesRefusal());
  postSignInFailure(s, v);
  assert.deepEqual(takeSignInFailure(s), v);
  assert.equal(takeSignInFailure(s), null, "single use");
  for (const raw of ["{not json", "null", "{}", JSON.stringify({ message: "" }), JSON.stringify({ message: 5 })]) {
    s.setItem(SIGN_IN_FAILURE_KEY, raw);
    assert.equal(takeSignInFailure(s), null, raw);
    assert.equal(s.map.has(SIGN_IN_FAILURE_KEY), false, "a bad entry is removed too");
  }
  s.setItem(SIGN_IN_FAILURE_KEY, JSON.stringify({ message: "x", code: "C", detail: "d".repeat(500), extra: "<script>" }));
  const t = takeSignInFailure(s)!;
  assert.ok(t.detail!.length <= 200, "never longer than the redaction writes");
  assert.deepEqual(Object.keys(t).sort(), ["code", "detail", "message"]);
  s.setItem(SIGN_IN_FAILURE_KEY, JSON.stringify({ message: "x", code: "C", detail: "refused for a@b.co at https://x.io/p" }));
  assert.equal(takeSignInFailure(s)!.detail, "refused for [email] at [link]", "redacted again on the way out");
  const broken = { getItem: () => { throw new Error("blocked"); }, removeItem: () => {} };
  assert.equal(takeSignInFailure(broken), null);
});

// --- the component, rendered for real (svelte/compiler + svelte/server) -----------

const here = fileURLToPath(new URL(".", import.meta.url));
const componentPath = join(here, "../src/lib/components/auth/SignInFailureDetails.svelte");
const { compile } = await import("svelte/compiler");
const { render } = await import("svelte/server");
// Inside the package, so the compiled module resolves `svelte/internal/server`; removed after.
const out = mkdtempSync(join(here, "../node_modules/.signin-failure-render-"));
test.after(() => rmSync(out, { recursive: true, force: true }));
const compiled = compile(readFileSync(componentPath, "utf8"), { generate: "server", filename: "SignInFailureDetails.svelte" });
const file = join(out, "SignInFailureDetails.js");
writeFileSync(file, compiled.js.code);
const Component = (await import(pathToFileURL(file).href)).default;
/** The rendered body, with Svelte's scoped class names and hydration markers left out. */
const html = (failure: unknown) =>
  render(Component, { props: { failure } })
    .body.replace(/ class="svelte-[a-z0-9]+"/g, "")
    .replace(/ svelte-[a-z0-9]+"/g, '"')
    .replace(/<!--[^>]*-->/g, "");

test("render: the code is shown, the details sit behind 'Show details', and a code-less failure is just its line", () => {
  const v = signInFailureView(framesRefusal());
  const shown = html(v);
  assert.match(shown, /Sign-in failed - please try again\./);
  assert.ok(shown.includes(`Code: <code>${v.code}</code>`));
  assert.match(shown, /<button[^>]*class="detail-btn[^"]*"[^>]*>Show details<\/button>/);
  assert.ok(!shown.includes("Details:"), "not before the tap");
  assert.ok(!shown.includes(v.detail!), "the reason is not in the page until asked for");

  const noDetail = html({ ...v, detail: null });
  assert.ok(noDetail.includes("Code:") && !noDetail.includes("Show details"));
  const plain = html({ message: "Sign-in was cancelled.", code: null, detail: null });
  assert.ok(plain.includes("Sign-in was cancelled.") && !plain.includes("Code:"));
});

// --- every place a sign-in failure is shown uses it -------------------------------

const src = join(here, "../src");
const read = (rel: string) => readFileSync(join(src, rel), "utf8");
function svelteFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? svelteFiles(p) : p.endsWith(".svelte") ? [p] : [];
  });
}

test("one component shows codes and details: no other component renders its own", () => {
  const own = svelteFiles(src)
    .filter((f) => !f.endsWith("SignInFailureDetails.svelte"))
    .filter((f) => /Code: <code>|>Show details</.test(readFileSync(f, "utf8")))
    .map((f) => relative(src, f));
  assert.deepEqual(own, []);
});

test("the email button and the sheet's banner (where a redirect's failure lands) both render it, reset per failure", () => {
  const button = read("lib/components/auth/Web3AuthLogin.svelte");
  assert.match(button, /failure = signInFailureView\(e\);/);
  assert.match(button, /\{#key failure\}\s*<SignInFailureDetails \{failure\} \/>\s*\{\/key\}/);
  const modal = read("lib/components/auth/LoginModal.svelte");
  assert.match(modal, /const posted = takeSignInFailure\(globalThis\.sessionStorage\);/);
  assert.match(modal, /\{#if failure && !authing\}\s*<div class="notice notice--failure" role="alert">\s*\{#key failure\}\s*<SignInFailureDetails \{failure\} \/>/);
  assert.equal(modal.split("failure = null;").length - 1, 3, "cleared on close, on success and when a new attempt starts");
  const start = modal.slice(modal.indexOf("function start(method: Method, create = false) {"), modal.indexOf("function settle()"));
  assert.ok(start.includes("failure = null;"), "a new attempt never sits under an old failure");
});

test("the redirect finish posts the failure whole - never flattened into a line without its details", () => {
  const store = read("lib/auth/auth-store.svelte.ts");
  const finish = store.slice(store.indexOf("async function _finishWeb3AuthRedirect("), store.indexOf("async function _runWeb3AuthSignIn("));
  assert.match(finish, /postSignInFailure\(globalThis\.sessionStorage, signInFailureView\(e\)\);/);
  assert.ok(!/Code: \$\{/.test(store), "no code flattened into a notice anywhere");
});
