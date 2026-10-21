/**
 * A browser that refuses passkeys for the passkey host outright. Firefox did exactly
 * this on woco.eth.limo (`*.eth.limo` joined the Public Suffix List on 2026-09-01, and
 * Firefox refuses an RP ID that IS a public suffix), with "SecurityError: The operation
 * is insecure." - which the login modal used to show verbatim. The RP ID is now
 * `auth.woco.eth.limo`, one label below that suffix, which every engine accepts; a
 * browser that still refuses gets words it can act on. Runs the REAL passkey-account
 * code against a scripted window that answers with that refusal.
 *
 * MUTATION: map the window's SecurityError to anything but PasskeyBrowserRefusedError
 * (or drop its host) and every test here goes red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installFakeIndexedDB, scriptedWindow } from "./fake-passkey-window.ts";

const HOST = "auth.woco.eth.limo";

installFakeIndexedDB();
const win = scriptedWindow();

const {
  authenticatePasskey,
  createPasskeyAccount,
  createPasskeyBackupKey,
  getPasskeyBackupKey,
  restorePasskeyAccount,
  PasskeyBrowserRefusedError,
  __setPasskeyWindowForTests,
} = await import("../src/lib/auth/passkey-account.ts");
__setPasskeyWindowForTests(win.run);

function assertRefusal(e: unknown): true {
  assert.ok(e instanceof PasskeyBrowserRefusedError, `expected the named refusal, got ${String(e)}`);
  assert.match(e.message, /This browser can't use passkeys on auth\.woco\.eth\.limo\./);
  assert.equal(e.host, HOST, "the host travels with the error, for the sign-in sheet's advice");
  assert.ok(e.cause instanceof DOMException && e.cause.name === "SecurityError", "the raw refusal stays attached");
  return true;
}

const refusal = { name: "SecurityError" as const };

test("sign-in: the refusal reads as one the user can act on", async () => {
  win.answer(refusal);
  await assert.rejects(authenticatePasskey(), assertRefusal);
});

test("creating an account, and a backup passkey, read the same", async () => {
  win.answer(refusal, refusal);
  await assert.rejects(createPasskeyAccount(), assertRefusal);
  await assert.rejects(createPasskeyBackupKey(), assertRefusal);
});

test("the backup read and the unlock of a pinned passkey read the same", async () => {
  win.answer(refusal, refusal);
  await assert.rejects(getPasskeyBackupKey(), assertRefusal);
  await assert.rejects(
    restorePasskeyAccount({ retryDiscoverable: false, credential: { credentialId: "AQIDBAUGBwgJCgsMDQ4PEA", rpId: HOST } }),
    assertRefusal,
  );
});
