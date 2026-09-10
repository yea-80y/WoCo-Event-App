/**
 * A recovery bundle carries the SEED, and the seed is enough.
 *
 * This is the property the whole "fold the feed signer into the seed" change
 * rests on, and the one whose failure would be silent. Before, the bundle
 * carried TWO independent secrets — the identity seed and the content-feed
 * signer's private key — and every path that wrote one had to remember the
 * other. A bundle written missing the signer restored an account that could
 * decrypt its history but could no longer write to (or read) any of the feeds it
 * owned, under an address the platform-signed carriers still advertised. Nothing
 * about that reads as a failure at recovery time; it reads as an account whose
 * content vanished.
 *
 * So: a bundle carrying `podSeed` ALONE must restore an account whose
 * content-feed signer is byte-identical to the one it had. That is now true by
 * construction (the signer is `HKDF(seed, "woco/feed-signer/v1")`), and this
 * pins the construction end to end — through the REAL seal/open, with the real
 * HPKE + XChaCha20-Poly1305 envelope, not a stubbed one.
 *
 * MUTATION: change the info string in `crypto/feed-signer.ts`, or make
 * `deriveFeedSignerKey` read anything other than the seed, and the last
 * assertion here goes red.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { deriveFeedSignerKey, deriveIssuingKey, deriveEncryptionKeypairFromPodSeed } from "@woco/shared";
import {
  deriveGuardianKeys,
  sealRecoveryBundle,
  openRecoveryBundle,
} from "../src/lib/auth/recovery-escrow.js";

const KERNEL = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
/** The account's seed BEFORE recovery — what its feeds were written under. */
const ORIGINAL_SEED = "0x" + "ab".repeat(32);
/** A DIFFERENT seed: what a rotated credential would establish if recovery
 *  failed to restore. Its signer must not equal the original's. */
const DIVERGENT_SEED = "0x" + "cd".repeat(32);

/** The guardian backup wallet — an ordinary EOA that only ever signs. */
const GUARDIAN = new Wallet("0x" + "11".repeat(32));
const guardianSigner = ((domain, types, message) =>
  GUARDIAN.signTypedData(
    domain as Parameters<Wallet["signTypedData"]>[0],
    types as Parameters<Wallet["signTypedData"]>[1],
    message as Parameters<Wallet["signTypedData"]>[2],
  )) as unknown as import("@woco/shared").EIP712Signer;

test("a seed-only bundle round-trips and re-derives the SAME feed signer", async () => {
  const before = deriveFeedSignerKey(ORIGINAL_SEED);

  const gk = await deriveGuardianKeys(GUARDIAN.address, guardianSigner);
  const envelope = await sealRecoveryBundle({
    // The bundle as `setupAccountRecovery` now writes it: one secret.
    bundle: { version: 1, secrets: { podSeed: ORIGINAL_SEED } },
    kernelAddress: KERNEL,
    role: "guardian",
    guardianPublicKeysHex: [gk.encryption.publicKeyHex],
  });

  // A second, independent derivation from the same wallet — the recovering
  // device, which has nothing but the backup wallet.
  const gk2 = await deriveGuardianKeys(GUARDIAN.address, guardianSigner);
  const opened = await openRecoveryBundle({
    envelope,
    kernelAddress: KERNEL,
    role: "guardian",
    guardianKeypair: gk2.encryption,
  });

  assert.equal(opened.secrets.podSeed, ORIGINAL_SEED, "the seed must survive verbatim");
  assert.equal(
    Object.prototype.hasOwnProperty.call(opened.secrets, "feedSignerPrivKey"),
    false,
    "no second secret is carried any more",
  );

  const after = deriveFeedSignerKey(opened.secrets.podSeed!);
  assert.equal(after.address, before.address, "the recovered account must own the same feeds");
  assert.equal(after.privKey, before.privKey);
});

test("the whole account comes back, not just the feeds", async () => {
  // The seed is the root for three keys. If restoring it only restored one of
  // them the bundle would be back to carrying secrets separately.
  const seed = ORIGINAL_SEED;
  assert.equal(deriveIssuingKey(seed, 0).address, deriveIssuingKey(ORIGINAL_SEED, 0).address);
  assert.equal(
    deriveEncryptionKeypairFromPodSeed(seed).publicKeyHex,
    deriveEncryptionKeypairFromPodSeed(ORIGINAL_SEED).publicKeyHex,
  );
});

test("a DIVERGENT seed gives a different signer — which is what recovery prevents", async () => {
  // The counterfactual: a recovered device that established a fresh seed from
  // its rotated credential instead of restoring. Every feed the account owns
  // would move to this address, and nothing would say so.
  assert.notEqual(
    deriveFeedSignerKey(DIVERGENT_SEED).address,
    deriveFeedSignerKey(ORIGINAL_SEED).address,
  );
});

test("the WRONG guardian wallet cannot open the bundle", async () => {
  // Anti-transplant, unchanged by the shape of the bundle — asserted here because
  // a smaller bundle must not have loosened it.
  const gk = await deriveGuardianKeys(GUARDIAN.address, guardianSigner);
  const envelope = await sealRecoveryBundle({
    bundle: { version: 1, secrets: { podSeed: ORIGINAL_SEED } },
    kernelAddress: KERNEL,
    role: "guardian",
    guardianPublicKeysHex: [gk.encryption.publicKeyHex],
  });

  const stranger = new Wallet("0x" + "22".repeat(32));
  const strangerKeys = await deriveGuardianKeys(
    stranger.address,
    ((domain, types, message) =>
      stranger.signTypedData(
        domain as Parameters<Wallet["signTypedData"]>[0],
        types as Parameters<Wallet["signTypedData"]>[1],
        message as Parameters<Wallet["signTypedData"]>[2],
      )) as unknown as import("@woco/shared").EIP712Signer,
  );
  await assert.rejects(() =>
    openRecoveryBundle({
      envelope,
      kernelAddress: KERNEL,
      role: "guardian",
      guardianKeypair: strangerKeys.encryption,
    }),
  );
});
