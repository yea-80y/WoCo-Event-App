/**
 * RECOVERY-ESCROW SPIKE (PASSKEY_RECOVERY_PLAN §11.6 step 1).
 *
 * Pure-crypto verification of the POD escrow primitives — NO chain, no bundler,
 * no env. Proves the round-trip and the security properties an audit will look
 * for:
 *   1. seal → open round-trips the exact bundle (1-of-1 backup EOA).
 *   2. The guardian X25519 key is DETERMINISTIC — re-deriving from the same EOA
 *      signature yields byte-identical keys (the recoverable-on-any-device claim).
 *   3. AAD bind: an envelope minted for Kernel A does NOT open against Kernel B
 *      (transplant rejected).
 *   4. Wrong guardian: a different EOA's derived key cannot open the envelope.
 *   5. Tamper: flipping a ciphertext byte fails the Poly1305 tag.
 *
 * Run: node --import tsx apps/web/scripts/recovery-escrow-spike.ts
 */

import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import type { EIP712Signer } from "@woco/shared";
import {
  deriveGuardianEncryptionKeypair,
  sealRecoveryBundle,
  openRecoveryBundle,
  type RecoveryBundle,
} from "../src/lib/auth/recovery-escrow.js";

/** Adapt a viem local account to the WoCo EIP712Signer interface (primaryType =
 *  the single type key, exactly as requestPodIdentity's callers do). */
function viemSigner(account: ReturnType<typeof privateKeyToAccount>): EIP712Signer {
  return async (domain, types, value) => {
    const primaryType = Object.keys(types)[0];
    return account.signTypedData({
      domain: domain as Parameters<typeof account.signTypedData>[0]["domain"],
      types: types as Parameters<typeof account.signTypedData>[0]["types"],
      primaryType,
      message: value,
    });
  };
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
  console.log("  ✓", msg);
}

async function expectThrow(fn: () => Promise<unknown>, label: string) {
  try {
    await fn();
  } catch {
    console.log("  ✓", label, "(rejected)");
    return;
  }
  throw new Error("ASSERT FAILED: expected rejection — " + label);
}

async function main() {
  console.log("RECOVERY-ESCROW SPIKE\n");

  const kernelA = "0x8DEF5755D288f452837E3337b5799C19718a1922";
  const kernelB = "0x1111111111111111111111111111111111111111";

  const guardianAccount = privateKeyToAccount(generatePrivateKey());
  const attackerAccount = privateKeyToAccount(generatePrivateKey());
  const guardianSign = viemSigner(guardianAccount);
  const attackerSign = viemSigner(attackerAccount);

  const bundle: RecoveryBundle = {
    version: 1,
    secrets: { podSeed: "0x" + "ab".repeat(32) },
  };

  console.log("[1] derive guardian X25519 key + seal");
  const gk = await deriveGuardianEncryptionKeypair(guardianAccount.address, guardianSign);
  const envelope = await sealRecoveryBundle({
    bundle,
    kernelAddress: kernelA,
    guardianPublicKeysHex: [gk.publicKeyHex],
  });
  assert(envelope.kernelAddress === kernelA.toLowerCase(), "envelope bound to lowercased kernel A");
  assert(envelope.wrappedDeks.length === 1, "1-of-1 → single wrapped DEK");

  console.log("[2] open round-trip");
  const opened = await openRecoveryBundle({ envelope, kernelAddress: kernelA, guardianKeypair: gk });
  assert(opened.secrets.podSeed === bundle.secrets.podSeed, "recovered podSeed matches original");
  assert(opened.version === bundle.version, "recovered version matches");

  console.log("[3] deterministic re-derivation (recoverable on any device)");
  const gk2 = await deriveGuardianEncryptionKeypair(guardianAccount.address, guardianSign);
  assert(gk2.publicKeyHex === gk.publicKeyHex, "same EOA → identical X25519 key");
  const openedAgain = await openRecoveryBundle({ envelope, kernelAddress: kernelA, guardianKeypair: gk2 });
  assert(openedAgain.secrets.podSeed === bundle.secrets.podSeed, "freshly re-derived key opens the same envelope");

  console.log("[4] AAD bind — transplant to kernel B rejected");
  await expectThrow(
    () => openRecoveryBundle({ envelope, kernelAddress: kernelB, guardianKeypair: gk }),
    "envelope for kernel A does not open against kernel B",
  );

  console.log("[5] wrong guardian rejected");
  const ak = await deriveGuardianEncryptionKeypair(attackerAccount.address, attackerSign);
  await expectThrow(
    () => openRecoveryBundle({ envelope, kernelAddress: kernelA, guardianKeypair: ak }),
    "attacker's derived key cannot open the envelope",
  );

  console.log("[6] ciphertext tamper rejected");
  const tampered = { ...envelope, ciphertext: flipFirstByte(envelope.ciphertext) };
  await expectThrow(
    () => openRecoveryBundle({ envelope: tampered, kernelAddress: kernelA, guardianKeypair: gk }),
    "Poly1305 tag fails on a flipped ciphertext byte",
  );

  console.log("\n========================================");
  console.log("RESULT: PASS ✓ escrow seal/open sound — AAD bind, wrong-guardian, tamper all rejected");
  console.log("========================================");
}

function flipFirstByte(hex: string): string {
  const b = parseInt(hex.slice(0, 2), 16) ^ 0xff;
  return b.toString(16).padStart(2, "0") + hex.slice(2);
}

main().catch((e) => {
  console.error("\nSPIKE ERROR:", e);
  process.exit(1);
});
