/**
 * Account & security (`#/account`): the account's own controls, moved off the
 * Profile tab. Source scans, as for the other screens: the router declares
 * `$state`, so Node cannot import it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { UNLOCK_RULE } from "../src/lib/attendee/gate/unlock-copy.js";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const markupOf = (src: string) => src.slice(src.indexOf("</script>"));
const flat = (s: string) => s.replace(/\s+/g, " ");

const ROUTER = read("../src/lib/router/router.svelte.ts");
const APP = read("../src/AttendeeApp.svelte");
const PAGE = read("../src/lib/components/account/AccountSecurity.svelte");
const PROFILE = read("../src/lib/components/profile/ProfilePage.svelte");
const PASSKEYS = read("../src/lib/components/passkeys/YourPasskeys.svelte");

test("/account is the page, and /passkeys still opens it", () => {
  assert.match(ROUTER, /if \(path === "\/account" \|\| path === "\/passkeys"\) return \{ route: "account", params: \{\}, surface: "attendee" \};/);
  assert.doesNotMatch(ROUTER, /route: "passkeys"/, "one page, not two");
  assert.match(APP, /const loadAccountSecurity = \(\) => import\("\.\/lib\/components\/account\/AccountSecurity\.svelte"\);/);
  assert.match(APP, /\{:else if router\.route === "account"\}\s*<LazyRoute loader=\{loadAccountSecurity\} \/>/);
  assert.doesNotMatch(APP, /^\s*import\s+AccountSecurity/m, "loaded only when opened");
});

test("the page: sign-in, passkeys for passkey accounts, then sessions - and nothing asks on open", () => {
  const m = markupOf(PAGE);
  assert.match(m, /<h1>Account & security<\/h1>/);
  const order = ['id="signin-title"', "<YourPasskeys />", 'id="sessions-title"'].map((s) => m.indexOf(s));
  assert.ok(order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1])), "sections in order");
  assert.match(m, /\{#if auth\.kind === "passkey"\}\s*<YourPasskeys \/>/);
  assert.doesNotMatch(PAGE, /ensureAccountSetup|ensureSession|ensureContentSigner|ensureIdentitySeed/);
  assert.doesNotMatch(PAGE.slice(0, PAGE.indexOf("</script>")), /loginRequest\.request\(/, "sign-in only on a tap");
  assert.doesNotMatch(PAGE, /href="#\//);
});

test("Profile keeps one link to the page, on your own profile only", () => {
  assert.doesNotMatch(PROFILE, /revokeAllSessions|\/api\/auth\/revoke-all|navigate\("\/passkeys"\)/);
  assert.doesNotMatch(PROFILE, /Session security|Sign-in method/);
  const m = markupOf(PROFILE);
  const link = m.indexOf('navigate("/account")');
  assert.ok(link > 0);
  assert.equal(m.split('navigate("/account")').length - 1, 1, "one link");
  // The Profile tab's body renders inside {#if isOwner}.
  assert.ok(link > m.indexOf('{#if activeTab === "profile"}') && link < m.indexOf('{#if activeTab === "passport"}'));
  assert.ok(m.indexOf("{#if isOwner}\n\n    {#if activeTab") < m.indexOf('{#if activeTab === "profile"}'));
});

test("one passkey: the backup callout; more: a calm count - both behind the server's answer", () => {
  assert.match(PASSKEYS, /const fullPasskeys = \$derived\(rows\.filter\(\(r\) => !r\.linkedBefore\)\.length\);/);
  const m = markupOf(PASSKEYS);
  const backup = m.slice(m.indexOf('id="backup-title"'), m.indexOf('id="devices-title"'));
  assert.match(backup, /\{#if fullPasskeys <= 1\}\s*<p class="callout-title">Add a backup passkey<\/p>/);
  assert.match(flat(backup), /Save a second passkey in another password manager - like Google Password Manager or 1Password - so losing one never locks you out\./);
  assert.match(backup, /You have \{fullPasskeys\} passkeys\./);
  // The button opens the existing add flow; locked, the unlock line instead.
  assert.match(backup, /\{#if !canAdd\}\s*<p class="muted">\{unlocksWhen\("Adding devices and password managers", true\)\}<\/p>\s*\{:else\}/);
  assert.match(backup, /onclick=\{\(\) => \{ adding = "explain"; addError = null; \}\}/);
  const devices = m.slice(m.indexOf('id="devices-title"'));
  assert.match(devices, /onclick=\{\(\) => \{ linkMode = "link"; linking = true; \}\} disabled=\{busy\}>Add a device<\/button>/);
  // Shown only with no flow open, never on a device linked the old way.
  assert.match(m, /\{#if auth\.isConnected && isPasskey && loaded && !linkedOnly && !linking && adding === "closed"\}\s*<section class="block" aria-labelledby="backup-title">/);
});

test("the device flows name the real path", () => {
  const linkThis = flat(read("../src/lib/components/passkeys/LinkThisDevice.svelte"));
  assert.match(linkThis, /open WoCo and go to Account & security, then tap Add a device\. Scan this code, or type it there:/);
  assert.match(linkThis, /navigate\("\/account"\)\}>Account & security<\/button>/);
  assert.doesNotMatch(linkThis, /go to Your passkeys|Add another device/);
  const linkAnother = flat(read("../src/lib/components/passkeys/LinkAnotherDevice.svelte"));
  assert.match(linkAnother, /first open woco\.eth\.limo on the laptop, tap Sign in, then Add this device\./);
  const devices = flat(markupOf(PASSKEYS).slice(markupOf(PASSKEYS).indexOf('id="devices-title"')));
  assert.match(devices, /Just sign in there - nothing to add\./);
  assert.match(devices, /tap Sign in, then 'Add this device'\. Then tap Add a device here and scan the code it shows\./);
  assert.match(read("../src/lib/creator/home/CreatorHome.svelte"), /navigate\("\/account"\)\}>Account & security →<\/button>/);
});

test("the after-creation note points at Account & security with the real unlock rule", () => {
  const login = flat(read("../src/lib/components/auth/PasskeyLogin.svelte"));
  assert.match(login, /from Account & security\./);
  assert.ok(login.includes(`That unlocks ${UNLOCK_RULE}.`), "the note says the rule the server applies");
});

test("no em dash in the moved and reworded copy", () => {
  for (const file of [
    "../src/lib/components/account/AccountSecurity.svelte",
    "../src/lib/components/passkeys/YourPasskeys.svelte",
    "../src/lib/components/passkeys/LinkThisDevice.svelte",
    "../src/lib/components/passkeys/LinkAnotherDevice.svelte",
  ]) {
    assert.doesNotMatch(markupOf(read(file)), /—/, file);
  }
});
