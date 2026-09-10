/**
 * Identity-SEED persistence guarantees that account recovery depends on.
 *
 * The seed is the root every account key hangs off — the X25519 encryption key,
 * the secp256k1 issuing key, and (on the out-of-launch-scope credit/cert rails
 * only) the ed25519 holder key. Since #518 no key at all is derived here: this
 * module establishes, stores and restores the seed, and nothing else.
 *
 * Recovery decrypts the ORIGINAL seed from escrow and `storePodSeed`s it under
 * the recovered (new) passkey's PRF-EOA address. The dashboard then reads that
 * seed back — with NO signature — and decrypts the user's history. The danger
 * that motivated `ensurePodIdentity` to prefer the stored seed: after recovery
 * the passkey credential has ROTATED, so re-deriving from a fresh signature
 * yields a DIVERGENT seed that would clobber the escrow-restored original and
 * permanently break decryption. These tests lock in:
 *   1. The seed is keccak256 of the canonical signature BYTES, deterministically.
 *   2. A stored seed is read back EXACTLY, with no signer call.
 *   3. The escrow-restore round-trip reproduces the original seed, while a
 *      divergent signature would not — i.e. reuse is mandatory, not optional.
 *   4. Which ADDRESS a seed is filed under decides whether it is found at all.
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
const { requestPodIdentity, storePodSeed, restorePodSeed, clearPodIdentity } =
  await import("../src/lib/auth/pod-identity.ts");

// A deterministic mock wallet: returns a fixed 65-byte signature, counts calls.
function countingSigner(sigHex: string) {
  let calls = 0;
  const sign: EIP712Signer = (async () => { calls++; return sigHex; }) as unknown as EIP712Signer;
  return { sign, calls: () => calls };
}
const SIG_A = "0x" + "ab".repeat(65);
const SIG_B = "0x" + "cd".repeat(65);
const seedFromSig = (sig: string) => keccak256(getBytes(sig));

test("the seed is keccak256 of the canonical signature BYTES", async () => {
  // Not `toUtf8Bytes(signature)` — hashing the 132-byte ASCII hex string would
  // be a different, equally deterministic seed, and picking the wrong one is
  // invisible until it orphans every key on another device.
  await clearPodIdentity();
  const addr = "0x1111111111111111111111111111111111111111";
  const a = countingSigner(SIG_A);
  const { seed } = await requestPodIdentity(addr, a.sign);
  assert.equal(a.calls(), 1, "requestPodIdentity signs exactly once");
  assert.equal(seed, seedFromSig(SIG_A));
  assert.match(seed, /^0x[0-9a-f]{64}$/);
});

test("a different signature is a different seed", async () => {
  await clearPodIdentity();
  const addr = "0x1111111111111111111111111111111111111111";
  const { seed: a } = await requestPodIdentity(addr, countingSigner(SIG_A).sign);
  const { seed: b } = await requestPodIdentity(addr, countingSigner(SIG_B).sign);
  assert.notEqual(a, b);
});

test("requestPodIdentity derives NO key — the seed is all it returns", async () => {
  // #518: it used to hand back an ed25519 public key that signed nothing on any
  // launch path. Anything that needs a key derives it from the seed itself, so a
  // second field here would be a second place for a key to leak from.
  await clearPodIdentity();
  const out = await requestPodIdentity(
    "0x1111111111111111111111111111111111111111",
    countingSigner(SIG_A).sign,
  );
  assert.deepEqual(Object.keys(out), ["seed"]);
});

test("a stored seed is read back exactly, with no signature", async () => {
  await clearPodIdentity();
  const addr = "0x1111111111111111111111111111111111111111";
  const seed = "33".repeat(32);
  await storePodSeed(addr, seed);
  assert.equal(await restorePodSeed(addr), seed);
});

test("escrow-restore reproduces the original seed and never re-signs", async () => {
  await clearPodIdentity();

  // Original seed: derived once from the original credential (signer A).
  const origAddr = "0x1111111111111111111111111111111111111111";
  const a = countingSigner(SIG_A);
  const { seed: seedOrig } = await requestPodIdentity(origAddr, a.sign);
  assert.equal(a.calls(), 1, "requestPodIdentity signs exactly once");

  // RECOVERY: the ORIGINAL seed comes out of escrow and is stored under the NEW
  // passkey's PRF-EOA address (the credential rotated; the seed did not).
  const newAddr = "0x2222222222222222222222222222222222222222";
  await storePodSeed(newAddr, seedOrig);
  assert.equal(await restorePodSeed(newAddr), seedOrig, "escrow must restore the EXACT original seed");
  assert.equal(a.calls(), 1, "reading the stored seed must NOT trigger another signature");

  // Why reuse is mandatory: re-deriving from the rotated credential (signer B)
  // would produce a DIFFERENT seed — clobbering the escrow-restored one.
  assert.notEqual(seedFromSig(SIG_B), seedOrig, "a fresh signature after rotation must NOT match");
});

// ---------------------------------------------------------------------------
// The address a seed is keyed by — the credits-rail dead path (#172)
// ---------------------------------------------------------------------------
//
// This is the mechanism behind a bug that killed the coaster-credits rail for
// every passkey and web3auth rider, and killed it SILENTLY. `credits.ts` looked
// the seed up by `auth.parent`, which for both kinds is the KERNEL address,
// while the seed is stored under the POD address (the PRF-EOA / Web3Auth EOA —
// auth-store `_getPodAddress`, invariant #1). The read hit a slot that is never
// written, so `ensurePodIdentity()` succeeded — having just made the rider
// approve a ceremony — and the next line threw "could not unlock".
//
// The reason it needs pinning HERE, against the real storage code, is that the
// symptom is a null rather than a throw: nothing about a wrong-address lookup
// announces itself, and upstream it rendered as an ordinary signed-out card.
// These run without WebAuthn because the bug never involved WebAuthn.

// The two addresses a passkey account actually has. They are unrelated: the
// Kernel is the parent identity, the PRF-EOA is what POD material is keyed by.
const PRF_EOA = "0x2222222222222222222222222222222222222222";
const KERNEL_PARENT = "0x3333333333333333333333333333333333333333";

/** Both slots AND the legacy one. `clearPodIdentity()` with no argument drops
 *  only the legacy global slot, so a per-account seed written by one test is
 *  still there for the next — which is exactly how a wrong-address lookup can
 *  appear to succeed. Naming both addresses is what makes these tests mean
 *  what they say. */
async function clearBoth() {
  await clearPodIdentity(PRF_EOA);
  await clearPodIdentity(KERNEL_PARENT);
}

test("a seed stored under the POD address is INVISIBLE under the Kernel parent", async () => {
  await clearBoth();
  const prfEoa = PRF_EOA;
  const kernelParent = KERNEL_PARENT;

  await storePodSeed(prfEoa, "44".repeat(32));

  assert.ok(await restorePodSeed(prfEoa), "the POD address must resolve the seed");
  assert.equal(
    await restorePodSeed(kernelParent),
    null,
    "looking up by the Kernel parent must find NOTHING — this returning null, " +
      "rather than throwing, is why the dead rail looked like a rider who had " +
      "simply not collected yet",
  );
});

test("storing under the Kernel parent does not rescue a POD-address lookup either", async () => {
  // The mirror image, which is what makes it a binding rather than a fallback:
  // there is no address that satisfies both, so a caller MUST resolve the right
  // one rather than picking whichever it has to hand.
  await clearBoth();

  await storePodSeed(KERNEL_PARENT, "55".repeat(32));
  assert.equal(await restorePodSeed(PRF_EOA), null);
});

test("the SEED decides the identity, not the address it was filed under", async () => {
  // Worth stating explicitly, because it is what makes a wrong-address lookup
  // SILENT rather than wrong-looking: every key is a function of the seed, and
  // the address only decides which seed you find. So a bad address yields
  // nothing at all — never a second, divergent identity — and the rail failed
  // loudly instead of quietly signing laps under a stranger.
  await clearBoth();
  const seed = "66".repeat(32);
  await storePodSeed(PRF_EOA, seed);
  await storePodSeed(KERNEL_PARENT, seed);

  assert.equal(await restorePodSeed(PRF_EOA), seed);
  assert.equal(await restorePodSeed(KERNEL_PARENT), seed);
});
