/**
 * ensureDeviceKey: two first calls at once must share ONE key (#186). Each used
 * to see "no key", make its own, and the second write replaced the key the first
 * caller had already encrypted under, so that blob could never be opened again.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const data = new Map<string, unknown>();
let puts = 0;
{
  const fire = (req: Record<string, unknown>, result?: unknown) =>
    queueMicrotask(() => {
      req.result = result;
      (req.onsuccess as ((e: unknown) => void) | undefined)?.({ target: req });
    });
  const objectStore = () => ({
    get: (k: string) => { const req: Record<string, unknown> = {}; fire(req, data.get(k)); return req; },
    put: (v: unknown, k: string) => { const req: Record<string, unknown> = {}; puts++; data.set(k, v); fire(req); return req; },
  });
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => ({}),
    transaction: () => ({ objectStore }),
    onclose: null,
  };
  (globalThis as { indexedDB?: unknown }).indexedDB = {
    open: () => {
      const req: Record<string, unknown> = {};
      queueMicrotask(() => {
        req.result = db;
        (req.onsuccess as ((e: unknown) => void) | undefined)?.({ target: req });
      });
      return req;
    },
  };
}

const { ensureDeviceKey } = await import("../src/lib/auth/storage/encryption.ts");

test("concurrent first calls get the same key, written once", async () => {
  const [a, b, c] = await Promise.all([ensureDeviceKey(), ensureDeviceKey(), ensureDeviceKey()]);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(puts, 1);
  assert.equal(await ensureDeviceKey(), a, "a later call reads the stored key back");
});
