/**
 * The mint/pin split in passkey-account.ts (#158).
 *
 * Recovery has to create the passkey BEFORE the irreversible on-chain rotation,
 * because the new Kernel owner is that credential's PRF-EOA — and must not make
 * it this device's login until the rotation is proven. Those are two different
 * moments, so they are two different functions, and what makes the split real is
 * that the minting half touches NO storage. A future edit that "helpfully" writes
 * the credential inside the mint re-creates #158 while every ordering assertion in
 * recovery-credential-pin-order.test.ts stays green, so the write is asserted here
 * against a real IndexedDB round-trip rather than against the source text.
 *
 * Runs the REAL WebAuthn-facing code path (RP-ID resolution, PRF extraction,
 * keccak256 key derivation, base64url of the credential id); only the
 * authenticator, `window.location` and IndexedDB are shimmed.
 *
 * MUTATION: add `await putKV(StorageKeys.PASSKEY_CREDENTIAL, credential)` inside
 * `_mintPasskeyAccountImpl`, and the first test goes red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { StorageKeys } from "@woco/shared";

// --- minimal in-memory IndexedDB (single object store) for indexeddb.ts -------
// Same shim as identity-seed.test.ts: a Map, so values survive put/get by
// reference exactly as real IndexedDB's structured clone would.
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

/** A fixed 16-byte credential id, so the base64url in the handle is checkable. */
const RAW_ID = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
const RAW_ID_B64URL = "AQIDBAUGBwgJCgsMDQ4PEA";

/** Counts ceremonies so a test can prove a call did or did not reach the
 *  authenticator — the PRF result is returned inline, so the create path never
 *  needs the follow-up get(). */
let creates = 0;

function installFakeAuthenticator() {
  const credential = {
    rawId: RAW_ID.buffer.slice(0) as ArrayBuffer,
    getClientExtensionResults: () => ({ prf: { results: { first: new Uint8Array(32) } } }),
  };
  Object.defineProperty(globalThis, "navigator", {
    value: {
      credentials: {
        create: async () => { creates++; return credential; },
        get: async () => { throw new Error("the create path must not need a follow-up get()"); },
      },
    },
    configurable: true,
    writable: true,
  });
  // resolvePasskeyRpId returns any non-woco.eth.limo hostname unchanged, so
  // "localhost" is both a legal RP ID and the dev value.
  (globalThis as { window?: unknown }).window = { location: { hostname: "localhost" } };
}

installFakeIndexedDB();
installFakeAuthenticator();

// Imported AFTER the shims (both resolve their globals lazily, at call time).
const { createPasskeyAccount, createPasskeyAccountUnpinned, pinPasskeyCredential } =
  await import("../src/lib/auth/passkey-account.ts");
const { getKV, delKV } = await import("../src/lib/auth/storage/indexeddb.ts");

test("createPasskeyAccountUnpinned mints without pinning, and the handle pins exactly what it minted", async () => {
  await delKV(StorageKeys.PASSKEY_CREDENTIAL);
  const before = creates;

  const fresh = await createPasskeyAccountUnpinned();

  assert.equal(creates, before + 1, "the ceremony must actually have run");
  assert.equal(
    await getKV(StorageKeys.PASSKEY_CREDENTIAL),
    null,
    "createPasskeyAccountUnpinned must write NOTHING — the pin is the caller's commit (#158)",
  );
  assert.deepEqual(
    fresh.credential,
    { credentialId: RAW_ID_B64URL, rpId: "localhost" },
    "the handle must carry the minted credential id and RP ID, so the caller can pin it later",
  );
  assert.match(fresh.address, /^0x[0-9a-f]{40}$/, "the PRF-EOA address is what becomes the new Kernel owner");
  assert.match(fresh.privateKey, /^0x[0-9a-f]{64}$/);

  await pinPasskeyCredential(fresh.credential);
  assert.deepEqual(
    await getKV(StorageKeys.PASSKEY_CREDENTIAL),
    { credentialId: RAW_ID_B64URL, rpId: "localhost" },
    "pinPasskeyCredential must store the handle it was given, unchanged",
  );
});

test("createPasskeyAccount still pins at mint time", async () => {
  // The create-an-account login path depends on it: there is no later commit to
  // hang the pin on, so splitting recovery must not have changed this caller.
  await delKV(StorageKeys.PASSKEY_CREDENTIAL);

  const account = await createPasskeyAccount();

  assert.deepEqual(
    await getKV(StorageKeys.PASSKEY_CREDENTIAL),
    { credentialId: RAW_ID_B64URL, rpId: "localhost" },
    "createPasskeyAccount must keep writing the pin itself",
  );
  assert.match(account.address, /^0x[0-9a-f]{40}$/);
  assert.equal(
    (account as { credential?: unknown }).credential,
    undefined,
    "its return shape is unchanged — the handle is the unpinned variant's affordance",
  );
});

test("both halves derive the SAME key from the same credential", async () => {
  // The split must be a split and nothing more: if the two paths ever derived
  // differently, recovery would rotate the account to an owner that this device's
  // own login could not reproduce.
  await delKV(StorageKeys.PASSKEY_CREDENTIAL);
  const unpinned = await createPasskeyAccountUnpinned();
  const pinned = await createPasskeyAccount();
  assert.equal(unpinned.address, pinned.address);
  assert.equal(unpinned.privateKey, pinned.privateKey);
});
