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
  PASSKEY_PRF_SALT_INPUT,
  PASSKEY_SEED_INFO,
  PORTABILITY_SOC_OWNER_INFO,
  PORTABILITY_HPKE_INFO,
  PASSKEY_GUARDIAN_ESCROW_INFO,
  PASSKEY_ATTENDEE_DATA_KEK_INFO,
  passkeyAttendeeDataKek,
  passkeyGuardianEscrowMaster,
  passkeyIdentitySeed,
  portabilitySocOwnerKey,
  portabilityHpkeSeed,
  type EIP712Signer,
} from "@woco/shared";
import { createHash } from "node:crypto";
import { keccak256 } from "ethers";

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

const { requestIdentitySeed, establishPasskeyIdentitySeed, restoreIdentitySeed, clearIdentitySeed } =
  await import("../src/lib/auth/identity-seed.ts");
const { AAD } = await import("../src/lib/auth/storage/encryption.ts");
const { deriveEncryptionKeypairFromSeed: derivePortabilityHpkeKeypair, guardianKeysFromMaster } = await import(
  "../src/lib/auth/recovery-escrow.ts"
);
const sha256Hex = (hex: string) => createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");
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

// ---------------------------------------------------------------------------
// PASSKEY: PRF output → seed (#642)
// ---------------------------------------------------------------------------
//
// A passkey account's seed is not a signature: it is HKDF of the WebAuthn PRF
// output (`packages/shared/src/crypto/passkey-prf.ts`). The wallet chain above is
// untouched and still pins web3/web3auth; this block pins the passkey chain.
//
// HOW THESE VECTORS WERE PRODUCED (2026-09-27):
//   1. A fixed, throwaway PRF output, 32 bytes of 0xcd — never used anywhere else.
//   2. Each value derived by the shipped functions and pasted below.
//   3. The seed cross-checked against an independent HKDF-SHA256 (Python stdlib
//      hmac/hashlib, RFC 5869 by hand), so it does not rest on the code under test.
//
// Same rule as above: a mismatch is a migration of every passkey account, not a
// test to update.

const PRF_OUTPUT = "0x" + "cd".repeat(32);
const PASSKEY_PINNED = {
  /** SHA-256(PASSKEY_PRF_SALT_INPUT) — the salt every PRF evaluation sends. A
   *  vector that starts from a fixed PRF output never exercises this step. */
  prfSalt: "e1a5e87b05822eaeb0b43af383a77609480cd238104af967172412233f499a1a",
  /** keccak256(prf) → the Kernel owner (PRF-EOA). FROZEN and NOT moved by #642. */
  ownerAddress: "0x12e5a1673ab1890a409e63c4886c687d67261bc3",
  seed: "0x1af9fab6130a59ec73f8ec8aa1103e6636d3750881d50683a36c5c93aeae6c60",
  x25519Pub: "8ed1d0a43933c49dedf87a54dbb5e0e91fb4bae5e400a046032e6ec83813b250",
  issuingAddress: "0x439b17b3f6954b1936a1585b99a363961dfcc8a0",
  feedSignerAddress: "0x82fb649fe2107d66e0d0f1bce6a97d34c62af90d",
  portabilitySocOwner: "0x20fc9d127383b9b5f742b231d51727bba875dbeb",
  /** SHA-256 of the 1216-byte X-Wing key (the escrow moved to X-Wing in the same
   *  workstream; it was a 32-byte X25519 key before that PR). */
  portabilityHpkePubSha256: "a3bb66ed0d39074a6ea677d945e629fe8f881add3f0771e2ae18556acf9b7856",
  /** A BACKUP passkey's guardian escrow master, HKDF of the same PRF output
   *  (cross-checked against Python), and the two guardian keys it yields. */
  guardianEscrowMaster: "323038c8e317153f7314b73673c5890e4ba89261daa20c6568efd4ccaa8c4968",
  guardianHpkePubSha256: "a4b93e3e6b61d5ae137c1eea816f99d1bec30dcc4c4f5ecd4fb5e235d34035a9",
  guardianSocOwner: "0x6582108e536267308f5a08b23e14b59c03b46375",
  /** ANY passkey enrolled in an attendee-data vault (#746, 2026-09-28): the KEK that
   *  unwraps the attendee-data key. Cross-checked against Python HKDF. */
  attendeeDataKek: "b0960bf70e2c589e462a8ca7ef9f6dcded4faf07c4ec3ae4cc6cef5fa89138f6",
} as const;

test("FROZEN: the PRF salt input and its digest", () => {
  assert.equal(PASSKEY_PRF_SALT_INPUT, "woco-passkey-secp256k1-v1");
  assert.equal(
    createHash("sha256").update(PASSKEY_PRF_SALT_INPUT).digest("hex"),
    PASSKEY_PINNED.prfSalt,
  );
});

test("FROZEN: the PRF-rooted HKDF labels and the at-rest seed AAD, byte for byte", () => {
  assert.equal(PASSKEY_SEED_INFO, "woco/identity-seed/passkey-prf/v1");
  assert.equal(PORTABILITY_SOC_OWNER_INFO, "woco/recovery/portability/soc-owner/v2");
  assert.equal(PORTABILITY_HPKE_INFO, "woco/recovery/portability/hpke/v2");
  assert.equal(PASSKEY_GUARDIAN_ESCROW_INFO, "woco/recovery/guardian-passkey/v1");
  assert.equal(PASSKEY_ATTENDEE_DATA_KEK_INFO, "woco/attendee-data/kek/passkey-prf/v1");
  assert.equal(AAD.IDENTITY_SEED("0xAbC"), "woco/device/identity-seed/v2:0xabc");
});

test("PRF → Kernel owner address pin (the frozen keccak route #642 did not move)", () => {
  // `deriveKey` in passkey-account.ts is private and needs WebAuthn; the source
  // check below pins that it is still exactly this.
  const { address } = new Wallet(keccak256(PRF_OUTPUT));
  assert.equal(address.toLowerCase(), PASSKEY_PINNED.ownerAddress);
});

test("PRF → seed pin, through the REAL establish + restore", async () => {
  await clearIdentitySeed(PASSKEY_PINNED.ownerAddress);
  assert.equal(passkeyIdentitySeed(PRF_OUTPUT), PASSKEY_PINNED.seed);
  const { seed } = await establishPasskeyIdentitySeed(PASSKEY_PINNED.ownerAddress, PRF_OUTPUT);
  assert.equal(seed, PASSKEY_PINNED.seed, "passkey seed moved — every passkey account's identity changed");
  assert.equal(await restoreIdentitySeed(PASSKEY_PINNED.ownerAddress), PASSKEY_PINNED.seed);
});

test("passkey seed → the same sibling derivations as every other seed", () => {
  assert.equal(deriveEncryptionKeypairFromSeed(PASSKEY_PINNED.seed).publicKeyHex, PASSKEY_PINNED.x25519Pub);
  assert.equal(deriveIssuingKey(PASSKEY_PINNED.seed, 0).address, PASSKEY_PINNED.issuingAddress);
  assert.equal(deriveFeedSignerKey(PASSKEY_PINNED.seed).address, PASSKEY_PINNED.feedSignerAddress);
});

test("PRF → portability envelope SOC owner + HPKE recipient pins", async () => {
  assert.equal(portabilitySocOwnerKey(PRF_OUTPUT).address, PASSKEY_PINNED.portabilitySocOwner);
  const kp = await derivePortabilityHpkeKeypair(portabilityHpkeSeed(PRF_OUTPUT));
  assert.equal(sha256Hex(kp.publicKeyHex), PASSKEY_PINNED.portabilityHpkePubSha256);
});

test("backup passkey: PRF → guardian escrow master → escrow key + SOC owner pins", async () => {
  const master = passkeyGuardianEscrowMaster(PRF_OUTPUT);
  assert.equal(Buffer.from(master).toString("hex"), PASSKEY_PINNED.guardianEscrowMaster);
  const gk = await guardianKeysFromMaster(master);
  assert.equal(sha256Hex(gk.encryption.publicKeyHex), PASSKEY_PINNED.guardianHpkePubSha256);
  assert.equal(gk.socSigner.address, PASSKEY_PINNED.guardianSocOwner);
  // The master is the caller's: deriving twice (the setup self-check) must agree.
  assert.equal((await guardianKeysFromMaster(master)).socSigner.address, gk.socSigner.address);
});

test("any vault passkey: PRF → attendee-data KEK pin (#746)", () => {
  assert.equal(Buffer.from(passkeyAttendeeDataKek(PRF_OUTPUT)).toString("hex"), PASSKEY_PINNED.attendeeDataKek);
});

test("everything hanging off one PRF output is a different key", () => {
  const values = new Set([
    PASSKEY_PINNED.seed.slice(2),
    keccak256(PRF_OUTPUT).slice(2),
    PASSKEY_PINNED.ownerAddress,
    PASSKEY_PINNED.portabilitySocOwner,
    PASSKEY_PINNED.feedSignerAddress,
    PASSKEY_PINNED.issuingAddress,
    PASSKEY_PINNED.x25519Pub,
    PASSKEY_PINNED.portabilityHpkePubSha256,
    PASSKEY_PINNED.guardianEscrowMaster,
    PASSKEY_PINNED.guardianSocOwner,
    PASSKEY_PINNED.attendeeDataKek,
  ]);
  assert.equal(values.size, 11, "two derivations produced the same value");
});

test("a PRF output that is not exactly 32 bytes derives nothing", () => {
  for (const bad of ["0x" + "cd".repeat(31), "0x" + "cd".repeat(33), "0x"]) {
    assert.throws(() => passkeyIdentitySeed(bad), /32 bytes/);
    assert.throws(() => portabilitySocOwnerKey(bad), /32 bytes/);
    assert.throws(() => portabilityHpkeSeed(bad), /32 bytes/);
    assert.throws(() => passkeyGuardianEscrowMaster(bad), /32 bytes/);
    assert.throws(() => passkeyAttendeeDataKek(bad), /32 bytes/);
  }
});

test("the passkey code paths route through the frozen module, and no passkey path signs for the seed", () => {
  const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  const account = read("../src/lib/auth/passkey-account.ts");
  // The length check sits BEFORE the owner key, and the owner key is still keccak256(prf).
  const check = account.indexOf("prfBytes.length !== PASSKEY_PRF_OUTPUT_BYTES");
  const owner = account.indexOf("keccak256(prfBytes)");
  assert.ok(check > 0 && owner > check, "the 32-byte check must guard the owner key too");

  const seedSrc = read("../src/lib/auth/identity-seed.ts");
  assert.match(seedSrc, /const seed = passkeyIdentitySeed\(prfSecret\)/);

  const store = stripComments(read("../src/lib/auth/auth-store.svelte.ts"));
  assert.match(store, /establishPasskeyIdentitySeed\(seedAddr, _passkeyPrfSecret\)/);
  // The confirm-dialog seed signer is gone from every source root.
  assert.deepEqual(
    SCANNED.filter((f) => /createPasskeySigner|passkey-signer/.test(f.code)).map((f) => f.rel),
    [],
  );
});

// The twin guard against the RETIRED pre-2026-09-10 account-keys constants was
// removed here: naming them is exactly what the shared source-noun ratchet now
// forbids across every source root, comments included, so it subsumes this.
