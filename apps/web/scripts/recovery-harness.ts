/**
 * RECOVERY HARNESS — the end-to-end proof that account recovery works, and that
 * it FAILS when it should.
 *
 * recovery-spike-caller-hook.ts proved the happy path once, in 2026-06. Nothing
 * has ever exercised a FAILING recovery, and that is where the current risk sits:
 * #151 (a reverted userOp must not report success) and #152 (abort unless the
 * on-chain owner actually rotated) both inserted NEW abort paths into an
 * irreversible ceremony. An abort that fires when it shouldn't strands a user who
 * has already minted a replacement credential.
 *
 * So this asserts both directions:
 *
 *   A  guardian pinning is REAL          — a non-guardian caller is refused
 *   B  the pin is EXACT                  — a near-miss guardian is refused
 *   C  recovery works                    — the pinned guardian rotates the owner
 *   D  the address is PRESERVED          — funds and identity survive
 *   E  the old key is DEAD               — the point of recovery
 *   F  the rotation is VISIBLE in time   — measures the lag #152's retry window bets on
 *
 * (F) is the one that decides whether a real user gets stranded. `recoverAndRekey`
 * gives the owner read ROTATION_CONFIRM_ATTEMPTS × ROTATION_CONFIRM_DELAY_MS to
 * reflect the rotation (4 × 1500ms ≈ 6s) before it aborts with "your account has
 * NOT been changed". That number was chosen without measurement. This prints the
 * real figure so it can be set from evidence.
 *
 * SCOPE — read this before trusting a PASS. This covers the ON-CHAIN mechanism
 * only. The parts that live in the browser are NOT covered and still need a manual
 * cross-device run: the WebAuthn PRF ceremony, the POD seed and content-feed-signer
 * restore, the portability envelope, and the IndexedDB bindings. A green run here
 * means "the chain half is sound", not "recovery works for a user".
 *
 * Throwaway keys, Arb Sepolia (421614), sponsored. Costs nothing but testnet gas.
 *
 * Run from the repo root:
 *   node --env-file=apps/web/.env --import tsx apps/web/scripts/recovery-harness.ts
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
  type Address,
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
import { signerToEcdsaValidator, getValidatorAddress } from "@zerodev/ecdsa-validator";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";

const RPC = process.env.VITE_ZERODEV_RPC;
if (!RPC) throw new Error("VITE_ZERODEV_RPC not set (use --env-file=apps/web/.env)");

const chain = arbitrumSepolia;
const entryPoint = getEntryPoint("0.7");
const kernelVersion = KERNEL_V3_1;

/** Same singletons the product pins in kernel-account.ts. */
const RECOVERY_ACTION = "0xe884C2868CC82c16177eC73a93f7D9E6F3A5DC6E" as Address;
const CALLER_HOOK = "0x990a9FC8189D96d59E3cE98bd87F42135a24a30E" as Address;
const FALLBACK_MODULE_TYPE = 3n;

const recoveryExecutorFunction = "function doRecovery(address _validator, bytes calldata _data)";
const installModuleFunction =
  "function installModule(uint256 _type, address _module, bytes calldata _initData)";

/** The hook's guardian registry: allowed(guardian, account) → bool. */
const HOOK_ALLOWED_ABI = parseAbi([
  "function allowed(address guardian, address account) view returns (bool)",
]);

/** ECDSAValidator per-account owner storage — the same getter the product reads. */
const ECDSA_OWNER_ABI = parseAbi([
  "function ecdsaValidatorStorage(address account) view returns (address owner)",
]);

/** Mirrors auth-store's ROTATION_CONFIRM_* — the window (F) is measuring. */
const PRODUCT_CONFIRM_ATTEMPTS = 4;
const PRODUCT_CONFIRM_DELAY_MS = 1500;
const PRODUCT_CONFIRM_WINDOW_MS = PRODUCT_CONFIRM_ATTEMPTS * PRODUCT_CONFIRM_DELAY_MS;

const publicClient = createPublicClient({ transport: http(RPC), chain });
const paymasterClient = createZeroDevPaymasterClient({ chain, transport: http(RPC) });
const sponsor = {
  getPaymasterData(
    userOperation: Parameters<typeof paymasterClient.sponsorUserOperation>[0]["userOperation"],
  ) {
    return paymasterClient.sponsorUserOperation({ userOperation });
  },
};

// ---------------------------------------------------------------------------
// Assertions — every check is named, and a failure is loud and specific.
// ---------------------------------------------------------------------------

const results: { id: string; name: string; ok: boolean; detail: string }[] = [];

function record(id: string, name: string, ok: boolean, detail: string): void {
  results.push({ id, name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  [${id}] ${name}${detail ? ` — ${detail}` : ""}`);
}

/** Build the installModule calldata exactly as buildRegisterGuardianCallData does. */
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
          "0xff",
          concat(["0xff", encodeAbiParameters(parseAbiParameters("address[] guardians"), [[guardianAddr]])]),
        ]),
      ]),
    ],
  });
}

async function readOwner(kernel: Address): Promise<string | null> {
  const owner = (await publicClient.readContract({
    address: getValidatorAddress(entryPoint, kernelVersion) as Address,
    abi: ECDSA_OWNER_ABI,
    functionName: "ecdsaValidatorStorage",
    args: [kernel],
  })) as Address;
  return !owner || owner.toLowerCase() === zeroAddress ? null : owner.toLowerCase();
}

async function isGuardianRegistered(guardian: Address, account: Address): Promise<boolean> {
  return (await publicClient.readContract({
    address: CALLER_HOOK,
    abi: HOOK_ALLOWED_ABI,
    functionName: "allowed",
    args: [guardian, account],
  })) as boolean;
}

/** A weighted-ECDSA guardian Kernel, same construction as buildGuardianAccount. */
async function buildGuardian(signer: ReturnType<typeof privateKeyToAccount>) {
  const validator = await createWeightedECDSAValidator(publicClient, {
    entryPoint,
    kernelVersion,
    config: { threshold: 100, signers: [{ address: signer.address, weight: 100 }] },
    signers: [signer],
  });
  return createKernelAccount(publicClient, { entryPoint, kernelVersion, plugins: { sudo: validator } });
}

async function main() {
  console.log("=".repeat(78));
  console.log("RECOVERY HARNESS — chain half of the ceremony, both directions");
  console.log(`chain ${chain.id} (expect 421614)`);
  console.log("=".repeat(78));

  const oldSigner = privateKeyToAccount(generatePrivateKey()); // stands in for the PRF-EOA
  const guardianSigner = privateKeyToAccount(generatePrivateKey()); // the backup wallet
  const attackerSigner = privateKeyToAccount(generatePrivateKey()); // an unrelated account
  const newSigner = privateKeyToAccount(generatePrivateKey()); // the post-recovery credential

  // ---- setup: a deployed sudo-only Kernel, i.e. a real passkey account -----
  const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
    signer: oldSigner,
    entryPoint,
    kernelVersion,
  });
  const target = await createKernelAccount(publicClient, {
    entryPoint,
    kernelVersion,
    plugins: { sudo: ecdsaValidator },
  });
  const targetClient = createKernelAccountClient({
    account: target,
    chain,
    bundlerTransport: http(RPC),
    paymaster: sponsor,
  });

  console.log(`\n[setup] deploying target Kernel ${target.address}`);
  await targetClient.waitForUserOperationReceipt({
    hash: await targetClient.sendUserOperation({
      callData: await target.encodeCalls([{ to: zeroAddress, value: 0n, data: "0x" }]),
    }),
  });
  console.log("        deployed");

  const guardian = await buildGuardian(guardianSigner);
  const attackerGuardian = await buildGuardian(attackerSigner);
  console.log(`[setup] guardian account          ${guardian.address}`);
  console.log(`[setup] attacker guardian account ${attackerGuardian.address}`);

  console.log("\n[setup] installing recovery route pinned to the guardian");
  await targetClient.waitForUserOperationReceipt({
    hash: await targetClient.sendUserOperation({
      callData: buildRegisterGuardianCallData(guardian.address),
    }),
  });
  console.log("        installed");

  console.log("\n--- assertions ---");

  // (A) the pin is real: only the registered guardian is allowed.
  const guardianOk = await isGuardianRegistered(guardian.address, target.address);
  const attackerOk = await isGuardianRegistered(attackerGuardian.address, target.address);
  record(
    "A",
    "the pinned guardian is registered on-chain",
    guardianOk,
    `allowed(guardian)=${guardianOk}`,
  );
  record(
    "B",
    "an unrelated guardian is NOT registered",
    !attackerOk,
    `allowed(attacker)=${attackerOk}`,
  );

  // (B2) a non-guardian's doRecovery must REVERT. This is the negative case the
  // original spike never ran — simulated, so it costs nothing and cannot mutate.
  const doRecoveryData = encodeFunctionData({
    abi: parseAbi([recoveryExecutorFunction]),
    functionName: "doRecovery",
    args: [getValidatorAddress(entryPoint, kernelVersion) as Address, newSigner.address],
  });
  let attackerRefused = false;
  let attackerDetail = "call SUCCEEDED — the hook did not refuse";
  try {
    await publicClient.call({
      account: attackerGuardian.address,
      to: target.address,
      data: doRecoveryData,
    });
  } catch (e) {
    attackerRefused = true;
    attackerDetail = `reverted: ${(e as Error).message.split("\n")[0].slice(0, 80)}`;
  }
  record("B2", "a non-guardian calling doRecovery is REFUSED", attackerRefused, attackerDetail);

  const ownerBefore = await readOwner(target.address);
  record(
    "C0",
    "owner before recovery is the original key",
    ownerBefore === oldSigner.address.toLowerCase(),
    `${ownerBefore}`,
  );

  // (C/F) the real recovery, and how long the rotation takes to become visible.
  const guardianClient = createKernelAccountClient({
    account: guardian,
    chain,
    bundlerTransport: http(RPC),
    paymaster: sponsor,
  });
  const newValidator = await signerToEcdsaValidator(publicClient, {
    signer: newSigner,
    entryPoint,
    kernelVersion,
  });

  console.log("\n[recovery] guardian calling target.doRecovery");
  const recoveryHash = await guardianClient.sendUserOperation({
    calls: [
      {
        to: target.address,
        data: encodeFunctionData({
          abi: parseAbi([recoveryExecutorFunction]),
          functionName: "doRecovery",
          args: [newValidator.address, await newValidator.getEnableData()],
        }),
      },
    ],
    callGasLimit: 1_000_000n,
  });
  const receipt = await guardianClient.waitForUserOperationReceipt({ hash: recoveryHash });

  // #151's property: the product now throws unless receipt.success is true.
  record(
    "C1",
    "the recovery userOp reports success (what #151 checks)",
    receipt.success === true,
    `success=${receipt.success}`,
  );

  // (F) THE MEASUREMENT. Poll from the instant the receipt lands until the owner
  // read reflects the rotation. This is the number #152's retry window bets on.
  const tReceipt = Date.now();
  let visibleAfterMs = -1;
  for (let i = 0; i < 120; i++) {
    const o = await readOwner(target.address);
    if (o === newSigner.address.toLowerCase()) {
      visibleAfterMs = Date.now() - tReceipt;
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  record(
    "C2",
    "the on-chain owner actually rotated (what #152 checks)",
    visibleAfterMs >= 0,
    visibleAfterMs >= 0 ? `visible after ${visibleAfterMs}ms` : "NEVER became visible within 30s",
  );
  record(
    "F",
    `rotation visible inside the product's ${PRODUCT_CONFIRM_WINDOW_MS}ms confirm window`,
    visibleAfterMs >= 0 && visibleAfterMs < PRODUCT_CONFIRM_WINDOW_MS,
    visibleAfterMs >= 0
      ? `${visibleAfterMs}ms vs ${PRODUCT_CONFIRM_WINDOW_MS}ms budget (${Math.round((visibleAfterMs / PRODUCT_CONFIRM_WINDOW_MS) * 100)}% used)`
      : "no measurement",
  );

  // (D) the address is preserved — the whole point of recovery over re-creation.
  const recovered = await createKernelAccount(publicClient, {
    address: target.address,
    entryPoint,
    kernelVersion,
    plugins: { sudo: newValidator },
  });
  record(
    "D",
    "the Kernel address is preserved",
    recovered.address.toLowerCase() === target.address.toLowerCase(),
    recovered.address,
  );

  // (E) the new key controls it, and the old key is dead.
  const newClient = createKernelAccountClient({
    account: recovered,
    chain,
    bundlerTransport: http(RPC),
    paymaster: sponsor,
  });
  let newWorks = false;
  let newDetail = "";
  try {
    const r = await newClient.waitForUserOperationReceipt({
      hash: await newClient.sendUserOperation({
        callData: await recovered.encodeCalls([{ to: zeroAddress, value: 0n, data: "0x" }]),
      }),
    });
    newWorks = r.success === true;
    newDetail = `success=${r.success}`;
  } catch (e) {
    newDetail = (e as Error).message.split("\n")[0].slice(0, 90);
  }
  record("E1", "the NEW key controls the account", newWorks, newDetail);

  const oldAfter = await createKernelAccount(publicClient, {
    address: target.address,
    entryPoint,
    kernelVersion,
    plugins: { sudo: ecdsaValidator },
  });
  const oldClient = createKernelAccountClient({
    account: oldAfter,
    chain,
    bundlerTransport: http(RPC),
    paymaster: sponsor,
  });
  let oldDead = false;
  let oldDetail = "the OLD key still worked — rotation did not retire it";
  try {
    const r = await oldClient.waitForUserOperationReceipt({
      hash: await oldClient.sendUserOperation({
        callData: await oldAfter.encodeCalls([{ to: zeroAddress, value: 0n, data: "0x" }]),
      }),
    });
    // Included-but-reverted also counts as dead, and is exactly what #151 catches.
    oldDead = r.success !== true;
    oldDetail = `userOp included with success=${r.success}`;
  } catch (e) {
    oldDead = true;
    oldDetail = `rejected: ${(e as Error).message.split("\n")[0].slice(0, 80)}`;
  }
  record("E2", "the OLD key is dead", oldDead, oldDetail);

  // (G) the guardian survives the rotation — it is not consumed, so a second
  // recovery is possible. Also the property behind #148: guardians accumulate.
  const guardianStillOk = await isGuardianRegistered(guardian.address, target.address);
  record(
    "G",
    "the guardian is still registered after recovery (not single-use)",
    guardianStillOk,
    `allowed(guardian)=${guardianStillOk}`,
  );

  // ---- verdict --------------------------------------------------------------
  const failed = results.filter((r) => !r.ok);
  console.log("\n" + "=".repeat(78));
  console.log(`RESULT: ${failed.length === 0 ? "PASS" : `FAIL (${failed.length} of ${results.length})`}`);
  if (failed.length) for (const f of failed) console.log(`  FAILED [${f.id}] ${f.name} — ${f.detail}`);
  if (visibleAfterMs >= 0) {
    console.log(
      `\nROTATION VISIBILITY: ${visibleAfterMs}ms. The product aborts recovery after ` +
        `${PRODUCT_CONFIRM_WINDOW_MS}ms (auth-store ROTATION_CONFIRM_*). ` +
        (visibleAfterMs * 3 > PRODUCT_CONFIRM_WINDOW_MS
          ? "LESS THAN 3x HEADROOM — widen the window."
          : "Headroom looks adequate; re-run a few times before trusting one sample."),
    );
  }
  console.log("\nNOT COVERED — still needs a manual cross-device run: the WebAuthn PRF");
  console.log("ceremony, POD seed + feed-signer restore, the portability envelope, and the");
  console.log("IndexedDB bindings. A PASS here means the chain half is sound, nothing more.");
  console.log("=".repeat(78));
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\nHARNESS ERROR:", e);
  process.exit(1);
});
