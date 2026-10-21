/**
 * What the app does with the passkey window's answers (#746, #545 A3). The checks that
 * need the credential itself - a creation with no PRF value getting its second tap, the
 * backup tag, the other-device check - run in the window and are tested there
 * (auth-window-ceremonies.test.ts). Here: the app reports which credential answered and
 * how, a refusal pins nothing, a sign-in hands back the pin it replaced, and each
 * refusal arrives as the error the sign-in screens read.
 *
 * Runs the REAL passkey-account code against a scripted window (fake-passkey-window.ts).
 *
 * MUTATION: pin before the window answers and the refused-sign-in tests go red; drop
 * `replacedPin` and the last test goes red; map a refusal to the wrong class and its
 * test goes red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { StorageKeys } from "@woco/shared";
import { accountResult, guardianResult, installFakeIndexedDB, scriptedWindow } from "./fake-passkey-window.ts";

installFakeIndexedDB();
const win = scriptedWindow();

const {
  createPasskeyAccount,
  createPasskeyBackupKey,
  getPasskeyBackupKey,
  authenticatePasskey,
  restorePasskeyAccount,
  PasskeyPrfUnsupportedError,
  PasskeyIsBackupError,
  PasskeyFromAnotherDeviceError,
  PasskeyCreatedWithoutSecretError,
  __setPasskeyWindowForTests,
} = await import("../src/lib/auth/passkey-account.ts");
const { getKV, putKV, delKV } = await import("../src/lib/auth/storage/indexeddb.ts");
__setPasskeyWindowForTests(win.run);

const RP_ID = "auth.woco.eth.limo";
const ID = "AQIDBAUGBwgJCgsMDQ4PEA";

test("sign-in reports which credential answered and how", async () => {
  win.answer(accountResult({ credentialId: ID, attachment: "cross-platform" }), accountResult({ attachment: null }));
  const acc = await authenticatePasskey();
  assert.equal(acc.credentialId, ID);
  assert.equal(acc.attachment, "cross-platform");
  assert.equal((await authenticatePasskey()).attachment, null, "unknown is reported as null, never as on-device");
  assert.deepEqual(win.requests.slice(-2).map((r) => r.action), ["signin", "signin"]);
});

test("creation reports how the passkey was made, including QR-code and unknown", async () => {
  win.answer(accountResult({ attachment: "cross-platform" }), accountResult({ attachment: null }));
  assert.equal((await createPasskeyAccount()).attachment, "cross-platform");
  assert.equal((await createPasskeyAccount()).attachment, null);
});

test("a backup passkey picked at sign-in is refused before anything is pinned", async () => {
  await delKV(StorageKeys.PASSKEY_CREDENTIAL);
  win.answer({ name: "IsBackup" });
  await assert.rejects(authenticatePasskey(), PasskeyIsBackupError);
  assert.equal(await getKV(StorageKeys.PASSKEY_CREDENTIAL), null, "a refused backup must never become this device's login");
});

test("a sign-in from another device without the secret is steered to pairing, and pins nothing", async () => {
  await delKV(StorageKeys.PASSKEY_CREDENTIAL);
  win.answer({ name: "FromAnotherDevice" });
  await assert.rejects(authenticatePasskey(), PasskeyFromAnotherDeviceError);
  assert.equal(await getKV(StorageKeys.PASSKEY_CREDENTIAL), null);
});

test("no secret: refused in plain words, naming the manager only for a creation", async () => {
  win.answer({ name: "PrfUnsupported" });
  const signIn = await authenticatePasskey().then(() => null, (e: unknown) => e);
  assert.ok(signIn instanceof PasskeyPrfUnsupportedError);
  assert.doesNotMatch(signIn.message, /PRF|extension/);
  assert.equal(signIn.provider, undefined);
  win.answer({ name: "PrfUnsupported", aaguid: "53414d53-554e-4700-0000-000000000000", label: "WoCo Backup" });
  const created = await createPasskeyBackupKey().then(() => null, (e: unknown) => e);
  assert.ok(created instanceof PasskeyPrfUnsupportedError);
  assert.equal(created.provider, "samsung-pass");
  assert.match(created.message, /Delete the "WoCo Backup" passkey from Samsung Pass/);
});

test("a creation whose follow-up was declined says the passkey exists", async () => {
  win.answer({ name: "CreatedWithoutSecret" });
  await assert.rejects(createPasskeyAccount(), PasskeyCreatedWithoutSecretError);
});

test("backup passkeys answer with the guardian's owner and escrow master, and pin nothing", async () => {
  await delKV(StorageKeys.PASSKEY_CREDENTIAL);
  win.answer(guardianResult(), guardianResult());
  const made = await createPasskeyBackupKey();
  const got = await getPasskeyBackupKey();
  assert.equal(made.address, got.address);
  assert.match(made.address, /^0x[0-9a-f]{40}$/);
  assert.equal(made.escrowMaster.length, 32);
  assert.deepEqual(win.requests.slice(-2).map((r) => r.action), ["backup-create", "backup-get"]);
  assert.equal(await getKV(StorageKeys.PASSKEY_CREDENTIAL), null);
});

test("the unlock asks for the pinned passkey; the picker only when told to", async () => {
  await putKV(StorageKeys.PASSKEY_CREDENTIAL, { credentialId: ID, rpId: RP_ID });
  win.answer(accountResult({ credentialId: ID }), accountResult({ credentialId: ID }));
  await restorePasskeyAccount({ retryDiscoverable: false });
  await restorePasskeyAccount();
  assert.deepEqual(win.requests.slice(-2).map((r) => r.params), [
    { credentialId: ID, fallback: false },
    { credentialId: ID, fallback: true },
  ]);
});

test("a pin from before the window (another RP ID) is not asked for: the picker is", async () => {
  await putKV(StorageKeys.PASSKEY_CREDENTIAL, { credentialId: ID, rpId: "woco.eth.limo" });
  win.answer(accountResult({ credentialId: "BBBBBBBBBBBBBBBBBBBBBB" }));
  await restorePasskeyAccount({ retryDiscoverable: false });
  assert.equal(win.requests.at(-1)!.action, "signin");
  assert.deepEqual(await getKV(StorageKeys.PASSKEY_CREDENTIAL), { credentialId: "BBBBBBBBBBBBBBBBBBBBBB", rpId: RP_ID });
});

test("when the picker answers an unlock, what answered is pinned", async () => {
  await putKV(StorageKeys.PASSKEY_CREDENTIAL, { credentialId: ID, rpId: RP_ID });
  win.answer(accountResult({ credentialId: "CCCCCCCCCCCCCCCCCCCCCC" }));
  await restorePasskeyAccount();
  assert.deepEqual(await getKV(StorageKeys.PASSKEY_CREDENTIAL), { credentialId: "CCCCCCCCCCCCCCCCCCCCCC", rpId: RP_ID });
});

test("sign-in hands back the pin it replaced, so a refused sign-in can put it back", async () => {
  await delKV(StorageKeys.PASSKEY_CREDENTIAL);
  win.answer(accountResult(), accountResult(), accountResult());
  assert.equal((await authenticatePasskey()).replacedPin, null, "nothing was pinned before");
  const before = { credentialId: "AAAA", rpId: RP_ID };
  await putKV(StorageKeys.PASSKEY_CREDENTIAL, before);
  assert.deepEqual((await authenticatePasskey()).replacedPin, before);
  assert.equal((await createPasskeyAccount()).replacedPin, undefined, "a creation has nothing to put back");
});
