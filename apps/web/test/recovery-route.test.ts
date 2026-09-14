/**
 * Semantics locks for the recovery selector route (#148, #165, #571).
 *
 * These encodings fail SILENTLY when wrong. `uninstallModule` does not revert
 * when the selector was never installed — `_uninstallSelector` just writes zeros
 * over zeros — so a malformed `deInitData` produces a green receipt and removes
 * nothing, and the user is told their backups are gone while every guardian still
 * holds account takeover. The only defences are the on-chain read-back in
 * `removeAllBackups` and these byte-level locks.
 *
 * The expected values are not derived from our own code. The selector and the
 * `selectorConfig` response shapes below were read by raw `eth_call` against
 * Arbitrum Sepolia (Kernel `0x41f1b4ff…`, `accountId() == "kernel.advanced.v0.3.1"`),
 * and the calldata layout is from `zerodevapp/kernel@release/v3.1`
 * (`Kernel.sol:443-456`, `core/SelectorManager.sol:63-73`). The install and removal
 * bytes at the bottom are also run by WoCo-Contracts `test/WoCoGuardianHookKernel.t.sol`
 * against the Kernel v3.1 bytecode deployed on Arbitrum One.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  concat,
  decodeAbiParameters,
  decodeFunctionData,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  parseAbi,
  parseAbiParameters,
  slice,
  toFunctionSelector,
  type Hex,
} from "viem";
import { encodeCallDataEpV07 } from "@zerodev/sdk";
import {
  INSTALL_MODULE_FN,
  KERNEL_SELECTOR_CONFIG_ABI,
  LEGACY_ZERODEV_CALLER_HOOK,
  RECOVERY_ACTION_ADDRESS,
  RECOVERY_CALLER_HOOK,
  UNINSTALL_MODULE_FN,
  buildRegisterGuardianCallData,
  buildRemoveRecoveryCalls,
  buildUninstallRecoveryCallData,
  recoveryRouteSelector,
} from "../src/lib/auth/recovery-route.js";
import { WOCO_GUARDIAN_HOOK, classifyRouteHook } from "../src/lib/auth/guardian-hook.js";

const d = {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  parseAbiParameters,
  toFunctionSelector,
};

test("the recovery route selector is doRecovery's 0xac39fd0f", () => {
  // Read off chain: selectorConfig(0xac39fd0f) on a live protected account returns
  // the installed route; every other selector returns zeros.
  assert.equal(recoveryRouteSelector(d), "0xac39fd0f");
});

test("uninstall calldata carries moduleType 3 and the BARE selector as deInitData", () => {
  const callData = buildUninstallRecoveryCallData(d);
  const { functionName, args } = decodeFunctionData({
    abi: parseAbi([UNINSTALL_MODULE_FN]),
    data: callData,
  });

  assert.equal(functionName, "uninstallModule");
  // Kernel.sol:454 — only moduleType 3 reaches _uninstallSelector.
  assert.equal(args[0], 3n);
  // Ignored by the moduleType-3 branch, but passed so the tx reads correctly.
  assert.equal(args[1], RECOVERY_ACTION_ADDRESS);
  // Kernel.sol:455 reads bytes4(deInitData[0:4]). Exactly four bytes and nothing
  // else: appending the hook address or the 0xff install flag (the _installHook
  // convention) would still decode, still succeed, and still remove nothing.
  assert.equal(args[2], "0xac39fd0f");
});

test("uninstall calldata does NOT smuggle the caller hook or an 0xff flag", () => {
  const callData = buildUninstallRecoveryCallData(d).toLowerCase();
  assert.ok(
    !callData.includes(RECOVERY_CALLER_HOOK.slice(2).toLowerCase()),
    "the hook address belongs to install, never to uninstall",
  );
  // uninstallModule(uint256,address,bytes) with a 4-byte tail: selector + 3 head
  // words + length word + one padded data word = 4 + 160 bytes.
  assert.equal((callData.length - 2) / 2, 164);
});

test("install calldata pins the WoCo hook and the guardian — never the legacy hook (#164)", () => {
  const guardian = "0x1111111111111111111111111111111111111111" as const;
  const callData = buildRegisterGuardianCallData(d, guardian).toLowerCase();

  assert.equal(RECOVERY_CALLER_HOOK, WOCO_GUARDIAN_HOOK);
  assert.ok(callData.includes(WOCO_GUARDIAN_HOOK.slice(2).toLowerCase()));
  // Installing against the ZeroDev hook again would resurrect every past guardian
  // of a re-protected account (#148) — its address must not appear anywhere.
  assert.ok(!callData.includes(LEGACY_ZERODEV_CALLER_HOOK.slice(2).toLowerCase()));
  assert.ok(callData.includes(RECOVERY_ACTION_ADDRESS.slice(2).toLowerCase()));
  assert.ok(callData.includes(guardian.slice(2)));
  // Install and uninstall must not converge on the same bytes.
  assert.notEqual(callData, buildUninstallRecoveryCallData(d).toLowerCase());
});

test("selectorConfig decodes a LIVE installed route to (hook, target, callType)", () => {
  // Verbatim eth_call result for selectorConfig(0xac39fd0f) on Kernel
  // 0x41f1b4ff66152677586dabeda6780fc85ddb8a8e (Arb Sepolia) — an account protected
  // BEFORE #164, so its hook is the legacy ZeroDev one, which must still classify
  // as exactly that. A static struct, so the three words arrive inline with no
  // head offset — the ABI must match that.
  const live =
    "0x000000000000000000000000990a9fc8189d96d59e3ce98bd87f42135a24a30e" +
    "000000000000000000000000e884c2868cc82c16177ec73a93f7d9e6f3a5dc6e" +
    "ff00000000000000000000000000000000000000000000000000000000000000";

  const config = decodeFunctionResult({
    abi: KERNEL_SELECTOR_CONFIG_ABI,
    functionName: "selectorConfig",
    data: live as `0x${string}`,
  }) as { hook: string; target: string; callType: string };

  assert.equal(config.hook.toLowerCase(), LEGACY_ZERODEV_CALLER_HOOK.toLowerCase());
  assert.equal(classifyRouteHook(config.hook), "legacy");
  assert.equal(config.target.toLowerCase(), RECOVERY_ACTION_ADDRESS.toLowerCase());
  assert.equal(config.callType, "0xff"); // CALLTYPE_DELEGATECALL
});

test("selectorConfig decodes an ABSENT route to a zero hook", () => {
  // Verbatim eth_call result for a selector that was never installed. Kernel's
  // fallback reverts InvalidSelector() exactly on `hook == address(0)`
  // (Kernel.sol:182-184), so a zero hook — not a zero target — is what
  // readRecoveryRoute must treat as "no recovery route".
  const absent = ("0x" + "00".repeat(96)) as `0x${string}`;

  const config = decodeFunctionResult({
    abi: KERNEL_SELECTOR_CONFIG_ABI,
    functionName: "selectorConfig",
    data: absent,
  }) as { hook: string; target: string; callType: string };

  assert.equal(config.hook, "0x0000000000000000000000000000000000000000");
  assert.equal(config.target, "0x0000000000000000000000000000000000000000");
  assert.equal(config.callType, "0x00");
});

// --- Shared with WoCo-Contracts test/WoCoGuardianHookKernel.t.sol (#571) -----
// That suite executes these exact bytes against the deployed Kernel v3.1 bytecode.
// Change one side and the other fails until it is carried across.

const GUARDIAN_1 = "0x1111111111111111111111111111111111111111" as const;
/** The account that suite creates: KernelFactory, ECDSA root validator, owner 0xA11CE, salt 0. */
const SUITE_KERNEL = "0x237FEAB983ba5f02BfDC3fFEe7b7625E82A9fe95" as const;
const APP_INSTALL_G1: Hex = "0x9517e29f0000000000000000000000000000000000000000000000000000000000000003000000000000000000000000e884c2868cc82c16177ec73a93f7d9e6f3a5dc6e00000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000138ac39fd0ff43524473ebc651969becc748462ed27ed39d4db000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000001ff000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000061ff000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000010000000000000000000000001111111111111111111111111111111111111111000000000000000000000000000000000000000000000000000000000000000000000000000000";
const APP_REMOVAL: Hex = "0xe9ae5c530100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000002600000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000180000000000000000000000000237feab983ba5f02bfdc3ffee7b7625e82a9fe950000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a4a71763a80000000000000000000000000000000000000000000000000000000000000003000000000000000000000000e884c2868cc82c16177ec73a93f7d9e6f3a5dc6e00000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000004ac39fd0f0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000f43524473ebc651969becc748462ed27ed39d4db00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000000407ce01ee00000000000000000000000000000000000000000000000000000000";

test("install init data: route selector, WoCo hook, delegatecall, then the 0xff flag before the guardian list", () => {
  const { functionName, args } = decodeFunctionData({
    abi: parseAbi([INSTALL_MODULE_FN]),
    data: buildRegisterGuardianCallData(d, GUARDIAN_1),
  });
  assert.equal(functionName, "installModule");
  assert.equal(args[0], 3n);
  assert.equal(args[1], RECOVERY_ACTION_ADDRESS);

  // Kernel.sol installModule(3): selector(4) ‖ hook(20) ‖ abi.encode(bytes selectorData, bytes hookData).
  const init = args[2] as Hex;
  assert.equal(slice(init, 0, 4), "0xac39fd0f");
  assert.equal(getAddress(slice(init, 4, 24)), WOCO_GUARDIAN_HOOK);
  const [selectorData, hookData] = decodeAbiParameters(
    parseAbiParameters("bytes selectorData, bytes hookData"),
    slice(init, 24),
  );
  assert.equal(selectorData, "0xff"); // CALLTYPE_DELEGATECALL
  // HookManager._installHook calls onInstall on an ALREADY-initialised hook only when
  // this byte is 0xff. Without it an account whose set outlived its route would keep
  // that set. #571 makes removal clear the set as well; the flag stays required.
  assert.equal(slice(hookData, 0, 1), "0xff");
  const [guardians] = decodeAbiParameters(parseAbiParameters("address[] guardians"), slice(hookData, 1));
  assert.deepEqual(guardians, [GUARDIAN_1]);
});

test("removal is ONE batch: uninstall the route on the account itself, then clear the WoCo hook's set", () => {
  const calls = buildRemoveRecoveryCalls(d, SUITE_KERNEL);
  assert.equal(calls.length, 2);
  // Kernel's uninstallModule only admits EntryPoint, self or root: inside `execute`
  // the call must target the account for msg.sender to be address(this).
  assert.deepEqual(calls[0], { to: SUITE_KERNEL, value: 0n, data: buildUninstallRecoveryCallData(d) });
  assert.equal(calls[1].to, WOCO_GUARDIAN_HOOK);
  assert.equal(calls[1].value, 0n);
  assert.equal(calls[1].data, "0x07ce01ee"); // clearGuardians(), no arguments
  assert.equal(calls[1].data, toFunctionSelector("function clearGuardians()"));
});

test("the bytes the app sends are the ones WoCo-Contracts runs against the deployed Kernel", async () => {
  assert.equal(buildRegisterGuardianCallData(d, GUARDIAN_1).toLowerCase(), APP_INSTALL_G1.toLowerCase());
  // What `sendUserOperation({ calls })` puts in the userOp: a Kernel account with no
  // hook plugin encodes more than one call as execute(CALLTYPE_BATCH, Execution[])
  // (`createKernelAccount` encodeCalls → encodeCallDataEpV07).
  const userOpCallData = await encodeCallDataEpV07(buildRemoveRecoveryCalls(d, SUITE_KERNEL));
  assert.equal(userOpCallData.toLowerCase(), APP_REMOVAL.toLowerCase());
});
