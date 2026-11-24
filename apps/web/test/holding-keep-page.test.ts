/**
 * The Keep page's screens and the places around it (spec-receipt-note 5.2, section 10
 * "the Keep page does nothing on load", 13a items 6 and 11):
 * - KeepPage's load reads only the link and this device (`acceptKeepLink`,
 *   `listDeviceReceipts`); every network step in KeepCard is a button press;
 * - the save takes keys from a CONFIRMED-current account secret;
 * - sign-out clears the receipt feed hints and the receipts kept on the device;
 * - the payment page says where the receipt is and never carries a secret.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { forgetVersionHintsUnder, hintKey } from "../src/lib/swarm/content-feed.ts";

const read = (rel: string) => readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "../src", rel), "utf8");
const scriptOf = (svelte: string) => svelte.slice(svelte.indexOf("<script"), svelte.indexOf("</script>"));

/** The body of `name`'s declaration in a script: `async function name(` ... up to the next top-level function. */
function fnBody(script: string, name: string): string {
  const at = script.search(new RegExp(`(async )?function ${name}\\(`));
  assert.ok(at >= 0, `${name} is declared`);
  const next = script.slice(at + 1).search(/\n  (async )?function \w+\(|\n  onMount\(|\n  const \w+ = \$derived/);
  return next === -1 ? script.slice(at) : script.slice(at, at + 1 + next);
}

const NETWORK = /showReceipt|saveToAccount|finishErase|fetchHoldingBox|eraseServerCopy|keepInAccount|pickupHolding|erasePickup|getEvent|fetch\(|loginRequest|ensureAccountSetup|getAccountSecrets/;

test("KeepPage on load: only the link and this device - no network step, no sign-in", () => {
  const script = scriptOf(read("lib/attendee/keep/KeepPage.svelte"));
  assert.doesNotMatch(script, /\$effect/, "nothing runs on a state change either");
  const mount = script.slice(script.indexOf("onMount("));
  assert.match(mount, /void loadLocal\(\);\s*return onKeepLink\(\(\) => void loadLocal\(\)\);/);
  const load = fnBody(script, "loadLocal");
  assert.doesNotMatch(load, NETWORK);
  assert.match(load, /acceptKeepLink\(fragment, \{ device \}\)/);
  assert.match(load, /device\.listDeviceReceipts\(\)/);
  // A storage failure puts the link back in memory, QUIETLY: never dropped, and never a
  // notification its own listener would answer with another failing attempt (Fable 3b).
  assert.match(load, /catch \{[\s\S]*?if \(fragment\) returnKeepLink\(fragment\);/);
  assert.doesNotMatch(script, /holdKeepLink/);
  assert.doesNotMatch(fnBody(script, "reload"), NETWORK);
});

test("KeepCard: every network step is a button press; nothing runs on mount", () => {
  const card = read("lib/attendee/keep/KeepCard.svelte");
  const script = scriptOf(card);
  assert.doesNotMatch(script, /onMount|\$effect/);
  // The network steps live in the press handlers...
  assert.match(fnBody(script, "show"), /showReceipt\(/);
  assert.match(fnBody(script, "save"), /saveToAccount\(/);
  assert.match(fnBody(script, "eraseAgain"), /finishErase\(/);
  // ...and those handlers are reached only from buttons.
  const markup = card.slice(card.indexOf("</script>"));
  for (const name of ["show", "save", "eraseAgain"]) {
    assert.match(markup, new RegExp(`onclick=\\{${name}\\}`), name);
    assert.equal((script.match(new RegExp(`(?<!function )\\b${name}\\(\\)`, "g")) ?? []).length, 0, `${name} is never called from the script itself`);
  }
  // The event name: cache first, one read of the public page only after a press shows the receipt.
  assert.match(fnBody(script, "show"), /void loadTitle\(/);
  assert.equal(script.match(/loadTitle\(/g)!.length, 2, "declared once, called once - from show()");
});

test("KeepCard save: keys from the CURRENT, confirmed generation; key material zeroed after", () => {
  const save = fnBody(scriptOf(read("lib/attendee/keep/KeepCard.svelte")), "save");
  assert.match(save, /loginRequest\.request\(\{ context: "receipt" \}\)/);
  assert.match(save, /auth\.ensureAccountSetup\(\{ identity: true \}\)/);
  assert.match(save, /auth\.getAccountSecrets\(\{ toSeal: true \}\)/);
  assert.match(save, /holdingGenKeysOf\(secrets\.current\)/);
  assert.doesNotMatch(save, /secrets\.all/, "never an older generation to save under");
  assert.match(save, /finally \{\s*orderSecretKey\?\.fill\(0\);/);
});

test("KeepCard wording: the order's keys, never 'valid'; no 'never' claims", () => {
  const card = read("lib/attendee/keep/KeepCard.svelte");
  const markup = card.slice(card.indexOf("</script>"), card.indexOf("<style>"));
  assert.match(markup, /Your order's keys/);
  const copy = card
    .slice(0, card.indexOf("<style>"))
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(copy, /\bvalid\b/i);
  // Words in quotes on one line: what the screen can say.
  assert.doesNotMatch(copy, /"[^"\n]*\bnever\b[^"\n]*"/i);
});

test("sign-out: the receipt feed hints go, every other hint stays", () => {
  const store = new Map<string, string>();
  const ls = {
    get length() { return store.size; },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  (globalThis as { localStorage?: unknown }).localStorage = ls;
  try {
    const owner = "0x" + "ab".repeat(20);
    store.set(hintKey(owner, "woco/holding/v1/" + "11".repeat(32)), "3");
    store.set(hintKey(owner.toUpperCase().replace("0X", "0x"), "woco/holding/v1/" + "22".repeat(32)), "0");
    store.set(`woco:cfb:${"ab".repeat(20)}:woco/holding/v1/${"33".repeat(32)}`, "1");
    store.set(hintKey(owner, "woco/profile/data/" + owner), "4");
    store.set("woco:cache:collection:x", "{}");
    assert.equal(forgetVersionHintsUnder("woco/holding/v1/"), 3);
    assert.deepEqual([...store.keys()].sort(), [hintKey(owner, "woco/profile/data/" + owner), "woco:cache:collection:x"].sort());
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

test("sign-out: every clear drops the hints and the SAVED device receipts; every sign-out drops them all", () => {
  const auth = read("lib/auth/auth-store.svelte.ts");
  const clear = auth.slice(auth.indexOf("async function clearAllAuth()"), auth.indexOf("// A pending empty-accounts logout"));
  assert.match(clear, /await step\("holding-hints", async \(\) => \{[\s\S]*?forgetVersionHintsUnder\(HOLDING_TOPIC_PREFIX\);/);
  assert.match(clear, /await step\("holding-device-saved", async \(\) => \(await import\("\.\.\/holding\/device-store\.js"\)\)\.forgetSavedDeviceReceipts\(\)\);/);
  assert.ok(clear.indexOf('step("identity-keys"') < clear.indexOf('step("holding-hints"'), "after the identity keys, as every other sweep step");
  // Fable 3b condition 2: `clearAllAuth` also runs at boot for a stale session - a Keep
  // link opened seconds earlier (not saved yet) must survive it.
  assert.doesNotMatch(clear, /forgetAllDeviceReceipts/);
  // Every sign-out, forced ones included (each is a security decision): all of them go.
  const logout = auth.slice(auth.indexOf("async function logout("), auth.indexOf("async function clearAllAuth()"));
  assert.match(
    logout,
    /await clearAllAuth\(\);[\s\S]*?\n  try \{\s*await \(await import\("\.\.\/holding\/device-store\.js"\)\)\.forgetAllDeviceReceipts\(\);/,
  );
  assert.doesNotMatch(logout.slice(logout.indexOf("await clearAllAuth();")), /opts\.force/, "not gated on who asked");
  assert.equal(auth.match(/forgetAllDeviceReceipts/g)!.length, 1, "nowhere else");
});

test("KeepCard: only messages written for people reach the screen (Fable 3b condition 5)", () => {
  const script = scriptOf(read("lib/attendee/keep/KeepCard.svelte"));
  // Raw error text on two lines only: the account's own sign-in and key step, and
  // sayable()'s HoldingSaveError branch.
  assert.equal(script.split("\n").filter((l) => l.includes("e.message")).length, 2);
  assert.match(script, /\} catch \(e\) \{\s*\/\/ The account's own sign-in and key messages are written to be shown\.\s*problem = e instanceof Error && e\.message \? e\.message :/);
  assert.match(fnBody(script, "sayable"), /if \(HoldingSaveError && e instanceof HoldingSaveError\) return/);
  assert.match(script, /problem = sayable\(e, SAVE_FAILED, copy\.HoldingSaveError\);/);
  for (const name of ["show", "eraseAgain"]) assert.doesNotMatch(fnBody(script, name), /e\.message|\(e\)/, `${name} shows only its own words`);
  assert.match(read("lib/attendee/keep/KeepPage.svelte"), /A private record of your order, that only your link opens\./);
});

test("payment page: the receipt line for guests only, behind the flag, and no secret on the page", () => {
  const page = read("lib/attendee/events/EventPurchased.svelte");
  assert.match(page, /\{#if FEATURES\.holdingReceiptsAllowed && !_stash\.linked\}\s*<li><span class="bullet"><\/span>Your private receipt is in your ticket email\.<\/li>/);
  assert.match(page, /FEATURES\.holdingReceiptsAllowed && !_stash\.linked\}\s*<button class="btn-secondary" onclick=\{\(\) => void loginRequest\.request\(\)\}>Create your free WoCo profile<\/button>/);
  assert.doesNotMatch(page, /#\/keep|keep-capture|holding\/derive|holdingKeepFragment/);
});
