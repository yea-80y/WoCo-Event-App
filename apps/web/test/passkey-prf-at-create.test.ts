/**
 * Passkey creation when the authenticator does not return the PRF output at
 * creation, and the backup-passkey tag (#746, #545 A3).
 *
 * Samsung Pass returns NOTHING at registration and a value on the next
 * authentication (Corbado, Aug 2026). The old code fell back to an assertion only
 * when `prf.enabled` was true, so those users were refused at sign-up. Runs the
 * REAL passkey-account code; only the authenticator, `window.location` and
 * IndexedDB are shimmed.
 *
 * MUTATION: restore the `else if (extensions.prf?.enabled)` gate inside
 * `prfAfterCreate` and "Samsung Pass" goes red; drop the user-handle check in
 * `_authenticatePasskeyImpl` and the backup sign-in test goes red; swap the
 * other-device and unsupported errors, or move the other-device check into
 * `extractPrfResult` (shared with the unlock), and the QR-code tests go red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { StorageKeys, isBackupUserHandle, newBackupUserHandle } from "@woco/shared";

// --- minimal in-memory IndexedDB (same shim as passkey-account-unpinned.test.ts)
function installFakeIndexedDB() {
  const data = new Map<string, unknown>();
  const stores = new Set<string>();
  const fire = (req: Record<string, unknown>, result?: unknown) =>
    queueMicrotask(() => {
      req.result = result;
      (req.onsuccess as ((e: unknown) => void) | undefined)?.({ target: req });
    });
  const objectStore = () => ({
    get: (k: string) => { const req: Record<string, unknown> = {}; fire(req, data.has(k) ? data.get(k) : undefined); return req; },
    put: (v: unknown, k: string) => { const req: Record<string, unknown> = {}; data.set(k, v); fire(req); return req; },
    delete: (k: string) => { const req: Record<string, unknown> = {}; data.delete(k); fire(req); return req; },
    clear: () => { const req: Record<string, unknown> = {}; data.clear(); fire(req); return req; },
  });
  const db = {
    objectStoreNames: { contains: (n: string) => stores.has(n) },
    createObjectStore: (n: string) => { stores.add(n); return {}; },
    transaction: () => ({ objectStore }),
    onclose: null,
  };
  (globalThis as { indexedDB?: unknown }).indexedDB = {
    open: () => {
      const req: Record<string, unknown> = {};
      queueMicrotask(() => {
        req.result = db;
        (req.onupgradeneeded as ((e: unknown) => void) | undefined)?.({ target: req });
        (req.onsuccess as ((e: unknown) => void) | undefined)?.({ target: req });
      });
      return req;
    },
  };
}

const RAW_ID = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
const RAW_ID_B64URL = "AQIDBAUGBwgJCgsMDQ4PEA";
const PRF = new Uint8Array(32).fill(7);

/** What the scripted authenticator returns, per test. */
let createExt: Record<string, unknown> = {};
let getExt: Record<string, unknown> = { prf: { results: { first: PRF } } };
let getUserHandle: ArrayBuffer | null = null;
let attachment: string | undefined = "platform";
const calls: { create: unknown[]; get: unknown[] } = { create: [], get: [] };

function installScriptedAuthenticator() {
  Object.defineProperty(globalThis, "navigator", {
    value: {
      credentials: {
        create: async (opts: unknown) => {
          calls.create.push(opts);
          return {
            rawId: RAW_ID.buffer.slice(0) as ArrayBuffer,
            authenticatorAttachment: attachment,
            getClientExtensionResults: () => createExt,
          };
        },
        get: async (opts: unknown) => {
          calls.get.push(opts);
          return {
            rawId: RAW_ID.buffer.slice(0) as ArrayBuffer,
            authenticatorAttachment: attachment,
            response: { userHandle: getUserHandle },
            getClientExtensionResults: () => getExt,
          };
        },
      },
    },
    configurable: true,
    writable: true,
  });
  (globalThis as { window?: unknown }).window = { location: { hostname: "localhost" } };
}

installFakeIndexedDB();
installScriptedAuthenticator();

const {
  createPasskeyAccount,
  createPasskeyBackupKey,
  authenticatePasskey,
  restorePasskeyAccount,
  PasskeyPrfUnsupportedError,
  PasskeyIsBackupError,
  PasskeyFromAnotherDeviceError,
} = await import("../src/lib/auth/passkey-account.ts");
const { getKV, putKV, delKV } = await import("../src/lib/auth/storage/indexeddb.ts");

function reset(over: { createExt?: Record<string, unknown>; getExt?: Record<string, unknown>; userHandle?: ArrayBuffer | null; attachment?: string | undefined } = {}) {
  createExt = over.createExt ?? {};
  getExt = over.getExt ?? { prf: { results: { first: PRF } } };
  getUserHandle = over.userHandle ?? null;
  attachment = "attachment" in over ? over.attachment : "platform";
  calls.create.length = 0;
  calls.get.length = 0;
}

function allowedIds(getOpts: unknown): number[][] {
  const allow = (getOpts as { publicKey: { allowCredentials?: { id: Uint8Array }[] } }).publicKey.allowCredentials ?? [];
  return allow.map((c) => [...new Uint8Array(c.id)]);
}

test("PRF at creation: used directly, no second prompt", async () => {
  reset({ createExt: { prf: { results: { first: PRF } } } });
  const acc = await createPasskeyAccount();
  assert.equal(calls.get.length, 0);
  assert.equal(acc.credentialId, RAW_ID_B64URL);
  assert.equal(acc.attachment, "platform");
});

test("Samsung Pass: nothing at creation -> one assertion against THIS credential", async () => {
  reset({ createExt: {} });
  const acc = await createPasskeyAccount();
  assert.equal(calls.get.length, 1, "the fallback assertion must run even without prf.enabled");
  assert.deepEqual(allowedIds(calls.get[0]), [[...RAW_ID]], "pinned to the credential just created");
  const pk = (calls.get[0] as { publicKey: { userVerification?: string; rpId?: string } }).publicKey;
  assert.equal(pk.userVerification, "required", "the fallback must still require the user");
  assert.equal(pk.rpId, "localhost", "the fallback must ask the same RP");
  assert.match(acc.address, /^0x[0-9a-f]{40}$/);
});

test("creation reports how the passkey was made, including QR-code and unknown", async () => {
  reset({ createExt: { prf: { results: { first: PRF } } }, attachment: "cross-platform" });
  assert.equal((await createPasskeyAccount()).attachment, "cross-platform");
  reset({ createExt: { prf: { results: { first: PRF } } }, attachment: undefined });
  assert.equal((await createPasskeyAccount()).attachment, null);
});

test("prf.enabled without a value still takes the same path", async () => {
  reset({ createExt: { prf: { enabled: true } } });
  await createPasskeyAccount();
  assert.equal(calls.get.length, 1);
});

test("no PRF at creation or on the assertion: refused in plain words", async () => {
  reset({ createExt: {}, getExt: {} });
  await assert.rejects(createPasskeyAccount(), PasskeyPrfUnsupportedError);
  assert.doesNotMatch(new PasskeyPrfUnsupportedError().message, /PRF|extension/);
});

test("backup passkeys get the same fallback and a tagged user handle", async () => {
  reset({ createExt: {} });
  await createPasskeyBackupKey();
  assert.equal(calls.get.length, 1);
  const userId = (calls.create[0] as { publicKey: { user: { id: Uint8Array } } }).publicKey.user.id;
  assert.ok(isBackupUserHandle(userId), "a backup credential must carry the backup tag");
  // The primary-login mint must NOT carry it.
  reset({ createExt: { prf: { results: { first: PRF } } } });
  await createPasskeyAccount();
  const loginId = (calls.create[0] as { publicKey: { user: { id: Uint8Array } } }).publicKey.user.id;
  assert.equal(isBackupUserHandle(loginId), false);
});

test("sign-in reports which credential answered and how", async () => {
  reset({ attachment: "cross-platform" });
  const acc = await authenticatePasskey();
  assert.equal(acc.credentialId, RAW_ID_B64URL);
  assert.equal(acc.attachment, "cross-platform");
  reset({ attachment: undefined });
  assert.equal((await authenticatePasskey()).attachment, null, "unknown is reported as null, never as on-device");
});

test("a backup passkey picked at sign-in is refused before anything is pinned", async () => {
  await delKV(StorageKeys.PASSKEY_CREDENTIAL);
  reset({ userHandle: newBackupUserHandle().buffer as ArrayBuffer });
  await assert.rejects(authenticatePasskey(), PasskeyIsBackupError);
  assert.equal(await getKV(StorageKeys.PASSKEY_CREDENTIAL), null, "a refused backup must never become this device's login");
});

test("a sign-in from another device without the secret is steered to pairing, and pins nothing", async () => {
  await delKV(StorageKeys.PASSKEY_CREDENTIAL);
  reset({ getExt: {}, attachment: "cross-platform" });
  await assert.rejects(authenticatePasskey(), PasskeyFromAnotherDeviceError);
  assert.equal(await getKV(StorageKeys.PASSKEY_CREDENTIAL), null);
});

test("on this device, or when the browser does not say, a missing secret blames the password manager", async () => {
  for (const attachment of ["platform", undefined]) {
    reset({ getExt: {}, attachment });
    await assert.rejects(authenticatePasskey(), PasskeyPrfUnsupportedError);
  }
});

test("a backup passkey from another device is refused as a backup first", async () => {
  reset({ getExt: {}, attachment: "cross-platform", userHandle: newBackupUserHandle().buffer as ArrayBuffer });
  await assert.rejects(authenticatePasskey(), PasskeyIsBackupError);
});

test("the unlock keeps its own refusal: the other-device check is the sign-in's only", async () => {
  await putKV(StorageKeys.PASSKEY_CREDENTIAL, { credentialId: RAW_ID_B64URL, rpId: "localhost" });
  reset({ getExt: {}, attachment: "cross-platform" });
  await assert.rejects(restorePasskeyAccount({ retryDiscoverable: false }), PasskeyPrfUnsupportedError);
});

test("sign-in hands back the pin it replaced, so a refused sign-in can put it back", async () => {
  await delKV(StorageKeys.PASSKEY_CREDENTIAL);
  reset();
  assert.equal((await authenticatePasskey()).replacedPin, null, "nothing was pinned before");
  const before = { credentialId: "AAAA", rpId: "localhost" };
  await putKV(StorageKeys.PASSKEY_CREDENTIAL, before);
  reset();
  assert.deepEqual((await authenticatePasskey()).replacedPin, before);
  assert.equal((await createPasskeyAccount()).replacedPin, undefined, "a creation has nothing to put back");
});
