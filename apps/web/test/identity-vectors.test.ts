/**
 * Full-chain identity canaries (PR 1 of the issuer-curve migration).
 *
 * The existing `POD_GOLDEN` vectors in pod-identity.test.ts pin seed → ed25519
 * public key, but nothing pinned the chain ABOVE the seed: a change to
 * POD_IDENTITY_DOMAIN (name/version/salt), POD_IDENTITY_TYPES, the fixed
 * nonce, the message shape, or the keccak256(getBytes(sig)) step would move
 * every user's seed while `POD_GOLDEN` still passed — the derivation below the
 * seed is unchanged, so both sides of that comparison move together.
 *
 * These tests sign the REAL EIP-712 payload with a fixed wallet key through
 * the REAL `requestPodIdentity`, and pin the resulting seed and public keys
 * to fixed bytes. Any drift anywhere in wallet → sig → seed → ed25519/X25519
 * fails loudly.
 *
 * Do NOT "fix" a failure here by pasting in new values. A mismatch means the
 * derived identity of every existing user just changed: sealed order data
 * becomes undecryptable and issued tickets orphan. That is a migration, not
 * a test update. (Pre-launch this is survivable via purge + re-publish — the
 * whole point is to make it impossible to do by accident.)
 *
 * PR 3 NOTE: when `crypto/issuing.ts` lands, add the gen-0 issuing ADDRESS
 * pin for PINNED.seed right next to PINNED.x25519Pub below.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Wallet } from "ethers";
import {
  FEED_SIGNER_DERIVE_DOMAIN,
  FEED_SIGNER_DERIVE_TYPES,
  FEED_SIGNER_DERIVE_NONCE,
  deriveEncryptionKeypairFromPodSeed,
  type EIP712Signer,
} from "@woco/shared";

// --- minimal in-memory IndexedDB, same shim as pod-identity.test.ts ----------
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

const { requestPodIdentity, clearPodIdentity } = await import("../src/lib/auth/pod-identity.ts");
const { deriveContentFeedSignerFromSig } = await import("../src/lib/swarm/content-feed.ts");

// A fixed, throwaway secp256k1 key. Everything below is derived from it via
// deterministic (RFC-6979) signatures, so these values are reproducible on any
// correct stack — and stop reproducing the moment any link in the chain moves.
const WALLET_PRIV = "0x" + "ab".repeat(32);
const PINNED = {
  address: "0xe239cdc5fbe977a8a141B72194D3CF8c41bC5BC6",
  seed: "0x72e9100a95f0a342992d0729b88e2afcca0151c3bb2029d0c3867e66435a4651",
  ed25519Pub: "0x618c7c53baa1d7d8f82effd44e08d14d273f04015afd84c8f98f22a8893a1fe2",
  x25519Pub: "9db15133070753b2302ae50ec75d00e312e1859aa3a1550d38829ecf2955d14d",
  feedSignerAddress: "0xd31fb22214ec3684f64c53a26edc1d9235059f3f",
} as const;

test("wallet → EIP-712 sig → seed → ed25519 pin (the chain ABOVE the seed)", async () => {
  await clearPodIdentity();
  const wallet = new Wallet(WALLET_PRIV);
  assert.equal(wallet.address, PINNED.address, "the fixed wallet key itself moved?");
  const signer: EIP712Signer = (domain, types, message) =>
    wallet.signTypedData(
      domain as Parameters<Wallet["signTypedData"]>[0],
      types as Parameters<Wallet["signTypedData"]>[1],
      message as Parameters<Wallet["signTypedData"]>[2],
    );
  const { seed, podPublicKeyHex } = await requestPodIdentity(wallet.address, signer);
  assert.equal(seed, PINNED.seed, "identity seed moved — domain/types/nonce/hashing drift");
  assert.equal(podPublicKeyHex, PINNED.ed25519Pub, "ed25519 identity moved");
});

test("seed → X25519 encryption pubkey pin (the sibling that decrypts sealed orders)", () => {
  const enc = deriveEncryptionKeypairFromPodSeed(PINNED.seed);
  assert.equal(
    enc.publicKeyHex,
    PINNED.x25519Pub,
    "X25519 derivation moved — every sealed order/list becomes undecryptable",
  );
});

test("feed-signer sign-to-derive pin: fixed wallet + domain → pinned address", async () => {
  const wallet = new Wallet(WALLET_PRIV);
  const sig = await wallet.signTypedData(
    { ...FEED_SIGNER_DERIVE_DOMAIN },
    FEED_SIGNER_DERIVE_TYPES as unknown as Record<string, Array<{ name: string; type: string }>>,
    {
      purpose: "Set up your WoCo content-feed signing key",
      address: wallet.address,
      nonce: FEED_SIGNER_DERIVE_NONCE,
    },
  );
  const signer = await deriveContentFeedSignerFromSig(sig);
  assert.equal(signer.address, PINNED.feedSignerAddress, "feed-signer derivation moved");
});

test("the production feed-signer message literal matches the one pinned above", () => {
  // `_deriveFeedSignerBySigning` is module-private in auth-store.svelte.ts
  // (runes module — not importable under node:test), so the purpose literal is
  // restated in the pin above. This tripwire fails if the production literal
  // drifts away from the pinned one.
  const src = readFileSync(
    fileURLToPath(new URL("../src/lib/auth/auth-store.svelte.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(
    src.includes('purpose: "Set up your WoCo content-feed signing key"'),
    "auth-store's feed-signer purpose literal changed — the pinned vector no longer covers production",
  );
  assert.ok(
    src.includes("FEED_SIGNER_DERIVE_NONCE") && src.includes("FEED_SIGNER_DERIVE_DOMAIN"),
    "auth-store no longer derives the feed signer from the shared domain/nonce constants",
  );
});
