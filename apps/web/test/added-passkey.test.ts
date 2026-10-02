/**
 * "Add a passkey on this device" (#746 step 3) at the WebAuthn boundary: a second
 * passkey for the same account, in a different password manager on THIS device,
 * marked so a later sign-in knows it is a device and not an account of its own.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { StorageKeys, isAddedUserHandle, newAddedUserHandle, PASSKEY_ADDED_USER_HANDLE_PREFIX } from "@woco/shared";

const data = new Map<string, unknown>();
function installFakeIndexedDB() {
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

const RAW_ID = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 1, 2, 3, 4, 5, 6]);
const PRF = new Uint8Array(32).fill(5);
// Authenticator data reporting Google Password Manager's AAGUID.
const AUTH_DATA = new Uint8Array(60);
AUTH_DATA[32] = 0x45;
AUTH_DATA.set([0xea, 0x9b, 0x8d, 0x66, 0x4d, 0x01, 0x1d, 0x21, 0x3c, 0xe4, 0xb6, 0xb4, 0x8c, 0xb5, 0x75, 0xd4], 37);

let attachment = "platform";
let createThrows: unknown = null;
let assertionHandle: ArrayBuffer | null = null;
const created: CredentialCreationOptions[] = [];

Object.defineProperty(globalThis, "navigator", {
  value: {
    credentials: {
      create: async (opts: CredentialCreationOptions) => {
        if (createThrows) throw createThrows;
        created.push(opts);
        return {
          rawId: RAW_ID.buffer.slice(0),
          authenticatorAttachment: attachment,
          response: { getAuthenticatorData: () => AUTH_DATA.buffer.slice(0) },
          getClientExtensionResults: () => ({ prf: { results: { first: PRF } } }),
        };
      },
      get: async () => ({
        rawId: RAW_ID.buffer.slice(0),
        authenticatorAttachment: "platform",
        response: { userHandle: assertionHandle },
        getClientExtensionResults: () => ({ prf: { results: { first: PRF } } }),
      }),
    },
  },
  configurable: true,
  writable: true,
});
(globalThis as { window?: unknown }).window = { location: { hostname: "localhost" } };
installFakeIndexedDB();

const pa = await import("../src/lib/auth/passkey-account.ts");

test("an added passkey is made on this device, away from every manager that holds one, and marked added", async () => {
  data.clear();
  created.length = 0;
  attachment = "platform";
  createThrows = null;
  const added = await pa.createAddedPasskey({ exclude: ["AQIDBAUGBwgJCgsMDQ4PEA"], createdOn: "2 Oct 2026" });
  const pk = (created[0] as { publicKey: PublicKeyCredentialCreationOptions }).publicKey;
  assert.equal(pk.authenticatorSelection?.authenticatorAttachment, "platform");
  assert.equal(pk.authenticatorSelection?.residentKey, "required");
  assert.deepEqual(
    pk.excludeCredentials?.map((c) => Buffer.from(c.id as Uint8Array).toString("base64url")),
    ["AQIDBAUGBwgJCgsMDQ4PEA"],
  );
  assert.ok(isAddedUserHandle(new Uint8Array(pk.user.id as ArrayBuffer)), "the user handle marks it added");
  assert.equal(pk.user.name, "WoCo Account - added 2 Oct 2026");
  assert.equal(added.provider, "google-password-manager");
  assert.equal(added.credentialId, Buffer.from(RAW_ID).toString("base64url"));
  assert.match(added.address, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(data.has(StorageKeys.PASSKEY_CREDENTIAL), false, "never pinned as this device's login");
});

test("a manager that already holds one of the account's passkeys is refused by name", async () => {
  createThrows = new DOMException("excluded", "InvalidStateError");
  await assert.rejects(pa.createAddedPasskey({ exclude: [], createdOn: "x" }), (e: Error) => e.name === "PasskeyAlreadyInManagerError");
  createThrows = null;
});

test("a passkey made through a QR code (another device) is refused", async () => {
  attachment = "cross-platform";
  await assert.rejects(pa.createAddedPasskey({ exclude: [], createdOn: "x" }), (e: Error) => e.name === "PasskeyNotOnThisDeviceError");
  attachment = "platform";
});

test("a sign-in tells an added passkey apart from any other", async () => {
  assertionHandle = newAddedUserHandle().buffer.slice(0) as ArrayBuffer;
  assert.equal((await pa.authenticatePasskey()).handleKind, "added");
  assertionHandle = crypto.getRandomValues(new Uint8Array(32)).buffer.slice(0) as ArrayBuffer;
  assert.equal((await pa.authenticatePasskey()).handleKind, null);
  assert.equal(PASSKEY_ADDED_USER_HANDLE_PREFIX, "woco-added-v1:", "FROZEN: every added passkey carries it");
});
