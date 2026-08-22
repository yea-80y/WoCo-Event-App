/**
 * The WoCo guardian hook — addresses, ABI and calldata for the WoCo-owned ERC-7579
 * caller hook that replaces ZeroDev's append-only one (#164).
 *
 * Pure: byte transforms and decisions, no I/O. `kernel-account.ts` is the only
 * place that sends or reads them. Contract source + Foundry tests live in the
 * nested `contracts/` repo (`src/recovery/WoCoGuardianHook.sol`, github.com/
 * yea-80y/WoCo-Contracts); deployment record in `contracts/deployments/
 * 421614-guardian-hook.json`.
 *
 * WHAT CHANGED AND WHY (the #148 / #164 defect). The ZeroDev caller hook stored
 * `allowed[guardian][kernel]` and only ever ORed `true` in — no revoke, and the
 * selector uninstall never reached its `onUninstall` — so a replaced backup kept
 * takeover power and "remove all, then add one" resurrected every past guardian.
 * Kernel v3.1's `_installSelector` overwrites the route's hook unconditionally,
 * so a different hook is the supported per-guardian revoke: this one keeps a
 * per-account SET (`onInstall` replaces, `addGuardian` / `revokeGuardian` /
 * `clearGuardians` edit it, `guardiansOf` lists it) and `preCheck` refuses any
 * caller outside the CURRENT set.
 *
 * Every mutator is keyed by `msg.sender`, so the account calls them through its
 * own sudo-signed `execute` — which is exactly what `kernel-account.ts` does.
 */

import type { Address, Hex } from "viem";

/**
 * WoCoGuardianHook singleton (Arb Sepolia, CREATE2 via the canonical deterministic
 * deployer — same address on any chain with the proxy). Deployed 2026-08-22, tx
 * 0x89e65a63…c883f3, block 300947688, source verified on Arbiscan.
 */
export const WOCO_GUARDIAN_HOOK = "0xF43524473EBC651969BeCc748462ED27ed39d4Db" as const;
/** First block the hook exists at — a read pinned earlier than this is meaningless. */
export const WOCO_GUARDIAN_HOOK_DEPLOY_BLOCK = 300947688n;

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

type EncodeFn = typeof import("viem").encodeFunctionData;

/** A call the account's `execute` sends to the hook. */
export interface HookCall {
  to: Address;
  data: Hex;
  value: bigint;
}

export function buildAddGuardianCall(encodeFunctionData: EncodeFn, guardian: Address): HookCall {
  return {
    to: WOCO_GUARDIAN_HOOK,
    value: 0n,
    data: encodeFunctionData({ abi: WOCO_GUARDIAN_HOOK_ABI, functionName: "addGuardian", args: [guardian] }),
  };
}

export function buildRevokeGuardianCall(encodeFunctionData: EncodeFn, guardian: Address): HookCall {
  return {
    to: WOCO_GUARDIAN_HOOK,
    value: 0n,
    data: encodeFunctionData({ abi: WOCO_GUARDIAN_HOOK_ABI, functionName: "revokeGuardian", args: [guardian] }),
  };
}

export function buildSetGuardiansCall(encodeFunctionData: EncodeFn, guardians: Address[]): HookCall {
  return {
    to: WOCO_GUARDIAN_HOOK,
    value: 0n,
    data: encodeFunctionData({ abi: WOCO_GUARDIAN_HOOK_ABI, functionName: "setGuardians", args: [guardians] }),
  };
}

export function buildClearGuardiansCall(encodeFunctionData: EncodeFn): HookCall {
  return {
    to: WOCO_GUARDIAN_HOOK,
    value: 0n,
    data: encodeFunctionData({ abi: WOCO_GUARDIAN_HOOK_ABI, functionName: "clearGuardians" }),
  };
}

/**
 * Which hook a recovery route points at. Drives every branch in the product:
 *  - `woco`   — the set is readable and editable; "add" is `addGuardian`, revoke exists;
 *  - `legacy` — ZeroDev's append-only hook; readable only per-candidate via
 *               `allowed`, no revoke; an "add" REPLACES the route with the WoCo hook
 *               (the old hook's guardians become unreachable — say so first);
 *  - `none`   — no route (zero hook);
 *  - `other`  — a hook this app did not install. Never assume anything about it.
 */
export type RouteHookKind = "woco" | "legacy" | "none" | "other";

export function classifyRouteHook(hook: string | undefined | null): RouteHookKind {
  if (!hook) return "none";
  const lc = hook.toLowerCase();
  if (lc === "0x0000000000000000000000000000000000000000") return "none";
  if (lc === WOCO_GUARDIAN_HOOK.toLowerCase()) return "woco";
  if (lc === LEGACY_ZERODEV_CALLER_HOOK.toLowerCase()) return "legacy";
  return "other";
}

/**
 * The account's guardian set as the chain reports it — or that it could not be
 * read. `unknown` must never be rendered as "no backups" nor used to compose a
 * write (see `decideAddPath`).
 */
export type GuardianSetRead =
  | { state: "read"; guardians: string[] }
  | { state: "unknown" };

/**
 * Which write "add a backup" must send, given what the chain says about the route.
 *
 * The choice is load-bearing because the two writes have different SEMANTICS:
 * a route install pins the hook's set to EXACTLY the listed guardians (replace),
 * while `addGuardian` appends to the existing set. Sending an install against an
 * account that already has WoCo-hook guardians would silently drop them — so an
 * unreadable route REFUSES rather than guesses, and a WoCo route with a readable
 * set appends. A legacy route is replaced on purpose (that IS the upgrade), and
 * the caller must have warned that the old hook's guardians stop working.
 */
export type AddPath =
  | { path: "install"; replacesLegacy: boolean }
  | { path: "append"; currentGuardians: string[] }
  | { path: "refuse"; reason: string };

export function decideAddPath(args: {
  routeState: "installed" | "absent" | "unknown";
  hookKind: RouteHookKind;
  set: GuardianSetRead | null;
  guardian: string;
}): AddPath {
  const g = args.guardian.toLowerCase();
  if (args.routeState === "unknown") {
    return { path: "refuse", reason: "Couldn't read this account's recovery state — nothing was changed. Please try again in a moment." };
  }
  if (args.routeState === "absent") return { path: "install", replacesLegacy: false };
  // installed
  switch (args.hookKind) {
    case "woco": {
      if (!args.set || args.set.state !== "read") {
        return { path: "refuse", reason: "Couldn't read this account's current backups — nothing was changed. Please try again in a moment." };
      }
      const current = args.set.guardians.map((a) => a.toLowerCase());
      if (current.includes(g)) {
        return { path: "refuse", reason: "This backup is already set up for this account." };
      }
      if (current.length >= WOCO_GUARDIAN_HOOK_MAX_GUARDIANS) {
        return { path: "refuse", reason: `This account already has the maximum of ${WOCO_GUARDIAN_HOOK_MAX_GUARDIANS} backups.` };
      }
      return { path: "append", currentGuardians: current };
    }
    case "legacy":
      return { path: "install", replacesLegacy: true };
    case "none":
      // installed-but-zero-hook cannot happen (readRecoveryRoute maps a zero hook to
      // "absent"); treat like absent rather than invent a state.
      return { path: "install", replacesLegacy: false };
    case "other":
      return {
        path: "refuse",
        reason: "This account's recovery route uses a contract this app doesn't know. Remove all backups first, then add one.",
      };
  }
}
