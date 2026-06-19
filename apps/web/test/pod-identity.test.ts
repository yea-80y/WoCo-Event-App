/**
 * POD-identity persistence guarantees that account recovery depends on.
 *
 * Recovery decrypts the ORIGINAL POD seed from escrow and `storePodSeed`s it
 * under the recovered (new) passkey's PRF-EOA address. The dashboard then reads
 * that seed back — with NO signature — and decrypts the user's history. The
 * danger that motivated `ensurePodIdentity` to prefer the stored seed: after
 * recovery the passkey credential has ROTATED, so re-deriving from a fresh
 * signature yields a DIVERGENT seed that would clobber the escrow-restored
 * original and permanently break decryption. These tests lock in:
 *   1. POD derivation is deterministic + seed-sensitive (same seed ⇒ same
 *      identity; different seed ⇒ different identity).
 *   2. A stored seed is read back as the EXACT identity, with no signer call.
 *   3. The escrow-restore round-trip reproduces the original identity, while a
 *      divergent signature would not — i.e. reuse is mandatory, not optional.
 *
 * Runs against the REAL pod-identity + encryption code; only IndexedDB is shimmed
 * (Node already provides WebCrypto). See the matching guard in
 * auth-store.svelte.ts `ensurePodIdentity()`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { keccak256, getBytes } from "ethers";
import type { EIP712Signer } from "@woco/shared";

// --- minimal in-memory IndexedDB (single object store) for indexeddb.ts -------
// A Map holds values by reference, so a non-extractable CryptoKey (the device
// key) survives put/get exactly as real IndexedDB's structured clone would.
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

// Imported AFTER the shim is installed (functions resolve IndexedDB lazily).
const { requestPodIdentity, storePodSeed, getPodKeypair, clearPodIdentity } =
  await import("../src/lib/auth/pod-identity.ts");
const { deriveKeypair } = await import("../src/lib/pod/keys.ts");

// A deterministic mock wallet: returns a fixed 65-byte signature, counts calls.
function countingSigner(sigHex: string) {
  let calls = 0;
  const sign: EIP712Signer = (async () => { calls++; return sigHex; }) as unknown as EIP712Signer;
  return { sign, calls: () => calls };
}
const SIG_A = "0x" + "ab".repeat(65);
const SIG_B = "0x" + "cd".repeat(65);
const seedFromSig = (sig: string) => keccak256(getBytes(sig));

test("POD derivation is deterministic and seed-sensitive", async () => {
  const a1 = await deriveKeypair("11".repeat(32));
  const a2 = await deriveKeypair("11".repeat(32));
  const b = await deriveKeypair("22".repeat(32));
  assert.equal(a1.publicKeyHex, a2.publicKeyHex, "same seed must yield the same identity");
  assert.notEqual(a1.publicKeyHex, b.publicKeyHex, "different seed must yield a different identity");
});

test("a stored seed is read back as the exact identity, with no signature", async () => {
  await clearPodIdentity();
  const addr = "0x1111111111111111111111111111111111111111";
  const seed = "33".repeat(32);
  await storePodSeed(addr, seed);
  const kp = await getPodKeypair(addr);
  assert.ok(kp, "getPodKeypair must return the stored identity");
  assert.equal(kp.publicKeyHex, (await deriveKeypair(seed)).publicKeyHex);
});

test("escrow-restore reproduces the original identity and never re-signs", async () => {
  await clearPodIdentity();

  // Original identity: derived once from the original credential (signer A).
  const origAddr = "0x1111111111111111111111111111111111111111";
  const a = countingSigner(SIG_A);
  const { podPublicKeyHex: keyOrig } = await requestPodIdentity(origAddr, a.sign);
  assert.equal(a.calls(), 1, "requestPodIdentity signs exactly once");
  assert.equal(keyOrig, (await deriveKeypair(seedFromSig(SIG_A))).publicKeyHex);

  // RECOVERY: the ORIGINAL seed comes out of escrow and is stored under the NEW
  // passkey's PRF-EOA address (the credential rotated; the seed did not).
  const newAddr = "0x2222222222222222222222222222222222222222";
  await storePodSeed(newAddr, seedFromSig(SIG_A));
  const restored = await getPodKeypair(newAddr);
  assert.ok(restored);
  assert.equal(restored.publicKeyHex, keyOrig, "escrow must restore the EXACT original identity");
  assert.equal(a.calls(), 1, "reading the stored seed must NOT trigger another signature");

  // Why reuse is mandatory: re-deriving from the rotated credential (signer B)
  // would produce a DIFFERENT identity — clobbering the escrow-restored one.
  const divergent = await deriveKeypair(seedFromSig(SIG_B));
  assert.notEqual(divergent.publicKeyHex, keyOrig, "a fresh signature after rotation must NOT match");
});
