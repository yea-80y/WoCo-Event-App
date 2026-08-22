/**
 * Semantics locks for the recovery selector route (#148, #165).
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
 * (`Kernel.sol:443-456`, `core/SelectorManager.sol:63-73`).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  concat,
  decodeFunctionData,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  parseAbiParameters,
  toFunctionSelector,
} from "viem";
import {
  KERNEL_SELECTOR_CONFIG_ABI,
  LEGACY_ZERODEV_CALLER_HOOK,
  RECOVERY_ACTION_ADDRESS,
  RECOVERY_CALLER_HOOK,
  UNINSTALL_MODULE_FN,
  buildRegisterGuardianCallData,
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
