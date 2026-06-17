/**
 * PHASE 1 ENTRY SPIKE — deployed-account recovery via the CALLER-HOOK flow
 * (docs/PASSKEY_RECOVERY_PLAN.md, "Phase 0 results" → pivot).
 *
 * recovery-spike-deployed.ts proved the dead-end: installing a weighted validator
 * onto a DEPLOYED Kernel and having it validate that account's OWN recovery userOp
 * reverts AA23 0x682a6e7c = InvalidValidator() (not a supported Kernel v3.1 flow;
 * works only baked-in at genesis — recovery-spike.ts PASS).
 *
 * This proves ZeroDev's ACTUAL deployed-recovery flow (zerodev-examples
 * guardians/recovery_call.ts), the model the plan pivoted to:
 *
 *   1. Deploy a sudo-only Kernel (the realistic WoCo passkey-account state).
 *   2. "Set up recovery" while the passkey still works: a sudo-signed userOp
 *      `installModule(type=3, RECOVERY_ACTION, initData)` installs the recovery
 *      action as a fallback/executor route, with a CALLER HOOK that holds the
 *      permitted guardian address(es). No weighted validator on the target.
 *   3. Lost passkey → a SEPARATE guardian ACCOUNT *calls* target.doRecovery(
 *      newValidator, enableData); the caller hook authorises by msg.sender.
 *   4. Same Kernel address, new signer controls it, old signer DEAD.
 *
 * M-of-N seam: the guardian account is itself a weighted-ECDSA Kernel
 * (backup EOA = 1-of-1 here; social = N signers / M threshold, SAME code), so
 * Path A's multisig value survives — relocated to the guardian account.
 *
 * Singletons (both LIVE on Arb Sepolia, same in the example):
 *   recovery action  0xe884C2868CC82c16177eC73a93f7D9E6F3A5DC6E (selector 0xac39fd0f)
 *   caller hook       0x990a9FC8189D96d59E3cE98bd87F42135a24a30E
 *
 * Funds-critical verification, throwaway accounts only, Arb Sepolia (421614).
 * Run: node --env-file=apps/web/.env --import tsx apps/web/scripts/recovery-spike-caller-hook.ts
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
  toFunctionSelector,
  parseAbi,
  parseAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  concat,
  zeroAddress,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { createWeightedECDSAValidator } from "@zerodev/weighted-ecdsa-validator";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";

const RPC = process.env.VITE_ZERODEV_RPC;
if (!RPC) throw new Error("VITE_ZERODEV_RPC not set (use --env-file=apps/web/.env)");

const chain = arbitrumSepolia;
const entryPoint = getEntryPoint("0.7");
const kernelVersion = KERNEL_V3_1;

// Cross-chain singletons (verified live on Arb Sepolia; identical in the example).
const RECOVERY_ACTION = "0xe884C2868CC82c16177eC73a93f7D9E6F3A5DC6E";
const CALLER_HOOK = "0x990a9FC8189D96d59E3cE98bd87F42135a24a30E";
const FALLBACK_MODULE_TYPE = 3n; // ERC-7579 fallback module (selector-routed)

const recoveryExecutorFunction =
  "function doRecovery(address _validator, bytes calldata _data)";
const installModuleFunction =
  "function installModule(uint256 _type, address _module, bytes calldata _initData)";

const publicClient = createPublicClient({ transport: http(RPC), chain });
const paymasterClient = createZeroDevPaymasterClient({ chain, transport: http(RPC) });
const sponsor = {
  getPaymasterData(userOperation: Parameters<typeof paymasterClient.sponsorUserOperation>[0]["userOperation"]) {
    return paymasterClient.sponsorUserOperation({ userOperation });
  },
};

// Throwaway keys: oldSigner = PRF-derived sudo stand-in; guardianSigner backs the
// weighted-ECDSA guardian ACCOUNT; newSigner = the post-recovery key.
const oldSigner = privateKeyToAccount(generatePrivateKey());
const guardianSigner = privateKeyToAccount(generatePrivateKey());
const newSigner = privateKeyToAccount(generatePrivateKey());

/**
 * initData for installModule(type=3): selector + caller-hook addr + abi(
 *   selectorData = 0xff (delegatecall),
 *   hookData = 0xff (install-hook flag) ++ abi(address[] guardians)
 * ). Verbatim from zerodev-examples recovery_call.ts registerGuardian().
 */
function buildRegisterGuardianCallData(guardianAddr: Hex): Hex {
  return encodeFunctionData({
    abi: parseAbi([installModuleFunction]),
    functionName: "installModule",
    args: [
      FALLBACK_MODULE_TYPE,
      RECOVERY_ACTION,
      concat([
        toFunctionSelector(parseAbi([recoveryExecutorFunction])[0]) as Hex,
        CALLER_HOOK as Hex,
        encodeAbiParameters(parseAbiParameters("bytes selectorData, bytes hookData"), [
          "0xff", // selectorData: delegatecall
          concat([
            "0xff", // flag: install the hook
            encodeAbiParameters(parseAbiParameters("address[] guardians"), [[guardianAddr]]),
          ]),
        ]),
      ]),
    ],
  });
}

async function main() {
  console.log("chain:", chain.id, "(expect 421614)");
  console.log("oldSigner     :", oldSigner.address);
  console.log("guardianSigner:", guardianSigner.address);
  console.log("newSigner     :", newSigner.address);

  // (1) Deploy a sudo-only Kernel — exactly how WoCo creates passkey accounts.
  const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
    signer: oldSigner,
    entryPoint,
    kernelVersion,
  });
  const targetAccount = await createKernelAccount(publicClient, {
    entryPoint,
    plugins: { sudo: ecdsaValidator },
    kernelVersion,
  });
  const targetClient = createKernelAccountClient({
    account: targetAccount,
    chain,
    bundlerTransport: http(RPC),
    paymaster: sponsor,
  });
  console.log("\n[1] deploying sudo-only target Kernel:", targetAccount.address);
  await targetClient.waitForUserOperationReceipt({
    hash: await targetClient.sendUserOperation({
      callData: await targetAccount.encodeCalls([{ to: zeroAddress, value: 0n, data: "0x" }]),
    }),
  });
  console.log("    deployed ✓");

  // Guardian ACCOUNT = a weighted-ECDSA Kernel (M-of-N seam; 1-of-1 here).
  const guardianValidator = await createWeightedECDSAValidator(publicClient, {
    entryPoint,
    config: { threshold: 100, signers: [{ address: guardianSigner.address, weight: 100 }] },
    signers: [guardianSigner],
    kernelVersion,
  });
  const guardianAccount = await createKernelAccount(publicClient, {
    entryPoint,
    plugins: { sudo: guardianValidator },
    kernelVersion,
  });
  console.log("\n[2] guardian account (weighted-ECDSA Kernel):", guardianAccount.address);

  // (2) "Set up recovery": sudo-signed installModule on the DEPLOYED target,
  // registering the guardian account as the permitted caller.
  console.log("\n[3] installing recovery action + caller hook (sudo-signed)...");
  await targetClient.waitForUserOperationReceipt({
    hash: await targetClient.sendUserOperation({
      callData: buildRegisterGuardianCallData(guardianAccount.address),
    }),
  });
  console.log("    recovery configured ✓");

  // (3) Lost passkey → the guardian account CALLS target.doRecovery.
  const newEcdsaValidator = await signerToEcdsaValidator(publicClient, {
    signer: newSigner,
    entryPoint,
    kernelVersion,
  });
  const guardianClient = createKernelAccountClient({
    account: guardianAccount,
    chain,
    bundlerTransport: http(RPC),
    paymaster: sponsor,
  });
  console.log("\n[4] guardian account calling target.doRecovery (rotate sudo → newSigner)...");
  const recoveryHash = await guardianClient.sendUserOperation({
    calls: [
      {
        to: targetAccount.address,
        data: encodeFunctionData({
          abi: parseAbi([recoveryExecutorFunction]),
          functionName: "doRecovery",
          args: [newEcdsaValidator.address, await newEcdsaValidator.getEnableData()],
        }),
      },
    ],
    callGasLimit: 1_000_000n,
  });
  await guardianClient.waitForUserOperationReceipt({ hash: recoveryHash });
  console.log("    recovery userOp ✓", recoveryHash);

  // (4) Same address, new signer controls it.
  const newAccount = await createKernelAccount(publicClient, {
    address: targetAccount.address,
    entryPoint,
    plugins: { sudo: newEcdsaValidator },
    kernelVersion,
  });
  if (newAccount.address.toLowerCase() !== targetAccount.address.toLowerCase()) {
    throw new Error(`ADDRESS CHANGED: ${targetAccount.address} -> ${newAccount.address}`);
  }
  console.log("\n[5] address preserved ✓", newAccount.address);

  const newClient = createKernelAccountClient({
    account: newAccount,
    chain,
    bundlerTransport: http(RPC),
    paymaster: sponsor,
  });
  console.log("[6] sending a no-op userOp with the NEW signer...");
  await newClient.waitForUserOperationReceipt({
    hash: await newClient.sendUserOperation({
      callData: await newAccount.encodeCalls([{ to: zeroAddress, value: 0n, data: "0x" }]),
    }),
  });
  console.log("    new signer controls account ✓");

  // (5) OLD signer is DEAD.
  console.log("\n[7] confirming the OLD signer is dead (expect failure)...");
  const oldAfter = await createKernelAccount(publicClient, {
    address: targetAccount.address,
    entryPoint,
    plugins: { sudo: ecdsaValidator },
    kernelVersion,
  });
  const oldClient = createKernelAccountClient({
    account: oldAfter,
    chain,
    bundlerTransport: http(RPC),
    paymaster: sponsor,
  });
  let oldDead = false;
  try {
    await oldClient.waitForUserOperationReceipt({
      hash: await oldClient.sendUserOperation({
        callData: await oldAfter.encodeCalls([{ to: zeroAddress, value: 0n, data: "0x" }]),
      }),
    });
    console.error("    !! OLD SIGNER STILL WORKED — rotation did NOT retire it");
  } catch (e) {
    oldDead = true;
    console.log("    old-signer userOp rejected ✓ —", (e as Error).message.split("\n")[0].slice(0, 140));
  }

  console.log("\n========================================");
  console.log("RESULT:", oldDead
    ? "PASS ✓ deployed-account caller-hook recovery works, address preserved, old key dead"
    : "FAIL ✗ old key not retired");
  console.log("========================================");
  process.exit(oldDead ? 0 : 1);
}

main().catch((e) => {
  console.error("\nSPIKE ERROR:", e);
  process.exit(1);
});
