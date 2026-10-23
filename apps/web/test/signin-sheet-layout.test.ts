/**
 * The sign-in sheet's layout (owner, 2026-10-20): the email / Google sign-in is
 * a real choice, so it sits right under the passkey button, before the
 * secondary ways in (create, add a device, can't find it) and the "Secured by"
 * footer - and a long "this iPhone can't save passkeys" notice never pushes it
 * off a phone screen.
 *
 * TEXT checks on source order: the repo has no component-test harness and this
 * suite runs under plain tsx (login-surface-registration.test.ts says why).
 *
 * MUTATION: move `{@render alternative?.()}` below the Create button, or the
 * ready notice above it, and the order test goes red; drop the `{:else if
 * checked}` branch and a browser without passkeys loses its only sign-in.
 *
 * The first-visit pair (owner + Fable 10-22, sign-in-hint.ts): with nothing known
 * about the device, Sign in and Create sit side by side ABOVE the email button -
 * a deliberate change to the 10-20 rule "email right under the passkey button",
 * which still holds for a device that has signed in before. MUTATION: give Create
 * the fill outside an invite, drop a sub-line, or show the small Create beside
 * the pair, and "the first-visit pair" goes red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const markup = (src: string) => src.slice(src.indexOf("</script>"), src.indexOf("<style>"));
const modal = read("../src/lib/components/auth/LoginModal.svelte");
const passkey = markup(read("../src/lib/components/auth/PasskeyLogin.svelte"));
const email = read("../src/lib/components/auth/Web3AuthLogin.svelte");
const emailMarkup = markup(email);

/** The full branch's sign-in block: the first-visit pair, then the single button. */
function signInBlock(full: string) {
  const open = full.indexOf('{#if sheet === "new"}');
  const single = full.indexOf("{:else}", open);
  // The block's own closing tag, at its indent (the tag inside the button has its own).
  const close = full.indexOf("\n    {/if}\n", single) + 1;
  assert.ok(open > 0 && single > open && close > single, "pair, then single");
  return { pair: full.slice(open, single), single: full.slice(single, close), after: full.slice(close) };
}

/** PasskeyLogin's branches, in source order. */
function branches() {
  const stays = passkey.indexOf("{#if supported && stays}");
  const full = passkey.indexOf("{:else if supported}", stays);
  const organiser = passkey.indexOf("{:else if checked && organiser}", full);
  const none = passkey.indexOf("{:else if checked}", organiser);
  const end = passkey.indexOf("{/if}", passkey.lastIndexOf("{@render alternative?.()}"));
  assert.ok(stays > 0 && full > stays && organiser > full && none > organiser && end > none, "four branches");
  return {
    stays: passkey.slice(stays, full),
    full: passkey.slice(full, organiser),
    organiser: passkey.slice(organiser, none),
    none: passkey.slice(none, end),
  };
}

test("the modal hands the email sign-in to PasskeyLogin as its `alternative`, with the organiser guard inside", () => {
  const open = modal.indexOf("<PasskeyLogin");
  const close = modal.indexOf("</PasskeyLogin>", open);
  const body = modal.slice(open, close);
  assert.ok(open > 0 && close > open, "PasskeyLogin takes children now");
  const snippet = body.indexOf("{#snippet alternative()}");
  const guard = body.indexOf("{#if !organiserSignIn}", snippet);
  const button = body.indexOf("<Web3AuthLogin", guard);
  assert.ok(snippet > 0 && guard > snippet && button > guard, "snippet, then the guard, then the button");
  assert.ok(body.includes('<Web3AuthLogin oncomplete={handleComplete} onstart={() => start("email")} onsettle={settle} inApp={null} lastUsed={sheet === "email"} onexpand={() => (view = "email")} />'));
  // The two entry buttons open WoCo's email screen, the third copy (owner 2026-10-22).
  assert.equal(modal.split("<Web3AuthLogin").length - 1, 3, "a real browser's entry, an in-app one's, and the email screen - never a fourth");
  assert.equal(modal.split("<Web3AuthLogin panel").length - 1, 1, "one email screen");
});

test("default order: passkey, its error, email / Google, the ready notice, then create / add device / help, then Secured by", () => {
  const { full } = branches();
  const { single } = signInBlock(full);
  const at = (needle: string, from = 0) => {
    const i = full.indexOf(needle, from);
    assert.ok(i > 0, needle);
    return i;
  };
  const singleAt = full.indexOf(single);
  const order = [
    at('onclick={() => run("signin")}', singleAt),
    at("{#if error && !otherDevice}"),
    at("{@render alternative?.()}"),
    at("<PasskeyReadyNotice invite={organiser} />"),
    at('<div class="more">'),
    at('{#if sheet !== "new"}'),
    at('onclick={() => run("create")}', at('<div class="more">')),
    at("onclick={onlink}"),
    at('class="help-link"'),
    at('<div class="providers">'),
    at('<p class="hint">'),
  ];
  for (let i = 1; i < order.length; i++) assert.ok(order[i]! > order[i - 1]!, `step ${i} is out of order`);
  assert.equal(full.split("{@render alternative?.()}").length - 1, 1);
  assert.equal(full.split("{#if error && !otherDevice}").length - 1, 1, "the error line is not repeated at the bottom");
});

test("a device that has signed in before: Create stays secondary - an outlined small button, emphasised only after a sign-in found nothing", () => {
  const { full } = branches();
  assert.match(full, /\{#if sheet !== "new"\}\s*<button\s+bind:this=\{createLink\}\s+class="create-btn"\s+class:emphasised=\{offerCreate\}\s+onclick=\{\(\) => run\("create"\)\}/);
  const style = read("../src/lib/components/auth/PasskeyLogin.svelte").split("<style>")[1]!;
  assert.match(style, /\.create-btn \{[^}]*background: transparent;[^}]*color: var\(--text-muted\);/);
});

test("a browser with no passkeys still gets the email sign-in; the signed-in 'Got it' panel does not", () => {
  const { stays, organiser, none } = branches();
  assert.ok(none.includes("{@render alternative?.()}"), "no passkeys: email is all there is");
  assert.ok(!stays.replace(/<!--[\s\S]*?-->/g, "").includes("{@render alternative"), "never beside Got it");
  assert.ok(!organiser.includes("{@render alternative"), "an organiser is never offered email");
});

test("the email button names what it is: email or social, with the best-known marks and + more", () => {
  assert.ok(emailMarkup.includes("Continue with email or social"));
  assert.ok(!emailMarkup.includes("Continue with Email"));
  assert.ok(!emailMarkup.includes("Continue with email or Google"));
  const start = emailMarkup.indexOf('<span class="w3a-icons" aria-hidden="true">');
  const icons = emailMarkup.slice(start, emailMarkup.indexOf("</button>", start));
  assert.equal(icons.split("<svg").length - 1, 5, "mail, Google, Apple, Facebook and X");
  assert.ok(icons.includes('<span class="w3a-more">+ more</span>'), "the modal offers more than the marks show");
  assert.ok(emailMarkup.indexOf("Continue with email or social") < start, "label first, marks under it");
  assert.match(email, /\.w3a-btn--main \{\s*flex-direction: column;/, "label and marks stacked");
});

test("the email hint is gone outside an app's browser; the in-app line and the stalled panel stay", () => {
  assert.ok(!email.includes("Use your email address or Google account"));
  assert.match(emailMarkup, /\{#if inApp\}\s*<p class="hint">Email or social sign-in may not complete in this browser\.<\/p>\s*\{\/if\}/);
  assert.ok(emailMarkup.includes("<p class=\"stalled-title\">Still waiting for your sign-in to come back</p>"));
  assert.ok(emailMarkup.includes('<button type="button" class="w3a-btn" onclick={retry}>Try again</button>'), "Try again keeps the plain button");
});

test("the secondary lines read as one group, with no em dash in the new words", () => {
  const { full } = branches();
  for (const line of ["New to WoCo? Create a passkey account", "Already use WoCo on another device? Add this device", "Can't find your passkey?"]) {
    assert.ok(full.includes(line), line);
  }
  assert.ok(!full.includes("Already use WoCo on your phone?"));
  for (const text of [emailMarkup.slice(emailMarkup.indexOf("w3a-btn--main"), emailMarkup.indexOf("{#if failure}")), full.slice(full.indexOf('<div class="more">'), full.indexOf('<div class="providers">'))]) {
    assert.ok(!text.replace(/<!--[\s\S]*?-->/g, "").includes("—"), "spaced hyphen, never an em dash");
  }
});

test("on a phone the choices come first: nothing tall sits between the passkey buttons and the email button", () => {
  // The modal's header and gaps fixed (LoginModal <style>), the passkey button(s) and
  // the email button are the first things in the picker; only an error the person
  // just caused can come between them.
  const { full } = branches();
  const { after } = signInBlock(full);
  const between = after.slice(0, after.indexOf("{@render alternative?.()}"));
  const shown = between.replace(/<!--[\s\S]*?-->/g, "").replace(/\{#if error && !otherDevice\}[\s\S]*?\{\/if\}/, "").trim();
  assert.equal(shown, "{/if}", `only the error line may sit between them: ${shown}`);
});

test("the first-visit pair: Sign in filled over an equal outlined Create, each saying who it is for; an invite flips the fill", () => {
  const { pair, single } = signInBlock(branches().full);
  const signin = pair.indexOf('onclick={() => run("signin")}');
  const create = pair.indexOf('onclick={() => run("create")}');
  assert.ok(signin > 0 && create > signin, "Sign in above Create");
  assert.match(pair, /<button class="passkey-btn choice" class:outlined=\{newAccountFirst\} onclick=\{\(\) => run\("signin"\)\}/);
  assert.match(pair, /<button bind:this=\{createChoice\} class="passkey-btn choice" class:outlined=\{!newAccountFirst\} onclick=\{\(\) => run\("create"\)\}/);
  // The sub-lines are INSIDE the buttons: part of each one's accessible name.
  for (const [label, sub] of [["Sign in with Passkey", "I already have a WoCo passkey"], ["Create an account", "New to WoCo"]]) {
    const at = pair.indexOf(sub);
    assert.ok(pair.indexOf(label) > 0 && at > pair.indexOf(label) && pair.indexOf("</button>", at) > at, sub);
  }
  assert.ok(!single.includes('run("create")'), "the single button is Sign in only");
  assert.match(single, /\{#if sheet === "known"\}<span class="last-used">Last used<\/span>\{\/if\}/, "a known device tags it");
  const style = read("../src/lib/components/auth/PasskeyLogin.svelte").split("<style>")[1]!;
  assert.match(style, /\.passkey-btn\.choice \{[^}]*min-height: 3\.75rem;/, "one height");
  assert.match(style, /\.passkey-btn\.choice \{[^}]*text-align: center;/, "centred like the other buttons");
  assert.doesNotMatch(style, /\.passkey-btn\.choice \{[^}]*justify-content: flex-start;/, "not pushed to the left");
  assert.match(style, /\.passkey-btn\.outlined \{[^}]*background: transparent;/);
});

test("a sign-in that found nothing moves focus to the create choice the sheet shows, and the copy has no em dash", () => {
  const src = read("../src/lib/components/auth/PasskeyLogin.svelte");
  const branch = src.slice(src.indexOf('} else if (res.noAssertion && mode === "signin") {'), src.indexOf("} else if (mode === \"create\""));
  assert.ok(branch.includes('void tick().then(() => (sheet === "new" ? createChoice : createLink)?.focus());'));
  assert.ok(branch.includes("No passkey was used. If you cancelled, try again - if you're new to WoCo, create an account below."));
  assert.ok(!branch.includes("—"));
});

test("the modal: one hint per opening, its layout from sheetState, 'Welcome back' only under no context heading, email tagged only in the email layout", () => {
  assert.ok(modal.includes("const sheet = $derived(hint ? sheetState(hint, organiserSignIn) : \"new\");"));
  assert.ok(modal.includes("void readSignInHint().then((h) => {"));
  const heading = modal.slice(modal.indexOf('<h2 id="login-title">'), modal.indexOf("</h2>"));
  const order = ['"Signing in"', '"Connect a wallet"', '"Create your account"', '"Add your ticket"', '"Organiser sign in"', 'sheet === "known" ? "Welcome back"', ': "Sign in"'].map((n) => heading.indexOf(n));
  for (let i = 0; i < order.length; i++) assert.ok(order[i]! > 0 && (i === 0 || order[i]! > order[i - 1]!), `heading step ${i}`);
  assert.ok(modal.includes('aria-labelledby="login-title"') && !modal.includes('aria-label="Login"'), "the dialog is named by what it says");
  assert.ok(modal.includes('<p class="context-sub">Organisers sign in with a passkey.</p>'), "'New here?' is the Create button now");
  assert.match(modal, /<PasskeyLogin\s+organiser=\{organiserSignIn\}\s+\{sheet\}\s+newAccountFirst=\{loginRequest\.context === "invite"\}/);
  assert.match(email, /<span class="w3a-label">Continue with email or social\{#if lastUsed\}<span class="last-used">Last used<\/span>\{\/if\}<\/span>/);
});
