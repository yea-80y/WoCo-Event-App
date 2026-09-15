/**
 * "Back up your account" shows only for account kinds that can install
 * recovery, and only when the backup inventory answered and was empty — an
 * unreadable inventory must never read as "no backups".
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { canProtectAccount, needsBackupPrompt } from "../src/lib/auth/backup-prompt.js";

const EMPTY = { status: "known" as const, backups: [] };
const ONE = { status: "known" as const, backups: [{ method: "passkey" }] };
const UNREADABLE = { status: "unavailable" as const };

test("passkey and email accounts can be protected; wallets cannot", () => {
  assert.equal(canProtectAccount("passkey"), true);
  assert.equal(canProtectAccount("web3auth"), true);
  assert.equal(canProtectAccount("web3"), false);
  assert.equal(canProtectAccount("coinbase"), false);
  assert.equal(canProtectAccount(null), false);
});

test("an account with no backups is prompted", () => {
  assert.equal(needsBackupPrompt("passkey", EMPTY), true);
  assert.equal(needsBackupPrompt("web3auth", EMPTY), true);
});

test("an account that already has a backup is not prompted", () => {
  assert.equal(needsBackupPrompt("passkey", ONE), false);
});

test("an inventory nobody could read never reads as no backups", () => {
  assert.equal(needsBackupPrompt("passkey", UNREADABLE), false);
  assert.equal(needsBackupPrompt("passkey", null), false);
});

test("a wallet account is never prompted, whatever its inventory says", () => {
  assert.equal(needsBackupPrompt("web3", EMPTY), false);
});
