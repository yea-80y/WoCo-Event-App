/**
 * "Add a passkey on this device" (#746 step 3), the app's side: a second passkey for
 * the same account, never pinned as this device's login. The WebAuthn options it is
 * made with (platform only, every known passkey excluded, the added handle) are the
 * window's and are tested there (auth-window-ceremonies.test.ts); here, what the app
 * asks the window for and what it does with each answer.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { StorageKeys, PASSKEY_ADDED_USER_HANDLE_PREFIX, PASSKEY_CREATED_ON_RE } from "@woco/shared";
import { accountResult, installFakeIndexedDB, scriptedWindow } from "./fake-passkey-window.ts";

installFakeIndexedDB();
const win = scriptedWindow();
const pa = await import("../src/lib/auth/passkey-account.ts");
const { getKV, delKV } = await import("../src/lib/auth/storage/indexeddb.ts");
pa.__setPasskeyWindowForTests(win.run);

const GPM_AAGUID = "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4";

test("an added passkey is asked for with the account's passkeys to exclude, and never pinned", async () => {
  await delKV(StorageKeys.PASSKEY_CREDENTIAL);
  win.answer(accountResult({ credentialId: "CCCCCCCCCCCCCCCCCCCCCC", handleKind: "added", aaguid: GPM_AAGUID }));
  const added = await pa.createAddedPasskey({ exclude: ["AQIDBAUGBwgJCgsMDQ4PEA"], createdOn: "2 Oct 2026" });
  assert.deepEqual(win.requests.at(-1), { action: "add", params: { exclude: ["AQIDBAUGBwgJCgsMDQ4PEA"], createdOn: "2 Oct 2026" } });
  assert.equal(added.provider, "google-password-manager");
  assert.equal(added.credentialId, "CCCCCCCCCCCCCCCCCCCCCC");
  assert.match(added.address, /^0x[0-9a-f]{40}$/);
  assert.equal(await getKV(StorageKeys.PASSKEY_CREDENTIAL), null, "never pinned as this device's login");
});

test("the date in its name never makes the request fail: a locale's oddities are dropped", async () => {
  for (const [text, want] of [
    ["2 Oct 2026", "2 Oct 2026"],
    ["‏21 أكتوبر، 2026", "21 أكتوبر، 2026"],
    ["<b>21</b> Oct", "b21/b Oct"],
    ["‮‮", "2026-10-21"],
  ]) {
    const got = pa.passkeyNameDate(text, new Date("2026-10-21T12:00:00Z"));
    assert.equal(got, want, JSON.stringify(text));
    assert.match(got, PASSKEY_CREATED_ON_RE, "always a date the window takes");
  }
});

test("a manager that already holds one of the account's passkeys is refused by name", async () => {
  win.answer({ name: "InvalidStateError" });
  await assert.rejects(pa.createAddedPasskey({ exclude: [], createdOn: "x" }), (e: Error) => e.name === "PasskeyAlreadyInManagerError");
});

test("a passkey made through a QR code (another device) is refused", async () => {
  win.answer({ name: "NotOnThisDevice" });
  await assert.rejects(pa.createAddedPasskey({ exclude: [], createdOn: "x" }), (e: Error) => e.name === "PasskeyNotOnThisDeviceError");
});

test("a sign-in tells an added passkey apart from any other", async () => {
  win.answer(accountResult({ handleKind: "added" }), accountResult({ handleKind: null }));
  assert.equal((await pa.authenticatePasskey()).handleKind, "added");
  assert.equal((await pa.authenticatePasskey()).handleKind, null);
  assert.equal(PASSKEY_ADDED_USER_HANDLE_PREFIX, "woco-added-v1:", "FROZEN: every added passkey carries it");
});
