/**
 * The recovery SELECTOR ROUTE — addresses, ABIs and calldata for installing,
 * reading and uninstalling `doRecovery` on a Kernel v3.1 account.
 *
 * Split out of `kernel-account.ts` so the encodings are pure and unit-testable:
 * every function here is a byte transform with no I/O, no storage and no SDK, and
 * `kernel-account.ts` is the only place that sends them. The encodings are the
 * part that fails SILENTLY when wrong — Kernel does not revert on a malformed
 * uninstall, it just removes nothing — so they are pinned by tests
 * (`test/recovery-route.test.ts`) against bytes read from the live chain.
 *
 * One home for the constants, deliberately: they were previously repeated across
 * the app, the docs and two spike scripts with no cross-check (#161).
 */

import type { Address, Hex } from "viem";
import {
  LEGACY_ZERODEV_CALLER_HOOK,
  WOCO_GUARDIAN_HOOK,
  buildClearGuardiansCall,
  type HookCall,
} from "./guardian-hook.js";

export {
  RECOVERY_ACTION_ADDRESS,
  RECOVERY_FALLBACK_MODULE_TYPE,
  RECOVERY_EXECUTOR_FN,
  INSTALL_MODULE_FN,
  UNINSTALL_MODULE_FN,
  KERNEL_SELECTOR_CONFIG_ABI,
} from "@woco/shared/kernel/recovery-contracts";
import {
  RECOVERY_ACTION_ADDRESS,
  RECOVERY_FALLBACK_MODULE_TYPE,
  RECOVERY_EXECUTOR_FN,
  INSTALL_MODULE_FN,
  UNINSTALL_MODULE_FN,
} from "@woco/shared/kernel/recovery-contracts";

/**
 * The CALLER HOOK every new route is installed with — WoCo's own, with
 * set-semantics and a real revoke (#164; see ./guardian-hook.js for the ABI and
 * the history). Routes installed before the switch still point at ZeroDev's
 * append-only hook (`LEGACY_ZERODEV_CALLER_HOOK`); they are recognised on read
 * and replaced on the next "add a backup", never re-installed.
 */
export const RECOVERY_CALLER_HOOK = WOCO_GUARDIAN_HOOK;
export { LEGACY_ZERODEV_CALLER_HOOK };

/**
 * The viem helpers these builders need. Passed in rather than imported so
 * `kernel-account.ts` keeps its single lazy viem load and this module stays free
 * of eager bundle weight.
 */
export interface RouteEncoders {
  encodeFunctionData: typeof import("viem").encodeFunctionData;
  parseAbi: typeof import("viem").parseAbi;
  parseAbiParameters: typeof import("viem").parseAbiParameters;
  encodeAbiParameters: typeof import("viem").encodeAbiParameters;
  toFunctionSelector: typeof import("viem").toFunctionSelector;
  concat: typeof import("viem").concat;
}

/** `bytes4(keccak("doRecovery(address,bytes)"))` — `0xac39fd0f`, verified on chain. */
export function recoveryRouteSelector(d: Pick<RouteEncoders, "toFunctionSelector" | "parseAbi">): Hex {
  return d.toFunctionSelector(d.parseAbi([RECOVERY_EXECUTOR_FN])[0]);
}

/** `installModule(type=3)` init data: selector + caller hook + abi(delegatecall, 0xff-flagged guardian list). */
export function buildRegisterGuardianCallData(d: RouteEncoders, guardianAddress: Address): Hex {
  return d.encodeFunctionData({
    abi: d.parseAbi([INSTALL_MODULE_FN]),
    functionName: "installModule",
    args: [
      RECOVERY_FALLBACK_MODULE_TYPE,
      RECOVERY_ACTION_ADDRESS,
      d.concat([
        recoveryRouteSelector(d),
        RECOVERY_CALLER_HOOK,
        d.encodeAbiParameters(d.parseAbiParameters("bytes selectorData, bytes hookData"), [
          "0xff", // selectorData: route via delegatecall
          d.concat([
            "0xff", // flag: install the caller hook
            d.encodeAbiParameters(d.parseAbiParameters("address[] guardians"), [[guardianAddress]]),
          ]),
        ]),
      ]),
    ],
  });
}

/**
 * `uninstallModule(3, …)` — removes the `doRecovery` route, after which every call
 * reverts `InvalidSelector()` before the hook or the action is reached, from any
 * caller including every registered guardian.
 *
 * TWO ENCODING FACTS, both from `zerodevapp/kernel@release/v3.1` and both easy to
 * "fix" wrongly — Kernel would then remove NOTHING and still return a green receipt:
 *  - `deInitData` is the BARE 4-byte selector. `Kernel.sol:454-456` reads
 *    `bytes4(deInitData[0:4])` and passes the remainder to `_uninstallSelector` as
 *    module de-init data. No hook address, no `0xff` flag — that convention belongs
 *    to `_installHook`, which the uninstall path never calls.
 *  - the `module` argument is IGNORED by the moduleType-3 branch. The real action
 *    address is passed anyway so the transaction reads correctly on an explorer.
 */
export function buildUninstallRecoveryCallData(d: RouteEncoders): Hex {
  return d.encodeFunctionData({
    abi: d.parseAbi([UNINSTALL_MODULE_FN]),
    functionName: "uninstallModule",
    args: [RECOVERY_FALLBACK_MODULE_TYPE, RECOVERY_ACTION_ADDRESS, recoveryRouteSelector(d)],
  });
}

/**
 * "Remove all backups" as ONE batch: uninstall the route, then empty the WoCo hook's
 * set for this account (#571).
 *
 * WHY THE SECOND CALL. The uninstall above discards the hook without calling it, so
 * the set outlives the route. A later install replaces that set only because
 * `_installHook` (`core/HookManager.sol:30-42`) honours the `0xff` flag: a leftover
 * set makes `isInitialized` true, and without the flag `onInstall` is skipped and
 * every removed guardian is live again. Emptying the set here makes the removal
 * final on its own, whatever a later install sends.
 *
 * The first call targets the ACCOUNT ITSELF — inside `execute`, `uninstallModule`'s
 * `onlyEntryPointOrSelfOrRoot` passes on `msg.sender == address(this)`. Kernel's
 * default batch reverts as a whole (`utils/ExecLib.sol:69-77`), so the two land
 * together or not at all. On a legacy-hook or never-protected account the clear
 * empties an already-empty set and does not revert.
 */
export function buildRemoveRecoveryCalls(d: RouteEncoders, kernelAddress: Address): HookCall[] {
  return [
    { to: kernelAddress, value: 0n, data: buildUninstallRecoveryCallData(d) },
    buildClearGuardiansCall(d.encodeFunctionData),
  ];
}
