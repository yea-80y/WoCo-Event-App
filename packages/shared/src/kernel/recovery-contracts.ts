/**
 * Recovery contracts on the Kernel chain - the guardian hook and the `doRecovery`
 * selector route - as plain data (no viem), so the app that sends these calls and
 * the server that decides whether to sponsor them (#758,
 * apps/server/src/lib/zerodev/sponsor-policy.ts) read the SAME bytes. The app's
 * builders and readers stay in apps/web/src/lib/auth/{guardian-hook,recovery-route}.ts
 * and re-export these.
 */

/**
 * WoCoGuardianHook singleton — CREATE2 via the canonical deterministic deployer,
 * so this is its address on EVERY chain with the proxy, Arbitrum One included
 * (#489 moved the Kernel; the hook address did not move). First deployed to Arb
 * Sepolia 2026-08-22, tx 0x89e65a63…c883f3; the Arbitrum One twin landed
 * 2026-09-07, tx 0xcb5d5bfd…2051 at block 502,832,530, runtime codehash read
 * back identical on both chains. Both verified on Arbiscan.
 *
 * The Arb Sepolia deploy BLOCK used to be exported next to this. It had no
 * caller, and as a log floor on another chain it would be a silently wrong
 * answer rather than an error, so it went with the move.
 */
export const WOCO_GUARDIAN_HOOK = "0xF43524473EBC651969BeCc748462ED27ed39d4Db" as const;

/**
 * ZeroDev's caller hook — the one WoCo installed BEFORE #164. Still recognised on
 * read (accounts protected before the switch keep recovering through it until
 * they re-protect), never installed again. `allowed(guardian, account)` is its
 * only getter and it is append-only.
 */
export const LEGACY_ZERODEV_CALLER_HOOK = "0x990a9FC8189D96d59E3cE98bd87F42135a24a30E" as const;

/** `MAX_GUARDIANS` on the contract — mirrored so the client can refuse before sending. */
export const WOCO_GUARDIAN_HOOK_MAX_GUARDIANS = 32;

export const WOCO_GUARDIAN_HOOK_ABI = [
  {
    type: "function",
    name: "guardiansOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    type: "function",
    name: "isGuardian",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "guardian", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "guardianCount",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "addGuardian",
    stateMutability: "nonpayable",
    inputs: [{ name: "guardian", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "revokeGuardian",
    stateMutability: "nonpayable",
    inputs: [{ name: "guardian", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setGuardians",
    stateMutability: "nonpayable",
    inputs: [{ name: "guardians", type: "address[]" }],
    outputs: [],
  },
  { type: "function", name: "clearGuardians", stateMutability: "nonpayable", inputs: [], outputs: [] },
] as const;

/** Legacy hook getter — `allowed(guardian, account)`; note the REVERSED argument order vs `isGuardian`. */
export const LEGACY_HOOK_ALLOWED_ABI = [
  {
    type: "function",
    name: "allowed",
    stateMutability: "view",
    inputs: [
      { name: "guardian", type: "address" },
      { name: "account", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;


/** ZeroDev recovery ACTION singleton (Arb Sepolia) — delegatecalled by the route. */
export const RECOVERY_ACTION_ADDRESS = "0xe884C2868CC82c16177eC73a93f7D9E6F3A5DC6E" as const;

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

/** `bytes4(keccak("doRecovery(address,bytes)"))` - the route's selector, verified on chain. */
export const RECOVERY_ROUTE_SELECTOR = "0xac39fd0f" as const;
