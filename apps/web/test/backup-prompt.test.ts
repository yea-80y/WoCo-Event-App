/**
 * "Back up your account" shows only for account kinds that can install
 * recovery, and only when the backup inventory answered and was empty — an
 * unreadable inventory must never read as "no backups".
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { FEATURES } from "@woco/shared";
import { canProtectAccount, needsBackupPrompt } from "../src/lib/auth/backup-prompt.js";

/** Email accounts' backups are off for launch (#186); the rules below are for when they are on. */
function withBackups<T>(on: boolean, fn: () => T): T {
  const flags = FEATURES as Record<string, boolean>;
  const was = flags.accountBackupsAllowed;
  flags.accountBackupsAllowed = on;
  try {
    return fn();
  } finally {
    flags.accountBackupsAllowed = was;
  }
}

const EMPTY = { status: "known" as const, backups: [] };
const ONE = { status: "known" as const, backups: [{ method: "passkey" }] };
const UNREADABLE = { status: "unavailable" as const };

test("while email backups are off (#186), no email account is offered one or prompted", () => {
  assert.equal(FEATURES.accountBackupsAllowed as boolean, false);
  assert.equal(canProtectAccount("web3auth"), false);
  assert.equal(needsBackupPrompt("web3auth", EMPTY), false);
  assert.equal(canProtectAccount("passkey"), true, "a passkey account still backs up by adding passkeys");
});

test("passkey and email accounts can be protected; wallets cannot", () => withBackups(true, () => {
  assert.equal(canProtectAccount("passkey"), true);
  assert.equal(canProtectAccount("web3auth"), true);
  assert.equal(canProtectAccount("web3"), false);
  assert.equal(canProtectAccount("coinbase"), false);
  assert.equal(canProtectAccount(null), false);
}));

test("an email account with no backups is prompted; a passkey account never is (#746 step 5)", () => withBackups(true, () => {
  assert.equal(needsBackupPrompt("web3auth", EMPTY), true);
  assert.equal(needsBackupPrompt("passkey", EMPTY), false, "its backups are linked devices, not Protect");
}));

test("an account that already has a backup is not prompted", () => {
  assert.equal(needsBackupPrompt("web3auth", ONE), false);
});

test("an inventory nobody could read never reads as no backups", () => {
  assert.equal(needsBackupPrompt("web3auth", UNREADABLE), false);
  assert.equal(needsBackupPrompt("web3auth", null), false);
});

test("a wallet account is never prompted, whatever its inventory says", () => {
  assert.equal(needsBackupPrompt("web3", EMPTY), false);
});

// ── #746 step 5: a passkey account backs up by linking, never by email or wallet ──

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { backupPath } from "../src/lib/auth/backup-prompt.js";

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

test("a passkey account's backup lives in Your passkeys; email accounts keep Protect", () => {
  assert.equal(backupPath("passkey"), "/passkeys");
  assert.equal(backupPath("web3auth"), "/protect");
});

test("the store refuses an escrowed backup on a passkey account before anything is sealed", () => {
  const store = src("../src/lib/auth/auth-store.svelte.ts");
  const start = store.indexOf("async function setupAccountRecovery(");
  const body = store.slice(start, store.indexOf("\n}\n", start));
  const refuse = body.indexOf('if (_kind === "passkey") throw new Error(PASSKEY_BACKUP_MESSAGE);');
  assert.ok(refuse > 0 && refuse < body.indexOf("deriveGuardianKeysForBackup"));
});

test("Protect offers a passkey account no method, and every 'add' opens Your passkeys", () => {
  const screen = src("../src/lib/components/recovery/AccountRecoverySetup.svelte");
  assert.match(screen, /\/\/ A passkey account backs up by linking another device \(#746 step 5\), never here\.\n\s*: \[\],/);
  assert.doesNotMatch(screen, /Email or social", recommended: true/);
  assert.match(screen, /function startChoosing\(\) \{\n\s*if \(linkInstead\) \{\n\s*navigate\("\/passkeys"\);\n\s*return;/);
  assert.match(screen, /async function chooseAndConnect\(method: Method\) \{\n\s*if \(linkInstead\) return startChoosing\(\);/);
});


test("the post-publish nudge never sends a passkey account to Protect", () => {
  const nudge = src("../src/lib/components/recovery/BackupNudge.svelte");
  assert.match(nudge, /const canProtect = \$derived\(auth\.kind === "web3auth" && FEATURES\.accountBackupsAllowed\);/);
});
