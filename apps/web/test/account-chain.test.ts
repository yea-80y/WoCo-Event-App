/**
 * A passkey account's later account secrets on the device (#186): locked under the
 * passkey like the seed, account-bound, with a window copy that closes with the seed's.
 */
import test from "node:test";
import assert from "node:assert/strict";

// --- minimal in-memory IndexedDB, as test/identity-seed.test.ts installs it ---
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

installFakeIndexedDB();

const chainMod = await import("../src/lib/auth/account-chain.ts");
const { storeLockedChain, openLockedChain, writeChainWindow, restoreChainWindow, parseAccountChain, currentSecretOf, allSecretsOf } = chainMod;

const SEED_ADDR = "0x" + "5a".repeat(20);
const PARENT = "0x" + "aa".repeat(20);
const PRF = "0x" + "11".repeat(32);
const S0 = "0x" + "00".repeat(31) + "01";
const S1 = "0x" + "01".repeat(32);
const S2 = "0x" + "02".repeat(32);
const CHAIN = { ringRef: "ab".repeat(32), gen: 2, secrets: [S1, S2] };
const POLICY = { mode: "device-window" as const, ms: 2 * 60 * 60_000 };

test("locked: opens with the same passkey for the same account, nothing else", async () => {
  await storeLockedChain(SEED_ADDR, PARENT, CHAIN, PRF);
  assert.deepEqual(await openLockedChain(SEED_ADDR, PARENT, PRF), CHAIN);
  assert.equal(await openLockedChain(SEED_ADDR, PARENT, "0x" + "22".repeat(32)), null, "another passkey");
  assert.equal(await openLockedChain(SEED_ADDR, "0x" + "bb".repeat(20), PRF), null, "another account");
  assert.deepEqual(await openLockedChain(SEED_ADDR, PARENT, PRF), CHAIN, "a foreign try leaves it in place");
});

test("window: open until it closes, then gone; no chain = no copy", async () => {
  const now = 1_000_000;
  await writeChainWindow(SEED_ADDR, PARENT, CHAIN, now + 60_000);
  assert.deepEqual(await restoreChainWindow(SEED_ADDR, PARENT, POLICY, now), CHAIN);
  assert.equal(await restoreChainWindow(SEED_ADDR, PARENT, POLICY, now + 60_001), null, "expired");
  assert.equal(await restoreChainWindow(SEED_ADDR, PARENT, POLICY, now), null, "and deleted");
  await writeChainWindow(SEED_ADDR, PARENT, CHAIN, now + POLICY.ms + 1);
  assert.equal(await restoreChainWindow(SEED_ADDR, PARENT, POLICY, now), null, "dated past the policy");
  await writeChainWindow(SEED_ADDR, PARENT, CHAIN, now + 60_000);
  await writeChainWindow(SEED_ADDR, PARENT, null, now + 60_000);
  assert.equal(await restoreChainWindow(SEED_ADDR, PARENT, POLICY, now), null);
  await writeChainWindow(SEED_ADDR, PARENT, CHAIN, now + 60_000);
  assert.equal(await restoreChainWindow(SEED_ADDR, PARENT, { mode: "per-app-open" }, now), null, "no window under per-app-open");
});

test("the current secret is the newest generation; every secret keeps the seed and skips holes", () => {
  assert.equal(currentSecretOf(S0, null), S0);
  assert.equal(currentSecretOf(S0, CHAIN), S2);
  assert.deepEqual(allSecretsOf(S0, { ringRef: CHAIN.ringRef, gen: 2, secrets: ["", S2] }), [S0, S2]);
});

test("a chain read back is checked whole, never trusted half-read", () => {
  assert.deepEqual(parseAccountChain(CHAIN), CHAIN);
  for (const bad of [
    { ...CHAIN, gen: 3 },
    { ...CHAIN, secrets: [S1, ""] },
    { ...CHAIN, secrets: [S1, "0x12"] },
    { ...CHAIN, ringRef: "AB".repeat(32) },
    { ...CHAIN, gen: 0, secrets: [] },
    null,
  ]) {
    assert.equal(parseAccountChain(bad), null);
  }
});
