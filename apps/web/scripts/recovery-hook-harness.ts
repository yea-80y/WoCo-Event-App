/**
 * GUARDIAN-HOOK HARNESS — the on-chain proof that the WoCo guardian hook (#164)
 * does what the product now claims, on a REAL Kernel v3.1 account on Arbitrum
 * Sepolia, through the real route (Kernel.fallback → hook.preCheck → delegatecall
 * doRecovery), not through the hook's own unit tests.
 *
 * What it asserts, in order:
 *
 *   A  install pins the set          — route hook == WoCo hook; guardiansOf == [G1]
 *   B  the pin is real               — a stranger's doRecovery is REFUSED (simulated)
 *   C  recovery works                — G1 rotates the owner; address preserved
 *   D  per-guardian revoke is real   — after revokeGuardian(G1), G1 is REFUSED
 *   E  append is append              — addGuardian(G2) keeps the route, set == [G2]
 *   F  G2 recovers                   — the new guardian rotates the owner again
 *   G  NO RESURRECTION               — re-install with [G3] → set == [G3], G1 and G2
 *                                      both REFUSED (the #148 sequence, now safe)
 *   H  the product's reads agree     — classifyRouteHook / isGuardian read-back
 *
 * Everything mutating runs through the same calldata builders the product uses
 * (`recovery-route.ts`, `guardian-hook.ts`). Throwaway keys, sponsored userOps,
 * costs nothing but testnet gas.
 *
 * Run from the repo root:
 *   node --env-file=apps/web/.env --import tsx apps/web/scripts/recovery-hook-harness.ts
 */
import {
  createKernelAccount,
  createZeroDevPaymasterClient,
  createKernelAccountClient,
  addressToEmptyAccount,
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
import { arbitrumSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import { signerToEcdsaValidator, getValidatorAddress } from "@zerodev/ecdsa-validator";
import { createWeightedECDSAValidator } from "@zerodev/weighted-ecdsa-validator";
import {
  KERNEL_SELECTOR_CONFIG_ABI,
  RECOVERY_ACTION_ADDRESS,
  RECOVERY_EXECUTOR_FN,
  buildRegisterGuardianCallData,
  recoveryRouteSelector,
} from "../src/lib/auth/recovery-route.js";
import {
  WOCO_GUARDIAN_HOOK,
  WOCO_GUARDIAN_HOOK_ABI,
  buildAddGuardianCall,
  buildRevokeGuardianCall,
  classifyRouteHook,
} from "../src/lib/auth/guardian-hook.js";
import { guardianConfigForBackup } from "../src/lib/auth/guardian-config.js";
import { guardianAddressFor } from "../src/lib/auth/guardian-address.js";

const RPC = process.env.VITE_ZERODEV_RPC;
if (!RPC) throw new Error("VITE_ZERODEV_RPC not set (run with --env-file=apps/web/.env)");

const chain = arbitrumSepolia;
const entryPoint = getEntryPoint("0.7");
const kernelVersion = KERNEL_V3_1;
/** ECDSA validator singleton for Kernel v3.1 — resolved by the SDK, never hand-typed. */
const ECDSA_VALIDATOR = getValidatorAddress(entryPoint, kernelVersion);
const publicClient = createPublicClient({ transport: http(RPC), chain });
const paymasterClient = createZeroDevPaymasterClient({ chain, transport: http(RPC) });
const sponsor = {
  getPaymasterData: (userOperation: Parameters<typeof paymasterClient.sponsorUserOperation>[0]["userOperation"]) =>
    paymasterClient.sponsorUserOperation({ userOperation }),
};
const encoders = { encodeFunctionData, parseAbi, parseAbiParameters, encodeAbiParameters, toFunctionSelector, concat };

const ECDSA_OWNER_ABI = parseAbi(["function ecdsaValidatorStorage(address account) view returns (address owner)"]);

const results: { id: string; name: string; ok: boolean; detail: string }[] = [];
function record(id: string, name: string, ok: boolean, detail = ""): void {
  results.push({ id, name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  [${id}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function readOwner(kernel: Address): Promise<string | null> {
  try {
    const o = (await publicClient.readContract({
      address: ECDSA_VALIDATOR, // ECDSA validator singleton (Kernel v3.1)
      abi: ECDSA_OWNER_ABI,
      functionName: "ecdsaValidatorStorage",
      args: [kernel],
    })) as Address;
    return o.toLowerCase();
  } catch {
    return null;
  }
}

async function readRoute(kernel: Address) {
  return (await publicClient.readContract({
    address: kernel,
    abi: KERNEL_SELECTOR_CONFIG_ABI,
    functionName: "selectorConfig",
    args: [recoveryRouteSelector(encoders)],
  })) as { hook: Address; target: Address; callType: Hex };
}

async function guardiansOf(kernel: Address): Promise<string[]> {
  const g = (await publicClient.readContract({
    address: WOCO_GUARDIAN_HOOK,
    abi: WOCO_GUARDIAN_HOOK_ABI,
    functionName: "guardiansOf",
    args: [kernel],
  })) as readonly Address[];
  return g.map((a) => a.toLowerCase());
}

async function isGuardian(kernel: Address, guardian: Address): Promise<boolean> {
  return (await publicClient.readContract({
    address: WOCO_GUARDIAN_HOOK,
    abi: WOCO_GUARDIAN_HOOK_ABI,
    functionName: "isGuardian",
    args: [kernel, guardian],
  })) as boolean;
}

/** Simulate `caller → target.doRecovery(...)`; true = reverted (refused). */
async function doRecoveryRefused(caller: Address, target: Address, newOwner: Address): Promise<{ refused: boolean; detail: string }> {
  const data = encodeFunctionData({
    abi: parseAbi([RECOVERY_EXECUTOR_FN]),
    functionName: "doRecovery",
    args: [ECDSA_VALIDATOR, newOwner],
  });
  try {
    await publicClient.call({ account: caller, to: target, data });
    return { refused: false, detail: "call SUCCEEDED — the hook did not refuse" };
  } catch (e) {
    const msg = (e as Error).message;
    // WoCoGuardianHook.NotAGuardian(address,address) selector
    const sel = toFunctionSelector("NotAGuardian(address,address)");
    return { refused: true, detail: msg.includes(sel.slice(2)) ? `reverted NotAGuardian` : `reverted: ${msg.split("\n")[0].slice(0, 70)}` };
  }
}

async function buildGuardian(signer: ReturnType<typeof privateKeyToAccount>) {
  const validator = await createWeightedECDSAValidator(publicClient, {
    entryPoint,
    kernelVersion,
    config: guardianConfigForBackup(signer.address),
    signers: [signer],
  });
  const account = await createKernelAccount(publicClient, { entryPoint, kernelVersion, plugins: { sudo: validator } });
  // #161 cross-check, the same one the product asserts before sending.
  const expected = guardianAddressFor(guardianConfigForBackup(signer.address));
  if (account.address.toLowerCase() !== expected) throw new Error(`guardian derivation drift: sdk ${account.address} pure ${expected}`);
  return account;
}

async function recoverWith(guardian: Awaited<ReturnType<typeof buildGuardian>>, target: Address, newSigner: ReturnType<typeof privateKeyToAccount>) {
  const client = createKernelAccountClient({ account: guardian, chain, bundlerTransport: http(RPC), paymaster: sponsor });
  const newValidator = await signerToEcdsaValidator(publicClient, { signer: newSigner, entryPoint, kernelVersion });
  const hash = await client.sendUserOperation({
    calls: [
      {
        to: target,
        data: encodeFunctionData({
          abi: parseAbi([RECOVERY_EXECUTOR_FN]),
          functionName: "doRecovery",
          args: [newValidator.address, await newValidator.getEnableData()],
        }),
      },
    ],
    callGasLimit: 1_000_000n,
  });
  return client.waitForUserOperationReceipt({ hash });
}

async function main() {
  console.log("=".repeat(78));
  console.log("GUARDIAN-HOOK HARNESS — WoCo hook on a real Kernel route, Arb Sepolia");
  console.log(`hook ${WOCO_GUARDIAN_HOOK}  chain ${chain.id}`);
  console.log("=".repeat(78));

  const owner0 = privateKeyToAccount(generatePrivateKey());
  const owner1 = privateKeyToAccount(generatePrivateKey());
  const owner2 = privateKeyToAccount(generatePrivateKey());
  const g1Signer = privateKeyToAccount(generatePrivateKey());
  const g2Signer = privateKeyToAccount(generatePrivateKey());
  const g3Signer = privateKeyToAccount(generatePrivateKey());
  const strangerSigner = privateKeyToAccount(generatePrivateKey());

  // ---- target: a deployed sudo-only Kernel (a real passkey account) ----------
  const ecdsaValidator = await signerToEcdsaValidator(publicClient, { signer: owner0, entryPoint, kernelVersion });
  const target = await createKernelAccount(publicClient, { entryPoint, kernelVersion, plugins: { sudo: ecdsaValidator } });
  const targetClient = createKernelAccountClient({ account: target, chain, bundlerTransport: http(RPC), paymaster: sponsor });
  console.log(`\n[setup] deploying target Kernel ${target.address}`);
  await targetClient.waitForUserOperationReceipt({
    hash: await targetClient.sendUserOperation({ callData: await target.encodeCalls([{ to: zeroAddress, value: 0n, data: "0x" }]) }),
  });

  const g1 = await buildGuardian(g1Signer);
  const g2 = await buildGuardian(g2Signer);
  const g3 = await buildGuardian(g3Signer);
  const stranger = await buildGuardian(strangerSigner);
  console.log(`[setup] G1 ${g1.address}\n[setup] G2 ${g2.address}\n[setup] G3 ${g3.address}\n[setup] stranger ${stranger.address}`);

  // ---- A: install the route against the WoCo hook with [G1] ------------------
  console.log("\n[A] installing route (WoCo hook) pinned to G1");
  await targetClient.waitForUserOperationReceipt({
    hash: await targetClient.sendUserOperation({ callData: buildRegisterGuardianCallData(encoders, g1.address) }),
  });
  const routeA = await readRoute(target.address);
  record("A1", "route hook is the WoCo hook", classifyRouteHook(routeA.hook) === "woco", `hook=${routeA.hook} target=${routeA.target} callType=${routeA.callType}`);
  record("A2", "route target is the recovery action", routeA.target.toLowerCase() === RECOVERY_ACTION_ADDRESS.toLowerCase());
  const setA = await guardiansOf(target.address);
  record("A3", "guardiansOf == [G1]", setA.length === 1 && setA[0] === g1.address.toLowerCase(), JSON.stringify(setA));

  // ---- B: the pin is real -----------------------------------------------------
  const b = await doRecoveryRefused(stranger.address, target.address, owner1.address);
  record("B", "a stranger's doRecovery is REFUSED", b.refused, b.detail);
  const b2 = await doRecoveryRefused(g1.address, target.address, owner1.address);
  record("B2", "G1's doRecovery is NOT refused (simulation passes the hook)", !b2.refused, b2.detail);

  // ---- C: G1 recovers ----------------------------------------------------------
  console.log("\n[C] G1 calling doRecovery → owner1");
  const rcC = await recoverWith(g1, target.address, owner1);
  record("C1", "recovery userOp success", rcC.success === true);
  await new Promise((r) => setTimeout(r, 2500));
  const ownerC = await readOwner(target.address);
  record("C2", "owner rotated to owner1, address preserved", ownerC === owner1.address.toLowerCase(), `owner=${ownerC}`);

  // ---- D: revoke G1 (sudo userOp by the NEW owner, through execute) -------------
  console.log("\n[D] revoking G1");
  const newValidator1 = await signerToEcdsaValidator(publicClient, { signer: owner1, entryPoint, kernelVersion });
  const target1 = await createKernelAccount(publicClient, { entryPoint, kernelVersion, plugins: { sudo: newValidator1 }, address: target.address });
  const target1Client = createKernelAccountClient({ account: target1, chain, bundlerTransport: http(RPC), paymaster: sponsor });
  await target1Client.waitForUserOperationReceipt({
    hash: await target1Client.sendUserOperation({ calls: [buildRevokeGuardianCall(encodeFunctionData, g1.address)] }),
  });
  record("D1", "isGuardian(G1) == false after revoke", (await isGuardian(target.address, g1.address)) === false);
  const d = await doRecoveryRefused(g1.address, target.address, owner2.address);
  record("D2", "G1's doRecovery is now REFUSED", d.refused, d.detail);
  const routeD = await readRoute(target.address);
  record("D3", "route still installed (revoke is per-guardian, not the route)", classifyRouteHook(routeD.hook) === "woco");

  // ---- E: append G2 ------------------------------------------------------------
  console.log("\n[E] addGuardian(G2)");
  await target1Client.waitForUserOperationReceipt({
    hash: await target1Client.sendUserOperation({ calls: [buildAddGuardianCall(encodeFunctionData, g2.address)] }),
  });
  const setE = await guardiansOf(target.address);
  record("E", "guardiansOf == [G2] (G1 gone, G2 appended)", setE.length === 1 && setE[0] === g2.address.toLowerCase(), JSON.stringify(setE));

  // ---- F: G2 recovers ----------------------------------------------------------
  console.log("\n[F] G2 calling doRecovery → owner2");
  const rcF = await recoverWith(g2, target.address, owner2);
  record("F1", "recovery userOp success", rcF.success === true);
  await new Promise((r) => setTimeout(r, 2500));
  const ownerF = await readOwner(target.address);
  record("F2", "owner rotated to owner2", ownerF === owner2.address.toLowerCase(), `owner=${ownerF}`);

  // ---- G: NO RESURRECTION — re-install with [G3] -------------------------------
  console.log("\n[G] re-installing the route with [G3] (the #148 sequence)");
  const newValidator2 = await signerToEcdsaValidator(publicClient, { signer: owner2, entryPoint, kernelVersion });
  const target2 = await createKernelAccount(publicClient, { entryPoint, kernelVersion, plugins: { sudo: newValidator2 }, address: target.address });
  const target2Client = createKernelAccountClient({ account: target2, chain, bundlerTransport: http(RPC), paymaster: sponsor });
  await target2Client.waitForUserOperationReceipt({
    hash: await target2Client.sendUserOperation({ callData: buildRegisterGuardianCallData(encoders, g3.address) }),
  });
  const setG = await guardiansOf(target.address);
  record("G1", "guardiansOf == [G3] — install REPLACED the set", setG.length === 1 && setG[0] === g3.address.toLowerCase(), JSON.stringify(setG));
  const g1r = await doRecoveryRefused(g1.address, target.address, owner0.address);
  const g2r = await doRecoveryRefused(g2.address, target.address, owner0.address);
  record("G2", "G1 (revoked earlier) is still REFUSED — no resurrection", g1r.refused, g1r.detail);
  record("G3", "G2 (replaced by the re-install) is REFUSED — no resurrection", g2r.refused, g2r.detail);
  const g3ok = await doRecoveryRefused(g3.address, target.address, owner0.address);
  record("G4", "G3 (current) passes the hook", !g3ok.refused, g3ok.detail);

  // ---- H: the product's reads agree ----------------------------------------
  record("H1", "isGuardian(G3) true / (G1,G2) false",
    (await isGuardian(target.address, g3.address)) === true &&
    (await isGuardian(target.address, g1.address)) === false &&
    (await isGuardian(target.address, g2.address)) === false);

  const failed = results.filter((r) => !r.ok);
  console.log("\n" + "=".repeat(78));
  console.log(`RESULT: ${failed.length === 0 ? "PASS" : `FAIL (${failed.length} of ${results.length})`}`);
  if (failed.length) for (const f of failed) console.log(`  FAILED [${f.id}] ${f.name} — ${f.detail}`);
  console.log(`target Kernel ${target.address} (inspect: selectorConfig(0xac39fd0f), hook.guardiansOf)`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("HARNESS CRASHED:", e);
  process.exit(2);
});
