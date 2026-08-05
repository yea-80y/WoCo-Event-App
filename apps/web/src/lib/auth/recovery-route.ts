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

/** ZeroDev recovery ACTION singleton (Arb Sepolia) — delegatecalled by the route. */
export const RECOVERY_ACTION_ADDRESS = "0xe884C2868CC82c16177eC73a93f7D9E6F3A5DC6E" as const;

/**
 * ZeroDev CALLER HOOK singleton (Arb Sepolia) — pins which guardian accounts may
 * call `doRecovery`. Its `allowed[guardian][kernel]` mapping is APPEND-ONLY:
 * `onInstall` ORs guardians in, `onUninstall` clears only an init flag, and there
 * is no revoke entrypoint (#148). Uninstalling the route is the only revoke, and
 * re-installing against this same address resurrects every past guardian.
 */
export const RECOVERY_CALLER_HOOK = "0x990a9FC8189D96d59E3cE98bd87F42135a24a30E" as const;

/** ERC-7579 fallback module — the recovery action is a selector-routed fallback. */
export const RECOVERY_FALLBACK_MODULE_TYPE = 3n;

export const RECOVERY_EXECUTOR_FN = "function doRecovery(address _validator, bytes calldata _data)";
export const INSTALL_MODULE_FN =
  "function installModule(uint256 _type, address _module, bytes calldata _initData)";
export const UNINSTALL_MODULE_FN =
  "function uninstallModule(uint256 _type, address _module, bytes calldata _deInitData)";

/**
 * `selectorConfig(bytes4) → (hook, target, callType)` — Kernel v3.1's public getter
 * over the fallback-route table (`core/SelectorManager.sol:29`, struct at :19). A
 * static struct, so the three words come back inline with no head offset.
 *
 * Confirmed by raw `eth_call` on Arb Sepolia against a live protected account:
 * installed returns `(0x990a9FC8…, 0xe884C286…, 0xff)`, absent returns three zero
 * words. `callType` is Kernel's `CallType` user-defined value type over `bytes1`.
 */
export const KERNEL_SELECTOR_CONFIG_ABI = [
  {
    type: "function",
    name: "selectorConfig",
    stateMutability: "view",
    inputs: [{ name: "selector", type: "bytes4" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "hook", type: "address" },
          { name: "target", type: "address" },
          { name: "callType", type: "bytes1" },
        ],
      },
    ],
  },
] as const;

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
