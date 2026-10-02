/**
 * A session can be signed WITHOUT being stored (#746 step 3): an added passkey's
 * sign-in hears the server's verdict on it first, and a refusal must leave this
 * device's storage as it found it. Stored later with `storeSession`, it restores
 * like any other.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Wallet, TypedDataEncoder } from "ethers";
import { StorageKeys, type EIP712Signer } from "@woco/shared";

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
installFakeIndexedDB();

const { requestSessionDelegation, storeSession, restoreSession } = await import("../src/lib/auth/session-delegation.ts");

const device = Wallet.createRandom();
const parent = Wallet.createRandom().address;
const signer: EIP712Signer = (domain, types, value) =>
  device.signTypedData(domain, types as Parameters<typeof TypedDataEncoder.hash>[1], value);

test("persist: false signs a session and stores nothing", async () => {
  data.clear();
  const minted = await requestSessionDelegation(parent, signer, device.address, { persist: false });
  assert.equal(minted.delegation.message.parent, parent);
  assert.equal(new Wallet(minted.sessionPrivateKey).address, minted.sessionAddress);
  assert.equal(data.has(StorageKeys.SESSION_KEY), false);
  assert.equal(data.has(StorageKeys.SESSION_DELEGATION), false);
  assert.equal(await restoreSession(parent), null);
});

test("storeSession then stores exactly that session", async () => {
  data.clear();
  const minted = await requestSessionDelegation(parent, signer, device.address, { persist: false });
  await storeSession(parent, minted.sessionPrivateKey, minted.sessionAddress, minted.delegation);
  const restored = await restoreSession(parent);
  assert.equal(restored?.sessionWallet.address, minted.sessionAddress);
  assert.deepEqual(restored?.delegation, minted.delegation);
});

test("the default still stores, as every other sign-in expects", async () => {
  data.clear();
  const minted = await requestSessionDelegation(parent, signer, device.address);
  assert.equal((await restoreSession(parent))?.sessionWallet.address, minted.sessionAddress);
});
