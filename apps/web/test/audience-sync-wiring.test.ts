/**
 * The automatic buyer add, wired: the screens and the runtime do what the pure
 * rules in `audience-sync.ts` assume. By SOURCE SCAN - the components and the
 * auth store declare `$state`, which Node cannot load.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const SRC = new URL("../src/", import.meta.url).pathname;
const read = (p: string) => readFileSync(SRC + p, "utf-8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/** From `signature` to the close of its body: `\n  }` in a component script, `\n}` in a module. */
function fn(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `${signature} must exist - a rename would make this pass vacuously`);
  const indent = src.lastIndexOf("\n", start);
  const close = "\n" + " ".repeat(start - indent - 1) + "}";
  const end = src.indexOf(close, start);
  assert.ok(end > start, `${signature} must close`);
  return src.slice(start, end + close.length);
}

const SCREEN = code(read("lib/creator/audience/AudienceScreen.svelte"));
const RUNTIME = code(read("lib/creator/audience/audience-sync.svelte.ts"));
const STATUS = read("lib/creator/audience/AudienceSyncStatus.svelte");
const APP = code(read("CreatorApp.svelte"));

test("the manual per-event import is gone; the screen shows the automatic status instead", () => {
  assert.ok(!existsSync(SRC + "lib/creator/audience/AttendeeImport.svelte"));
  assert.doesNotMatch(SCREEN, /AttendeeImport|Add from your events|"attendees"/);
  assert.match(SCREEN, /<AudienceSyncStatus \/>/);
  assert.match(SCREEN, /Ticket buyers who said yes at checkout are added for you\./);
});

test("deleting a contact writes a tombstone, with or without the unsubscribe", () => {
  const del = fn(SCREEN, "async function handleDelete");
  assert.match(del, /const deletedAt = new Date\(\)\.toISOString\(\);/, "dated, so a later 'Email me' can be told from an earlier one");
  const write = del.indexOf("removed: addRemoved(list.removed, organiser, email, deletedAt)");
  assert.ok(write > 0, "the tombstone is part of the same save as the delete");
  assert.ok(write < del.indexOf("if (alsoSuppress)"), "before, and independent of, the unsubscribe");
});

test("a CSV import clears the tombstone of every address it adds back", () => {
  assert.match(fn(SCREEN, "async function handleWizardCommit"), /removed: clearRemoved\(list\.removed, organiser, added\.map\(\(c\) => c\.email\)\)/);
});

test("every save is an operation on the list as stored now, inside the list lock, with the compare-and-swap", () => {
  const commit = fn(SCREEN, "async function commitList");
  assert.match(commit, /await withListLock\(async \(\) => \{[\s\S]*?const saved = await saveListChange\(/);
  assert.match(commit, /const resp = await getMarketingList\(\);/, "re-read inside the lock");
  assert.match(commit, /writeList: \(sealed, emails, ifUpdatedAt\) => uploadMarketingList\(sealed, emails, \{ ifUpdatedAt \}\),/);
  assert.match(commit, /\s+change,\s+\);/, "the screen's edit is passed as an operation");
  assert.doesNotMatch(commit, /change\(\{ contacts, removed \}\)/, "never applied to this tab's own copy");
  assert.match(fn(SCREEN, "async function handleSave"), /commitList\(\(list\) => \(\{ \.\.\.list, contacts:/);
});

test("a save that lost the race reloads the screen and says so plainly", () => {
  const commit = fn(SCREEN, "async function commitList");
  assert.match(commit, /if \(!isListChanged\(err\)\) throw err;\s*changedElsewhere = true;/);
  assert.match(commit, /if \(changedElsewhere\) \{\s*await load\(\);\s*listNotice = LIST_CHANGED_NOTICE;/);
  assert.match(SCREEN, /"Your list was changed in another tab or on another device, so nothing was saved\. We've loaded the latest version - please make your change again\."/);
  assert.match(SCREEN, /\{#if listNotice\}\s*<p class="list-notice" role="status">\{listNotice\}<\/p>/);
});

test("the screen opens the tombstones, reads under the lock, starts a sync, and shows each sync write", () => {
  const load = fn(SCREEN, "async function load");
  assert.match(load, /await withListLock\(async \(\) => \{[\s\S]*?removed = normaliseRemoved\(payload\.removed\);/);
  assert.match(load, /void syncAudience\(\);/);
  assert.match(SCREEN, /onListWritten\(\(payload, written\) => \{\s*if \(listLocked\) return;\s*contacts = payload\.contacts;\s*removed = normaliseRemoved\(payload\.removed\);/);
});

test("a background run never prompts: open keys as held, seal only on a confirmed generation, an existing session only", () => {
  assert.match(RUNTIME, /const secrets = await auth\.getAccountSecrets\(\);/);
  assert.match(RUNTIME, /const secrets = manual\s*\? await confirmedSecrets\(\)\s*: await auth\.getAccountSecrets\(\{ toSeal: true, silent: true \}\)\.catch\(\(\) => null\);/);
  assert.equal(RUNTIME.match(/getAccountSecrets\(\{ toSeal: true, silent: true \}\)/g)?.length, 2, "every background seal-side read is silent");
  assert.doesNotMatch(RUNTIME, /ensureOrganiserUnlock|ensureSession|loginRequest|ensureIdentitySeed/);
  assert.match(fn(RUNTIME, "export function syncAudience"), /if \(!parent \|\| !auth\.isConnected \|\| !auth\.hasSession \|\| !canOrganise\(auth\.kind\)\) return null;/);
});

test("only a Check now tap may ask the organiser to confirm it's them (Fable sign-off 2026-10-14)", () => {
  assert.equal(RUNTIME.match(/ensureAccountSetup\(/g)?.length, 1);
  assert.match(fn(RUNTIME, "async function confirmedSecrets"), /if \(!\(await auth\.ensureAccountSetup\(\{ identity: true \}\)\)\) return null;/);
  assert.equal(RUNTIME.match(/await confirmedSecrets\(\)/g)?.length, 1, "called from the manual branch only");
  assert.match(fn(RUNTIME, "export function syncAudience"), /const manual = opts\.manual === true;/);
  assert.match(STATUS, /void syncAudience\(\{ force: true, manual: true \}\);/);
  assert.match(APP, /untrack\(\(\) => void syncAudience\(\)\);/, "the background trigger is never manual");
  assert.match(fn(SCREEN, "async function load"), /void syncAudience\(\);/, "nor is the screen opening");
});

test("a failed background check is logged, and shown only on the Audience screen", () => {
  const run = fn(RUNTIME, "async function runFor");
  assert.match(run, /if \(res\.status === "failed"\) console\.warn\(/);
  assert.match(run, /if \(res\.added > 0\) markAudienceImported\(parent\);/);
  assert.doesNotMatch(RUNTIME, /alert\(|confirm\(|toast/i);
  // The status component is the one place that reads the record.
  assert.match(STATUS, /describeSync\(audienceSync\.record, audienceSync\.running, now\)/);
});

test("the runtime re-confirms the seal key before the upload, and names the list it merged onto", () => {
  // A passkey removal (#186) mid-run must not get a list sealed to the replaced key.
  assert.match(RUNTIME, /async unchanged\(\) \{\s*const again = await auth\.getAccountSecrets\(\{ toSeal: true, silent: true \}\)\.catch\(\(\) => null\);\s*if \(again === null \|\| !current\(\) \|\| again\.current !== secrets\.current\) return false;\s*return auth\.keyRingStillCurrent\(\)\.catch\(\(\) => false\);/);
  assert.match(RUNTIME, /writeList: \(sealed, emails, ifUpdatedAt\) => uploadMarketingList\(sealed, emails, \{ ifUpdatedAt \}\),/);
  const api = code(read("lib/api/marketing.ts"));
  assert.match(api, /\.\.\.\("ifUpdatedAt" in opts \? \{ ifUpdatedAt: opts\.ifUpdatedAt \?\? null \} : \{\}\),/);
});

test("cost: the cheap count first, and the last start kept per organiser so a reload honours the hour", () => {
  assert.match(RUNTIME, /orderCount: \(eventId\) => getEventOrderCount\(eventId\),/);
  assert.match(fn(RUNTIME, "export function syncAudience"), /stamp: startStamp\(parent\),/);
  assert.match(RUNTIME, /write: \(t\) => writeBlob\(parent, \{ startedAt: t \?\? undefined \}\),/);
  // The note beside the background routes: they already read with the session, so no new prompt trigger.
  assert.match(read("CreatorApp.svelte"), /so the sync adds no new prompt trigger/);
});

test("the runtime guards the account: no write into another account's list", () => {
  assert.match(RUNTIME, /const current = \(\) => auth\.isConnected && auth\.parent\?\.toLowerCase\(\) === parent;/);
  assert.match(RUNTIME, /stillCurrent: current,/);
  assert.match(RUNTIME, /withLock: withListLock,/);
});

test("background trigger: organiser home and event pages, only an unlocked account with a session, never forced", () => {
  const start = APP.indexOf("const AUDIENCE_SYNC_ROUTES");
  assert.ok(start > 0);
  const block = APP.slice(start, APP.indexOf("});", start));
  assert.match(block, /new Set\(\["creator-home", "dashboard-index", "dashboard"\]\)/);
  assert.match(block, /if \(!auth\.hasSession \|\| !auth\.hasIdentitySeed\) return;/);
  assert.match(block, /canOrganise\(auth\.kind\)/);
  assert.match(block, /untrack\(\(\) => void syncAudience\(\)\);/);
  assert.equal(APP.match(/syncAudience\(/g)?.length, 1, "one call site in the shell");
});

test("the status copy: what happens, who stays out, one button - spaced hyphen, no em dash", () => {
  const markup = STATUS.slice(STATUS.indexOf("</script>"));
  assert.match(markup, /Buyers who said yes to your emails at checkout are added automatically - those who ticked\s+"Email me", and, if you only email about your own events, those who didn't tick\s+"Don't email me"\. Anyone who said no, or who you delete, stays off your list\./);
  assert.match(markup, /"Check now"/);
  assert.match(markup, /onclick=\{checkNow\}/);
  assert.doesNotMatch(markup, /[–—]/);
  assert.doesNotMatch(markup, /consent|lawful|GDPR|PECR/i, "no legal jargon");
});
