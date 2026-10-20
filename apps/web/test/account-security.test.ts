/**
 * Account & security (`#/account`): the account's own controls, moved off the
 * Profile tab. Source scans, as for the other screens: the router declares
 * `$state`, so Node cannot import it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { UNLOCK_RULE } from "../src/lib/attendee/gate/unlock-copy.js";
import { isCarriableRoute } from "../src/lib/browser/in-app-route.js";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const markupOf = (src: string) => src.slice(src.indexOf("</script>"));
const flat = (s: string) => s.replace(/\s+/g, " ");

const ROUTER = read("../src/lib/router/router.svelte.ts");
const APP = read("../src/AttendeeApp.svelte");
const PAGE = read("../src/lib/components/account/AccountSecurity.svelte");
const PROFILE = read("../src/lib/components/profile/ProfilePage.svelte");
const PASSKEYS = read("../src/lib/components/passkeys/YourPasskeys.svelte");

test("/account is the page, and /passkeys still opens it", () => {
  assert.match(ROUTER, /if \(path === "\/account" \|\| path === "\/passkeys"\) \{\s*const addDevice = new URLSearchParams\(query\)\.has\("add-device"\);\s*return \{ route: "account", params: addDevice \? \{ addDevice: "1" \} : \{\}, surface: "attendee" \};/);
  assert.doesNotMatch(ROUTER, /route: "passkeys"/, "one page, not two");
  assert.match(APP, /const loadAccountSecurity = \(\) => import\("\.\/lib\/components\/account\/AccountSecurity\.svelte"\);/);
  assert.match(APP, /\{:else if router\.route === "account"\}\s*<LazyRoute loader=\{loadAccountSecurity\} \/>/);
  assert.doesNotMatch(APP, /^\s*import\s+AccountSecurity/m, "loaded only when opened");
});

test("the page: sign-in, passkeys for passkey accounts, then sessions - and nothing asks on open", () => {
  const m = markupOf(PAGE);
  assert.match(m, /<h1>Account & security<\/h1>/);
  const order = ['id="signin-title"', "<YourPasskeys bind:addDevice />", 'id="sessions-title"'].map((s) => m.indexOf(s));
  assert.ok(order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1])), "sections in order");
  assert.match(m, /\{#if auth\.kind === "passkey"\}\s*<YourPasskeys bind:addDevice \/>/);
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
  assert.match(PASSKEYS, /const sectionsShown = \$derived\(auth\.isConnected && isPasskey && loaded && !linkedOnly && !linking && adding === "closed"\);/);
  assert.match(m, /\{#if sectionsShown\}\s*<section class="block" aria-labelledby="backup-title">/);
});

test("the device flows name the real path", () => {
  const linkThis = flat(read("../src/lib/components/passkeys/LinkThisDevice.svelte"));
  assert.match(linkThis, /On your phone, open WoCo, then tap Profile, Account & security, Add a device, Scan the code\. Point it at this code, or type the code there\./);
  assert.match(linkThis, /Your phone's own camera app can't read this code - use the scanner inside WoCo\./);
  assert.doesNotMatch(linkThis, /go to Account & security|Scan this code, or type it there/);
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
    "../src/lib/components/passkeys/PairingCode.svelte",
  ]) {
    assert.doesNotMatch(markupOf(read(file)), /—/, file);
  }
});

// Fable design consult 2026-10-20, items 1-2: the new device's waiting screen, and
// the phone's shortcut from Profile straight to the scanner.

const LINK_THIS = read("../src/lib/components/passkeys/LinkThisDevice.svelte");
const PAIRING_CODE = read("../src/lib/components/passkeys/PairingCode.svelte");
const IN_APP_ROUTE = read("../src/lib/browser/in-app-route.ts");

test("waiting screen: the path on the phone, and that only WoCo's scanner reads the code", () => {
  const m = markupOf(LINK_THIS);
  const waiting = flat(m.slice(m.indexOf('{:else if stage === "waiting"}'), m.indexOf('{:else if stage === "linking"}')));
  assert.match(
    waiting,
    /<p class="muted"> On your phone, open WoCo, then tap Profile, Account & security, Add a device, Scan the code\. Point it at this code, or type the code there\. <\/p> <p class="muted">Your phone's own camera app can't read this code - use the scanner inside WoCo\.<\/p> \{#if code\}<PairingCode/,
  );
});

test("the typed code is as big as the QR, wraps only between groups, and copies as itself", () => {
  const m = markupOf(PAIRING_CODE);
  assert.match(PAIRING_CODE, /const groups = \$derived\(typed\.split\("-"\)\);/);
  assert.match(m, /<p class="code">\{#each groups as g, i\}\{#if i > 0\}-<wbr \/>\{\/if\}<span class="group">\{g\}<\/span>\{\/each\}<\/p>/);
  const code = m.slice(m.indexOf("  .code {"), m.indexOf("}", m.indexOf("  .code {")));
  assert.match(code, /max-width: min\(16rem, 100%\);/, "the QR's width: fits a 320px screen");
  assert.match(code, /font-size: 1\.75rem;/);
  assert.doesNotMatch(code, /user-select: none|word-break/);
  assert.match(m, /\.group \{\s*white-space: nowrap;\s*\}/);
  // Tokens only.
  assert.doesNotMatch(m.slice(m.indexOf("<style>")), /#[0-9a-fA-F]{3,8}\b|rgb\(/);
});

test("Profile: 'Add a device' beside Account & security, own profile and passkey accounts only", () => {
  const m = markupOf(PROFILE);
  const account = m.indexOf('navigate("/account")');
  const row = m.indexOf('navigate("/account?add-device")');
  assert.equal(m.split('navigate("/account?add-device")').length - 1, 1, "one shortcut");
  // Right after the Account & security row, in the same card: inside {#if isOwner}.
  assert.ok(row > account && row < m.indexOf('{#if activeTab === "passport"}'));
  assert.ok(row < m.indexOf("InstallAppRow", account), "beside it, before the install row");
  const between = flat(m.slice(account, row));
  assert.match(between, /<\/button> <\/div> <!--[^>]*--> \{#if auth\.kind === "passkey"\} <div class="info-row account-row"> <button class="account-link" onclick=\{\(\) => $/);
  assert.match(flat(m.slice(row)), /^navigate\("\/account\?add-device"\)\}> <span>Add a device<\/span> <span class="account-link-arrow" aria-hidden="true">→<\/span> <\/button> <\/div> \{\/if\}/);
});

test("the flag: taken once by Account & security, replaced out of the address, never a code", () => {
  // The router exposes it as a route param, like ?announce and ?gt.
  assert.match(ROUTER, /return \{ route: "account", params: addDevice \? \{ addDevice: "1" \} : \{\}, surface: "attendee" \};/);
  // Replaced, not pushed: Back and a reload land on plain #/account.
  assert.match(
    ROUTER,
    /export function replaceRoute\(path: string\) \{\s*window\.history\.replaceState\(window\.history\.state, "", new URL\(`#\$\{path\}`, window\.location\.href\)\.href\);\s*update\(\);\s*\}/,
  );
  assert.match(
    PAGE,
    /let addDevice = \$state\(false\);\s*\$effect\(\(\) => \{\s*if \(router\.params\.addDevice !== "1"\) return;\s*addDevice = true;\s*replaceRoute\("\/account"\);\s*\}\);/,
  );
  assert.doesNotMatch(PAGE, /navigate\("\/account/, "navigate() would push a history entry Back returns to");
  // Spent by the screen once its first read answers, whatever the answer.
  assert.match(PASSKEYS, /let \{ addDevice = \$bindable\(false\) \}: \{ addDevice\?: boolean \} = \$props\(\);/);
  // No pairing code in any address: the shortcut and its landing carry the flag only.
  for (const src of [PROFILE, PAGE, PASSKEYS, LINK_THIS, read("../src/lib/components/passkeys/LinkAnotherDevice.svelte")]) {
    assert.doesNotMatch(src, /(navigate|replaceRoute|routeHref)\([^)]*(pair|code|typed)/i);
  }
});

test("the flag opens the scanner only where the [Add a device] button is offered", () => {
  // The same conditions as the button: its sections' {#if}, then the {:else} of {#if !canAdd}, enabled.
  assert.match(PASSKEYS, /const addDeviceOffered = \$derived\(sectionsShown && canAdd && !busy\);/);
  const m = markupOf(PASSKEYS);
  const devices = m.slice(m.indexOf('id="devices-title"'));
  const gate = devices.indexOf("{#if !canAdd}");
  const unlocked = devices.indexOf("{:else}", gate);
  const button = devices.indexOf('<button class="btn btn--ghost" onclick={() => { linkMode = "link"; linking = true; }} disabled={busy}>Add a device</button>');
  assert.ok(gate > 0 && unlocked > gate && button > unlocked && button < devices.indexOf("{/if}", unlocked));
  assert.ok(m.indexOf("{#if sectionsShown}") < m.indexOf('id="devices-title"'));
  // Waits for the first read, is spent either way, opens with the button's own mode.
  assert.match(
    PASSKEYS,
    /\$effect\(\(\) => \{\s*if \(!addDevice \|\| loading \|\| \(!loaded && loadError === null\)\) return;\s*addDevice = false;\s*if \(addDeviceOffered\) \{ linkMode = "link"; linking = true; \}\s*\}\);/,
  );
  // The script opens the scanner nowhere else; the markup only on a tap.
  const script = PASSKEYS.slice(0, PASSKEYS.indexOf("</script>"));
  assert.equal(script.split("linking = true").length - 1, 1);
  assert.equal(m.split("linking = true").length - 1, 2, "the [Add a device] and [Give it keys] taps");
  // Never a passkey prompt of its own: no load or session from the flag.
  const effect = script.slice(script.indexOf("if (!addDevice"), script.indexOf("});", script.indexOf("if (!addDevice")));
  assert.doesNotMatch(effect, /load\(|ensure|request\(/);
});

test("neither the flag nor any pairing route ever rides an Android intent", () => {
  const carriable = IN_APP_ROUTE.slice(IN_APP_ROUTE.indexOf("const CARRIABLE_ROUTE ="), IN_APP_ROUTE.indexOf("export function isCarriableRoute"));
  assert.doesNotMatch(carriable, /pair|add-device|link/);
  for (const hash of [
    "#/account?add-device",
    "#/passkeys?add-device",
    "#/profile?add-device",
    "#/account?pair=ABCDE-FGHJK-MNPQR-STVWX-YZ0123",
    "#/link",
    "#/link?pair=ABCDE-FGHJK-MNPQR-STVWX-YZ0123",
    "#/pair",
    "#/pair/ABCDE-FGHJK-MNPQR-STVWX-YZ0123",
    "#/woco-pair:ABCDEFGHJKMNPQRSTVWXYZ0123",
  ]) {
    assert.equal(isCarriableRoute(hash), false, hash);
  }
});
