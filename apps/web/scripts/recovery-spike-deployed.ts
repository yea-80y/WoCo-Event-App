/**
 * PHASE 0 SPIKE (part 2) — recovery on an ALREADY-DEPLOYED sudo-only Kernel.
 *
 * recovery-spike.ts proved the rotation primitive with the guardian baked in at
 * creation (counterfactual). WoCo's real passkey Kernels are created with
 * `{ sudo: ecdsaValidator }` only and are frequently ALREADY DEPLOYED (a sub-ENS
 * claim or an EAS like deploys them). This proves the realistic path (Path A —
 * weighted-ECDSA guardian + recovery action, the design that scales to social
 * M-of-N):
 *
 *   1. Deploy a sudo-only Kernel (no guardian) — the state real users are in.
 *   2. While the passkey still works, install the weighted-ECDSA guardian +
 *      recovery-action route post-deploy via v0.7 `installValidations`
 *      (`pluginMigrations`) on ONE sudo-signed userOp. The "Set up recovery"
 *      ceremony. (`encodeModuleInstallCallData()` is EP0.6-only.)
 *   3. Lose the passkey → the guardian rotates the sudo signer to a new key.
 *   4. Same address, new signer controls it, old signer dead.
 *
 * STATE (2026-06-17) — Path A deployed-install is PARTIALLY proven:
 *   ✓ step 1 deploy sudo-only Kernel
 *   ✓ step 2 install the weighted guardian validator post-deploy (userOp lands)
 *   ✓ the doRecovery executor ROUTE installs — the hand-built selectorData below
 *     (selector + executor addr + actionHook + delegatecall, per the SDK's
 *     getEncodedPluginsData) cleared the earlier 0x7352d91c "no route" revert.
 *     The migration helper getValidatorPluginInstallModuleData truncates
 *     selectorData to the 4-byte selector → no executor route.
 *   ✗ step 3 the guardian recovery userOp fails VALIDATION: AA23 reverted
 *     0x682a6e7c = InvalidValidator(). The validator IS initialized
 *     (getCurrentSigners + isInitialized(account)=true) and the SDK selects
 *     use-mode — so this is NOT an enable/init gap. CONCLUSION: a
 *     post-deploy-installed weighted validator validating the target's OWN
 *     recovery userOp is not a supported Kernel v3.1 flow (works only baked-in
 *     at genesis — see recovery-spike.ts, PASS).
 *
 * PIVOT (Phase 1): for deployed accounts use ZeroDev's actual deployed-recovery
 * flow (zerodev-examples recovery_call.ts): install the recovery action as a
 * FALLBACK (module type 3) + a caller hook holding the guardian address(es); a
 * SEPARATE guardian account calls target.doRecovery(...). Both singletons are
 * LIVE on Arb Sepolia (action 0xe884…, caller hook 0x990a9FC8…). Keep M-of-N by
 * making the guardian account itself a weighted-ECDSA multisig. The COUNTERFACTUAL
 * path (recovery-spike.ts) + the rotation primitive are fully PROVEN regardless.
 * This file is kept as the record of WHY we pivoted (the InvalidValidator dead-end).
 *
 * Run: node --env-file=apps/web/.env --import tsx apps/web/scripts/recovery-spike-deployed.ts
 */

import {
  createKernelAccount,
  createZeroDevPaymasterClient,
  createKernelAccountClient,
} from "@zerodev/sdk";
import { PLUGIN_TYPE } from "@zerodev/sdk/constants";
import {
  http,
  createPublicClient,
  parseAbi,
  parseAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  concatHex,
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

const oldSigner = privateKeyToAccount(generatePrivateKey()); // PRF stand-in
const guardian = privateKeyToAccount(generatePrivateKey());
const newSigner = privateKeyToAccount(generatePrivateKey());

const recoveryExecutorFunction =
  "function doRecovery(address _validator, bytes calldata _data)";
const recoveryAction = getRecoveryAction(entryPoint.version);

async function main() {
  console.log("chain:", chain.id);

  const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
    signer: oldSigner,
    entryPoint,
    kernelVersion,
  });

  // (1) Deploy a sudo-ONLY Kernel — exactly how WoCo creates passkey accounts.
  const sudoOnlyAccount = await createKernelAccount(publicClient, {
    entryPoint,
    plugins: { sudo: ecdsaValidator },
    kernelVersion,
  });
  const sudoClient = createKernelAccountClient({
    account: sudoOnlyAccount,
    chain,
    bundlerTransport: http(RPC),
    paymaster: sponsor,
  });
  console.log("\n[1] deploying sudo-only Kernel:", sudoOnlyAccount.address);
  const deployHash = await sudoClient.sendUserOperation({
    callData: await sudoOnlyAccount.encodeCalls([{ to: zeroAddress, value: 0n, data: "0x" }]),
  });
  await sudoClient.waitForUserOperationReceipt({ hash: deployHash });
  console.log("    deployed ✓");

  // (2) "Set up recovery" on the deployed account: install the weighted guardian
  // validator, scoped to the recovery-action selector, via pluginMigrations. The
  // SDK auto-prepends the installModule call to the next (sudo-signed) userOp.
  const guardianValidator = await createWeightedECDSAValidator(publicClient, {
    entryPoint,
    config: { threshold: 100, signers: [{ address: guardian.address, weight: 100 }] },
    signers: [guardian],
    kernelVersion,
  });
  // Hand-build the validator install data with the FULL action route in
  // selectorData (matches the counterfactual getEncodedPluginsData format):
  // selector(4) + executor addr(20) + actionHook(20) + abi(selectorInitData,
  // hookInitData). The SDK's getValidatorPluginInstallModuleData truncates
  // selectorData to the 4-byte selector → no executor route → doRecovery reverts
  // (0x7352d91c). Including the executor address (0xe884) installs the route.
  const selectorData = concatHex([
    recoveryAction.selector,
    recoveryAction.address,
    zeroAddress, // action hook
    encodeAbiParameters(parseAbiParameters("bytes selectorInitData, bytes hookInitData"), [
      "0xFF", // CALL_TYPE.DELEGATE_CALL
      "0x0000",
    ]),
  ]);
  const guardianInstallData = {
    type: PLUGIN_TYPE.VALIDATOR,
    address: guardianValidator.address,
    data: concatHex([
      zeroAddress, // validator hook (none)
      encodeAbiParameters(parseAbiParameters("bytes validatorData, bytes hookData, bytes selectorData"), [
        await guardianValidator.getEnableData(),
        "0x",
        selectorData,
      ]),
    ]),
  };

  const accountForInstall = await createKernelAccount(publicClient, {
    address: sudoOnlyAccount.address,
    entryPoint,
    plugins: { sudo: ecdsaValidator }, // sudo signs the install
    pluginMigrations: [guardianInstallData],
    kernelVersion,
  });
  const installClient = createKernelAccountClient({
    account: accountForInstall,
    chain,
    bundlerTransport: http(RPC),
    paymaster: sponsor,
  });
  console.log("\n[2] installing guardian validator (sudo-signed pluginMigration)...");
  const installHash = await installClient.sendUserOperation({
    callData: await accountForInstall.encodeCalls([{ to: zeroAddress, value: 0n, data: "0x" }]),
  });
  await installClient.waitForUserOperationReceipt({ hash: installHash });
  console.log("    recovery configured ✓", installHash);

  // (3) Lost passkey → guardian rotates sudo to newSigner. Guardian account
  // reflects the now-installed regular validator + recovery action.
  const guardianAccount = await createKernelAccount(publicClient, {
    address: sudoOnlyAccount.address,
    entryPoint,
    plugins: { sudo: ecdsaValidator, regular: guardianValidator, action: recoveryAction },
    kernelVersion,
  });
  const guardianClient = createKernelAccountClient({
    account: guardianAccount,
    chain,
    bundlerTransport: http(RPC),
    paymaster: sponsor,
  });
  console.log("\n[3] guardian performing recovery...");
  const recoveryHash = await guardianClient.sendUserOperation({
    callData: encodeFunctionData({
      abi: parseAbi([recoveryExecutorFunction]),
      functionName: "doRecovery",
      args: [getValidatorAddress(entryPoint, kernelVersion), newSigner.address],
    }),
  });
  await guardianClient.waitForUserOperationReceipt({ hash: recoveryHash });
  console.log("    recovery userOp ✓", recoveryHash);

  // (4) New signer controls the SAME address; old signer dead.
  const newEcdsaValidator = await signerToEcdsaValidator(publicClient, {
    signer: newSigner,
    entryPoint,
    kernelVersion,
  });
  const newAccount = await createKernelAccount(publicClient, {
    address: sudoOnlyAccount.address,
    entryPoint,
    plugins: { sudo: newEcdsaValidator },
    kernelVersion,
  });
  const newClient = createKernelAccountClient({
    account: newAccount,
    chain,
    bundlerTransport: http(RPC),
    paymaster: sponsor,
  });
  console.log("\n[4] new-signer userOp on the same address...");
  const newOpHash = await newClient.sendUserOperation({
    callData: await newAccount.encodeCalls([{ to: zeroAddress, value: 0n, data: "0x" }]),
  });
  await newClient.waitForUserOperationReceipt({ hash: newOpHash });
  console.log("    new signer controls account ✓", newOpHash);

  console.log("\n[5] confirming OLD signer is dead...");
  const oldAfter = await createKernelAccount(publicClient, {
    address: sudoOnlyAccount.address,
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
    const h = await oldClient.sendUserOperation({
      callData: await oldAfter.encodeCalls([{ to: zeroAddress, value: 0n, data: "0x" }]),
    });
    await oldClient.waitForUserOperationReceipt({ hash: h });
    console.error("    !! OLD SIGNER STILL WORKED:", h);
  } catch (e) {
    oldDead = true;
    console.log("    old signer rejected ✓ —", (e as Error).message.split("\n")[0].slice(0, 120));
  }

  console.log("\n========================================");
  console.log("RESULT:", oldDead
    ? "PASS ✓ deployed-account install + rotation works, address preserved, old key dead"
    : "FAIL ✗");
  console.log("========================================");
  process.exit(oldDead ? 0 : 1);
}

main().catch((e) => { console.error("\nSPIKE ERROR:", e); process.exit(1); });
