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
  assert.ok(body.includes('<Web3AuthLogin oncomplete={handleComplete} onstart={() => start("email")} onsettle={settle} inApp={null} />'));
  assert.equal(modal.split("<Web3AuthLogin").length - 1, 2, "one for a real browser, one for an in-app one - never a second copy");
});

test("default order: passkey, its error, email / Google, the ready notice, then create / add device / help, then Secured by", () => {
  const { full } = branches();
  const at = (needle: string) => {
    const i = full.indexOf(needle);
    assert.ok(i > 0, needle);
    return i;
  };
  const order = [
    at('onclick={() => run("signin")}'),
    at("{#if error && !otherDevice}"),
    at("{@render alternative?.()}"),
    at("<PasskeyReadyNotice invite={organiser} />"),
    at('<div class="more">'),
    at('onclick={() => run("create")}'),
    at("onclick={onlink}"),
    at('class="help-link"'),
    at('<div class="providers">'),
    at('<p class="hint">'),
  ];
  for (let i = 1; i < order.length; i++) assert.ok(order[i]! > order[i - 1]!, `step ${i} is out of order`);
  assert.equal(full.split("{@render alternative?.()}").length - 1, 1);
  assert.equal(full.split("{#if error && !otherDevice}").length - 1, 1, "the error line is not repeated at the bottom");
});

test("Create stays secondary: an outlined small button, emphasised only after a sign-in found nothing", () => {
  const { full } = branches();
  assert.match(full, /<button\s+class="create-btn"\s+class:emphasised=\{offerCreate\}\s+onclick=\{\(\) => run\("create"\)\}/);
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

test("on a phone the two choices come first: nothing tall sits above the email button by default", () => {
  // The modal's header and gaps fixed (LoginModal <style>), the passkey button and
  // the email button are the first two things in the picker; only an error the
  // person just caused can come between them.
  const { full } = branches();
  const between = full.slice(full.indexOf("</button>"), full.indexOf("{@render alternative?.()}"));
  const shown = between.replace(/<!--[\s\S]*?-->/g, "").replace(/\{#if error && !otherDevice\}[\s\S]*?\{\/if\}/, "").trim();
  assert.equal(shown, "</button>", `only the error line may sit between them: ${shown}`);
});
