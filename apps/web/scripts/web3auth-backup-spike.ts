/**
 * WEB3AUTH BACKUP-FACTOR VERIFICATION SPIKE (PASSKEY_RECOVERY_PLAN §12.4).
 *
 * Decides whether Web3Auth can serve as a recovery backup factor (replacing Para)
 * by proving the part that determines it: a Web3Auth-shaped input drives BOTH
 * recovery roles deterministically, with NO new crypto dependency.
 *
 * KEY FACT (researched 2026-06-20): Web3Auth PnP reconstructs a standard secp256k1
 * private key CLIENT-SIDE (ShareA device + ShareC recovery — non-MPC; the MPC Core
 * Kit never assembles the key and is the WRONG product here). The PnP EVM provider
 * exposes that key (`eth_private_key` provider request). So a Web3Auth backup hands
 * us a raw hex key — identical in shape to `generatePrivateKey()` here. That means
 * WE own determinism via viem's RFC6979 ECDSA, instead of trusting a provider's
 * signing implementation (the exact risk that made this a gate).
 *
 * This spike SIMULATES that raw key and asserts:
 *   1. ESCROW determinism (the gate): signing the fixed RECOVERY_ENC typed data is
 *      BYTE-IDENTICAL across calls → the X25519 escrow key is stable → recoverable
 *      on any device. (Proven at the signature level, not just the derived key.)
 *   2. The real escrow seal/open round-trips with this key (drives recovery-escrow.ts).
 *   3. GUARDIAN role: the same key yields a viem LocalAccount that satisfies the
 *      `getGuardianSigner` contract (∈ OneOf<… | LocalAccount | …> + EIP-191
 *      personal_sign, which is how the weighted-ECDSA approval is signed) → a
 *      Web3Auth backup is `recoveryReady` (not a trapped account).
 *
 * What this CANNOT prove headlessly (needs the owner's browser + a Web3Auth client
 * ID, batched with the §2026-06-19b funds-safety test): the interactive email login,
 * and that Web3Auth returns the SAME key for the same user across devices (true by
 * design — same login → same shares → same reconstructed key — but verify live).
 *
 * Run: node --import tsx apps/web/scripts/web3auth-backup-spike.ts
 */

import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import type { EIP712Signer } from "@woco/shared";
import {
  RECOVERY_ENC_DOMAIN,
  RECOVERY_ENC_TYPES,
  RECOVERY_ENC_NONCE,
} from "@woco/shared";
import {
  deriveGuardianEncryptionKeypair,
  sealRecoveryBundle,
  openRecoveryBundle,
  type RecoveryBundle,
} from "../src/lib/auth/recovery-escrow.js";

/** Adapt a viem local account to the WoCo EIP712Signer interface (primaryType =
 *  the single type key — identical to the escrow spike + requestPodIdentity callers). */
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

async function main() {
  console.log("WEB3AUTH BACKUP-FACTOR SPIKE\n");

  // A Web3Auth PnP backup hands us a reconstructed secp256k1 key. Shape-identical
  // to this. (Live: `await provider.request({ method: "eth_private_key" })`.)
  const web3authPrivKey = generatePrivateKey();
  const account = privateKeyToAccount(web3authPrivKey);
  const sign = viemSigner(account);

  const kernel = "0x8DEF5755D288f452837E3337b5799C19718a1922";

  console.log("[1] ESCROW determinism — fixed RECOVERY_ENC sig is byte-identical (the gate)");
  const message = {
    purpose: "Derive recovery-escrow encryption key",
    address: account.address,
    nonce: RECOVERY_ENC_NONCE,
  };
  const sigA = await sign({ ...RECOVERY_ENC_DOMAIN }, RECOVERY_ENC_TYPES as never, message);
  const sigB = await sign({ ...RECOVERY_ENC_DOMAIN }, RECOVERY_ENC_TYPES as never, message);
  assert(sigA === sigB, "same key + same typed data → byte-identical signature (RFC6979, viem-owned)");

  console.log("[2] derive X25519 escrow key twice — stable (recoverable on any device)");
  const k1 = await deriveGuardianEncryptionKeypair(account.address, sign);
  const k2 = await deriveGuardianEncryptionKeypair(account.address, sign);
  assert(k1.publicKeyHex === k2.publicKeyHex, "re-derived escrow pubkey is identical");

  console.log("[3] real escrow seal/open round-trips with the Web3Auth key");
  const bundle: RecoveryBundle = { version: 1, secrets: { podSeed: "0x" + "cd".repeat(32) } };
  const envelope = await sealRecoveryBundle({
    bundle,
    kernelAddress: kernel,
    guardianPublicKeysHex: [k1.publicKeyHex],
  });
  const opened = await openRecoveryBundle({ envelope, kernelAddress: kernel, guardianKeypair: k2 });
  assert(opened.secrets.podSeed === bundle.secrets.podSeed, "recovered podSeed matches original");

  console.log("[4] GUARDIAN role — the same key is a viem signer for the rotation userOp");
  // backup-signer.ts: guardian = a viem Signer (OneOf<… | LocalAccount | …>) and the
  // weighted-ECDSA approval is an EIP-191 personal_sign. A LocalAccount satisfies both.
  assert(account.type === "local", "privateKeyToAccount → viem LocalAccount (∈ guardian-signer OneOf)");
  assert(typeof account.signMessage === "function", "exposes personal_sign for the weighted-ECDSA approval");
  assert(typeof account.signTypedData === "function", "exposes typed-data signing for escrow derivation");
  const personalSig = await account.signMessage({ message: "woco-recovery-guardian-approval" });
  assert(personalSig.startsWith("0x") && personalSig.length === 132, "personal_sign returns a 65-byte sig");
  console.log("  → recoveryReady: true (a Web3Auth backup can complete a recovery — not a trapped account)");

  console.log("\n========================================");
  console.log("RESULT: PASS ✓ — a Web3Auth PnP raw key satisfies BOTH recovery roles");
  console.log("deterministically with ZERO new crypto deps (only the @web3auth login SDK).");
  console.log("REMAINING (browser, batch with funds-safety test): interactive email login +");
  console.log("same-user-same-key across devices (by design) + @web3auth/modal dep-compat vs viem 2.51.3.");
  console.log("========================================");
}

main().catch((e) => {
  console.error("\nSPIKE ERROR:", e);
  process.exit(1);
});
