/**
 * Full-chain identity canaries.
 *
 * The `HOLDER_GOLDEN` vectors in credits-key-binding.test.ts and the feed-signer
 * and issuing vectors in `packages/shared/test/crypto/` all pin derivations FROM
 * a seed. Nothing there pins the chain ABOVE the seed: a change to
 * `ACCOUNT_KEYS_DOMAIN` (name/version/salt), `ACCOUNT_KEYS_TYPES`, the purpose
 * string, the fixed nonce, the message shape, or the `keccak256(getBytes(sig))`
 * step would move every user's seed while every one of those still passed — the
 * derivations below the seed are unchanged, so both sides of those comparisons
 * move together.
 *
 * These tests sign the REAL EIP-712 payload with a fixed wallet key through the
 * REAL `requestIdentitySeed`, and pin the resulting seed and every key derived
 * from it to fixed bytes. Any drift anywhere in
 * wallet → sig → seed → {ed25519 holder, X25519 encryption, secp256k1 issuing,
 * content-feed signer} fails loudly.
 *
 * HOW THESE VECTORS WERE PRODUCED (2026-09-10, and this matters — a vector with
 * no provenance is a number someone can "fix"):
 *   1. `new Wallet("0x" + "ab".repeat(32))` — a fixed, throwaway secp256k1 key,
 *      never used anywhere else. Its address is asserted first, so a change in
 *      ethers' key handling is caught before anything downstream is blamed.
 *   2. That wallet signs the EXACT production message — `ACCOUNT_KEYS_DOMAIN`,
 *      `ACCOUNT_KEYS_TYPES`, `{ purpose: ACCOUNT_KEYS_PURPOSE, address, nonce:
 *      ACCOUNT_KEYS_NONCE }` — via `signTypedData`. Deterministic (RFC-6979), so
 *      any correct stack reproduces it.
 *   3. `seed = keccak256(getBytes(signature))`.
 *   4. Each key was then derived from that seed by the shipped functions and the
 *      output pasted below.
 *
 * EVERY VALUE HERE CHANGED ON 2026-09-10, deliberately: the signed message was
 * renamed to "WoCo Account Keys" / `DeriveAccountKeys` (a pre-launch break with
 * no users to carry), and the content-feed signer stopped being its own
 * sign-to-derive signature and became an HKDF sibling of this seed.
 *
 * Do NOT "fix" a failure here by pasting in new values. A mismatch means the
 * derived identity of every existing user just changed: sealed order data
 * becomes undecryptable, issued tickets orphan, and every content chunk the user
 * owns is stranded under an address nothing will look at. That is a migration,
 * not a test update.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Wallet } from "ethers";
import {
  ACCOUNT_KEYS_DOMAIN,
  ACCOUNT_KEYS_TYPES,
  ACCOUNT_KEYS_NONCE,
  ACCOUNT_KEYS_PURPOSE,
  deriveEncryptionKeypairFromSeed,
  deriveIssuingKey,
  deriveFeedSignerKey,
  type EIP712Signer,
} from "@woco/shared";

// --- minimal in-memory IndexedDB, same shim as identity-seed.test.ts ----------
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

const { requestIdentitySeed, clearIdentitySeed } = await import("../src/lib/auth/identity-seed.ts");
const { deriveHolderKeypair } = await import("../src/lib/credits/holder-key.ts");

const WALLET_PRIV = "0x" + "ab".repeat(32);
const PINNED = {
  address: "0xe239cdc5fbe977a8a141B72194D3CF8c41bC5BC6",
  seed: "0xd5c14311ef004fa8015eb99bb6383e3b394ef7599b320fba05486a08cd04a48e",
  /** The HOLDER key — derived by the credits/cert rails only (#518), the seed
   *  used verbatim; `requestIdentitySeed` returns the seed and nothing else. */
  ed25519Pub: "0xc9f4939db19ea5291f24a924f5d4317970bf1810a27a3d4ae9816b958715c802",
  x25519Pub: "7dfc3c60ac69453d720eed9c12d9255d5fddf7482ed9834898f8b6cf2fd0a263",
  issuingAddress: "0x1fe9969b8ee844fcdb77beb2f19e731adab94882",
  /** HKDF sibling of the seed, no longer a signature of its own. */
  feedSignerAddress: "0x810ba04c96cf2b90fb14e4b146d4b392f5442860",
} as const;

function fixedWalletSigner(wallet: Wallet): EIP712Signer {
  return (domain, types, message) =>
    wallet.signTypedData(
      domain as Parameters<Wallet["signTypedData"]>[0],
      types as Parameters<Wallet["signTypedData"]>[1],
      message as Parameters<Wallet["signTypedData"]>[2],
    );
}

test("wallet → EIP-712 sig → seed pin (the chain ABOVE the seed)", async () => {
  await clearIdentitySeed();
  const wallet = new Wallet(WALLET_PRIV);
  assert.equal(wallet.address, PINNED.address, "the fixed wallet key itself moved?");
  const { seed } = await requestIdentitySeed(wallet.address, fixedWalletSigner(wallet));
  assert.equal(seed, PINNED.seed, "identity seed moved — domain/types/purpose/nonce/hashing drift");
});

test("seed → X25519 encryption pubkey pin (the sibling that decrypts sealed orders)", () => {
  const enc = deriveEncryptionKeypairFromSeed(PINNED.seed);
  assert.equal(
    enc.publicKeyHex,
    PINNED.x25519Pub,
    "X25519 derivation moved — every sealed order/list becomes undecryptable",
  );
});

test("seed → gen-0 issuing address pin (the secp sibling that signs manifests + certs)", () => {
  const { address } = deriveIssuingKey(PINNED.seed, 0);
  assert.equal(
    address,
    PINNED.issuingAddress,
    "issuing-key derivation moved — every organiser's issuer identity just changed",
  );
});

test("seed → content-feed signer address pin (the SOC owner of everything they write)", () => {
  const { address } = deriveFeedSignerKey(PINNED.seed);
  assert.equal(
    address,
    PINNED.feedSignerAddress,
    "feed-signer derivation moved — every content chunk this account owns is orphaned",
  );
});

test("seed → ed25519 holder pin (the credit/cert sibling, #518)", async () => {
  const kp = await deriveHolderKeypair(PINNED.seed);
  assert.equal(
    kp.publicKeyHex,
    PINNED.ed25519Pub,
    "holder identity moved — every credit statement and cert challenge is orphaned",
  );
});

test("the four siblings are all different keys", () => {
  // Cheap, and it would have caught an info-string copy/paste: two of these
  // collapsing onto one value means one key is quietly doing two jobs.
  const addrs = new Set([
    PINNED.issuingAddress,
    PINNED.feedSignerAddress,
    PINNED.x25519Pub,
    PINNED.ed25519Pub.slice(2),
    PINNED.seed.slice(2),
  ]);
  assert.equal(addrs.size, 5, "two derivations produced the same value");
});

// ---------------------------------------------------------------------------
// FROZEN BYTES — the tripwire on the message itself
// ---------------------------------------------------------------------------
//
// The pins above catch a byte change through its CONSEQUENCE (a moved seed).
// This one catches it at the source and says what it is, because the failure mode
// is a well-meaning copy edit: "Derive the keys that unlock your WoCo account"
// reads like UI text, and it is signed input. A reviewer looking at a one-word
// diff to a string constant has to be told that the word IS the key.
//
// Written so a ONE-BYTE change fails: every field name, every field type, the
// exact strings, and the salt byte for byte.

test("FROZEN: the account-keys EIP-712 message, byte for byte", () => {
  assert.equal(ACCOUNT_KEYS_DOMAIN.name, "WoCo Account Keys");
  assert.equal(ACCOUNT_KEYS_DOMAIN.version, "1");
  assert.equal(
    ACCOUNT_KEYS_DOMAIN.salt,
    "0x8aee435983f8f356cb689567d575fe89bbd9f0d85e8e28c0d52c2fc340a9085a",
  );
  // No chainId, and that is deliberate — ALLOWED_HOSTS is the host guard (see
  // CLAUDE.md). Adding one here would change every seed.
  assert.deepEqual(Object.keys(ACCOUNT_KEYS_DOMAIN).sort(), ["name", "salt", "version"]);

  assert.deepEqual(Object.keys(ACCOUNT_KEYS_TYPES), ["DeriveAccountKeys"]);
  assert.deepEqual(ACCOUNT_KEYS_TYPES.DeriveAccountKeys, [
    { name: "purpose", type: "string" },
    { name: "address", type: "address" },
    { name: "nonce", type: "string" },
  ]);

  assert.equal(ACCOUNT_KEYS_PURPOSE, "Derive the keys that unlock your WoCo account");
  assert.equal(ACCOUNT_KEYS_NONCE, "WOCO-ACCOUNT-KEYS-V1");
});

test("the production message is built from the frozen constants, not a literal", () => {
  // The pin above is worth nothing if `identity-seed.ts` writes its own copy of
  // the purpose string: the two would drift and only the production one would
  // matter. So the source is checked for the IMPORT, not for the text.
  const src = readFileSync(
    fileURLToPath(new URL("../src/lib/auth/identity-seed.ts", import.meta.url)),
    "utf8",
  );
  assert.match(src, /purpose:\s*ACCOUNT_KEYS_PURPOSE/, "the purpose must come from the constant");
  assert.match(src, /nonce:\s*ACCOUNT_KEYS_NONCE/);
  assert.match(src, /\.\.\.ACCOUNT_KEYS_DOMAIN/);
  assert.match(src, /ACCOUNT_KEYS_TYPES\b/);
  assert.doesNotMatch(src, /"Derive the keys/, "no second copy of the signed string");
});

function sourceFiles(root: string, out: Array<{ rel: string; text: string }> = [], base = root) {
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out, base);
    else if (/\.(ts|svelte)$/.test(name)) out.push({ rel: full.slice(base.length + 1), text: readFileSync(full, "utf-8") });
  }
  return out;
}

/**
 * Comments stripped for the symbol scan below, so it fires on a live symbol and
 * never on prose that merely explains why one was retired — a scan silenced by
 * deleting its own explanation would be precisely backwards. Crude (it would
 * also blank a `//` inside a string literal); acceptable, because over-stripping
 * can only cost a false PASS on a line no such literal appears on, and a real
 * symbol is never inside one.
 */
const stripComments = (t: string) =>
  t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const SCANNED = [
  ...sourceFiles(fileURLToPath(new URL("../src", import.meta.url))),
  ...sourceFiles(fileURLToPath(new URL("../../../packages/shared/src", import.meta.url))),
].map((f) => ({ rel: f.rel, text: f.text, code: stripComments(f.text) }));

test("the source scan below actually reaches the source", () => {
  // Without this, a moved directory empties the scan and the assertion after it
  // passes while guarding nothing.
  assert.ok(SCANNED.length > 300, `scanned only ${SCANNED.length} files`);
  assert.ok(SCANNED.some((f) => f.rel.endsWith("auth/identity-seed.ts")));
  assert.ok(SCANNED.some((f) => f.rel.endsWith("crypto/feed-signer.ts")));
});

test("no FEED_SIGNER_DERIVE / DeriveFeedSigner symbol survives anywhere", () => {
  // The feed signer's own EIP-712 message is gone — it is a KDF of this seed now.
  // A leftover constant is an invitation to re-introduce a second signature and a
  // second at-rest secret, which is exactly what this change removed.
  const hits = SCANNED.filter((f) =>
    /FEED_SIGNER_DERIVE|DeriveFeedSigner|deriveContentFeedSignerFromSig/.test(f.code),
  ).map((f) => f.rel);
  assert.deepEqual(hits, []);
});

// The twin guard against the RETIRED pre-2026-09-10 account-keys constants was
// removed here: naming them is exactly what the shared source-noun ratchet now
// forbids across every source root, comments included, so it subsumes this.
