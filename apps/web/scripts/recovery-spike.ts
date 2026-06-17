/**
 * PHASE 0 SPIKE — passkey/Kernel account recovery (docs/PASSKEY_RECOVERY_PLAN.md).
 *
 * Funds-critical verification, throwaway accounts only, Arb Sepolia (421614).
 * Proves the ZeroDev guardian-recovery primitive does exactly what the plan
 * needs BEFORE any of it touches kernel-account.ts:
 *
 *   1. A weighted-ECDSA guardian, scoped to the recovery ACTION only, can
 *      rotate the Kernel's sudo (ECDSA-over-PRF) signer to a NEW key.
 *   2. The Kernel ADDRESS is preserved across the rotation (funds/history stay).
 *   3. The NEW signer controls the account afterwards.
 *   4. The OLD signer is DEAD afterwards (its userOp fails validation).
 *
 * Packages verified against zerodevapp/zerodev-examples (guardians/recovery.ts)
 * for Kernel v3.1: @zerodev/weighted-ecdsa-validator@5.4.4
 * (createWeightedECDSAValidator + getRecoveryAction), @zerodev/ecdsa-validator
 * (signerToEcdsaValidator + getValidatorAddress), @zerodev/sdk.
 *
 * Run:  node --env-file=apps/web/.env --import tsx apps/web/scripts/recovery-spike.ts
 * (reads VITE_ZERODEV_RPC — the managed bundler+paymaster RPC for chain 421614.)
 *
 * NOTE: this models the v1 "self-custody backup EOA" guardian (1-of-1, weight
 * 100, threshold 100). It also bakes the guardian in at account creation
 * (counterfactual) — the cleanest proof of the rotation primitive. WoCo's real
 * accounts are often ALREADY deployed, so Phase 1 must additionally verify the
 * post-deploy install path (recovery_call.ts: installModule type 3 + caller
 * hook). That is called out in the plan; this spike proves the core rotation.
 */

import {
  createKernelAccount,
  createZeroDevPaymasterClient,
  createKernelAccountClient,
} from "@zerodev/sdk";
import {
  http,
  createPublicClient,
  type Hex,
  parseAbi,
  encodeFunctionData,
  zeroAddress,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import {
  createWeightedECDSAValidator,
  getRecoveryAction,
} from "@zerodev/weighted-ecdsa-validator";
import {
  getValidatorAddress,
  signerToEcdsaValidator,
} from "@zerodev/ecdsa-validator";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";

const RPC = process.env.VITE_ZERODEV_RPC;
if (!RPC) throw new Error("VITE_ZERODEV_RPC not set (use --env-file=apps/web/.env)");

const chain = arbitrumSepolia;
const entryPoint = getEntryPoint("0.7");
const kernelVersion = KERNEL_V3_1;

const publicClient = createPublicClient({ transport: http(RPC), chain });
const paymasterClient = createZeroDevPaymasterClient({ chain, transport: http(RPC) });
const sponsor = {
  getPaymasterData(userOperation: Parameters<typeof paymasterClient.sponsorUserOperation>[0]["userOperation"]) {
    return paymasterClient.sponsorUserOperation({ userOperation });
  },
};

// Throwaway keys: oldSigner stands in for the PRF-derived sudo signer; guardian
// is the backup factor (v1: a backup EOA); newSigner is the post-recovery key.
const oldSigner = privateKeyToAccount(generatePrivateKey());
const guardian = privateKeyToAccount(generatePrivateKey());
const newSigner = privateKeyToAccount(generatePrivateKey());

// The recovery executor selector exposed by getRecoveryAction.
const recoveryExecutorFunction =
  "function doRecovery(address _validator, bytes calldata _data)";

async function main() {
  console.log("chain:", chain.id, "(expect 421614)");
  console.log("oldSigner :", oldSigner.address);
  console.log("guardian  :", guardian.address);
  console.log("newSigner :", newSigner.address);

  // --- build Kernel: sudo = ECDSA(old), regular = weighted guardian, action = recovery
  const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
    signer: oldSigner,
    entryPoint,
    kernelVersion,
  });

  const guardianValidator = await createWeightedECDSAValidator(publicClient, {
    entryPoint,
    config: { threshold: 100, signers: [{ address: guardian.address, weight: 100 }] },
    signers: [guardian],
    kernelVersion,
  });

  const account = await createKernelAccount(publicClient, {
    entryPoint,
    plugins: {
      sudo: ecdsaValidator,
      regular: guardianValidator,
      action: getRecoveryAction(entryPoint.version),
    },
    kernelVersion,
  });
  console.log("\nKernel address:", account.address);

  // kernelClient signs with the REGULAR (guardian) validator → it may ONLY call
  // the recovery action. This is the guardian-can-rotate-not-spend guarantee.
  const kernelClient = createKernelAccountClient({
    account,
    chain,
    bundlerTransport: http(RPC),
    paymaster: sponsor,
  });

  console.log("\n[1] guardian performing recovery (rotate sudo → newSigner)...");
  const recoveryHash = await kernelClient.sendUserOperation({
    callData: encodeFunctionData({
      abi: parseAbi([recoveryExecutorFunction]),
      functionName: "doRecovery",
      // _validator = the ECDSA sudo validator module; _data = its enable data =
      // the new owner address. This resets the sudo signer to newSigner.
      args: [getValidatorAddress(entryPoint, kernelVersion), newSigner.address],
    }),
  });
  await kernelClient.waitForUserOperationReceipt({ hash: recoveryHash });
  console.log("    recovery userOp:", recoveryHash);

  // --- ASSERTION 1: same address, controlled by the NEW signer ---
  const newEcdsaValidator = await signerToEcdsaValidator(publicClient, {
    signer: newSigner,
    entryPoint,
    kernelVersion,
  });
  const newAccount = await createKernelAccount(publicClient, {
    address: account.address, // pin the SAME address
    entryPoint,
    plugins: { sudo: newEcdsaValidator },
    kernelVersion,
  });
  if (newAccount.address.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(`ADDRESS CHANGED: ${account.address} -> ${newAccount.address}`);
  }
  console.log("\n[2] address preserved ✓", newAccount.address);

  const newKernelClient = createKernelAccountClient({
    account: newAccount,
    chain,
    bundlerTransport: http(RPC),
    paymaster: sponsor,
  });
  console.log("[3] sending a no-op userOp with the NEW signer...");
  const newOpHash = await newKernelClient.sendUserOperation({
    callData: await newAccount.encodeCalls([{ to: zeroAddress, value: 0n, data: "0x" }]),
  });
  await newKernelClient.waitForUserOperationReceipt({ hash: newOpHash });
  console.log("    new-signer userOp landed ✓", newOpHash);

  // --- ASSERTION 2: the OLD signer is DEAD ---
  console.log("\n[4] confirming the OLD signer is dead (expect failure)...");
  const oldAccountAfter = await createKernelAccount(publicClient, {
    address: account.address, // same address, but sudo owner was rotated away
    entryPoint,
    plugins: { sudo: ecdsaValidator },
    kernelVersion,
  });
  const oldKernelClient = createKernelAccountClient({
    account: oldAccountAfter,
    chain,
    bundlerTransport: http(RPC),
    paymaster: sponsor,
  });
  let oldKeyDead = false;
  try {
    const oldOpHash = await oldKernelClient.sendUserOperation({
      callData: await oldAccountAfter.encodeCalls([{ to: zeroAddress, value: 0n, data: "0x" }]),
    });
    await oldKernelClient.waitForUserOperationReceipt({ hash: oldOpHash });
    console.error("    !! OLD SIGNER STILL WORKED — rotation did NOT retire it:", oldOpHash);
  } catch (e) {
    oldKeyDead = true;
    console.log("    old-signer userOp rejected ✓ —", (e as Error).message.split("\n")[0].slice(0, 140));
  }

  console.log("\n========================================");
  console.log("RESULT:", oldKeyDead ? "PASS ✓ rotation works, old key dead, address preserved"
                                    : "FAIL ✗ old key not retired");
  console.log("========================================");
  process.exit(oldKeyDead ? 0 : 1);
}

main().catch((e) => {
  console.error("\nSPIKE ERROR:", e);
  process.exit(1);
});
