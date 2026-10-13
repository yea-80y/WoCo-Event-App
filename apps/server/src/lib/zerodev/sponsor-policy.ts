/**
 * Which userOps the platform pays gas for (#758).
 *
 * The browser sends every sponsored userOp straight to ZeroDev with the PUBLIC
 * `VITE_ZERODEV_RPC` key, so the dashboard policy was the only bound on what that
 * key could spend. ZeroDev's custom gas policy asks this server first (routes/
 * zerodev-policy.ts), and this module is the answer. Three questions, in order:
 *
 *   WHAT  - the call data must be one of the shapes WoCo itself sends, decoded
 *           exactly (`classifyUserOp`). Anything else is refused before any read.
 *   WHO   - the account the op acts for must be unlocked (ticket, Stripe or a
 *           confirmed invite - lib/gate/check.ts), the rule every other paid door
 *           follows (owner 10-02). For a recovery that is the account being
 *           recovered: the sender is the GUARDIAN's own Kernel, which is never
 *           unlocked. The guardian must also be on that account's list onchain,
 *           else an op that validates and then reverts still spends our gas.
 *           ONE exception (owner 10-07): a locked email account may upgrade to a
 *           passkey - the `upgrade` shape, one op per intent its own session asked
 *           for (per-IP limited, lib/zerodev/upgrade-intents.ts) - so an account
 *           holding only a pending referral can organise. Bad-actor limits only, no
 *           platform-wide cap: the ZeroDev plan is raised with demand (owner 10-08).
 *   HOW MUCH - a ceiling on what ONE op may cost (its gas limits x max fee, which
 *           is what the EntryPoint can charge the paymaster - the sender picks those
 *           numbers and the bundler keeps the surplus), and a per-account count,
 *           once per userOp (`sender:nonce:account`), so the stub and final
 *           sponsorship requests and any retry count once.
 *
 * The shapes (Fable consult 8; builders in apps/web/src/lib/auth/{recovery-route,
 * guardian-hook,kernel-account}.ts, constants shared via
 * @woco/shared/kernel/recovery-contracts):
 *   install-route  top-level `installModule(3, recovery action, selector ‖ WoCo hook ‖ …)`
 *                  - `setupRecovery` sends it raw, NOT inside `execute`
 *   guardians      `execute` of WoCo-hook add/revoke/set/clearGuardians calls
 *   remove-route   `execute` batch of the account's own `uninstallModule(3, …, selector)`
 *                  plus hook calls ("remove all backups")
 *   rotate         `execute` batch of exactly [ECDSA onUninstall(0x), onInstall(owner)]
 *                  - "make this device the main one"
 *   recover        `execute` single `target.doRecovery(ECDSA validator, owner)` from a guardian
 *   co-owners      `execute` batch of exactly [self.changeRootValidator(weighted, no hook, list),
 *                  self.uninstallValidation(ECDSA)] - the second passkey makes every passkey a
 *                  co-owner (#746, @woco/shared/kernel/co-owners)
 *   upgrade        the co-owners batch with a list of ONE key: an email account handing itself
 *                  to its new passkey (#746). A passkey account's switch always lists two.
 *   renew          `execute` single `weighted.renew(list)` - add or remove a co-owner
 *   ring           `execute` single `anchor.setRing(prev, ring)` - the account's key ring moves
 *                  without a list change (a passkey given the keys, #186)
 * The co-owners and renew shapes may END with that same `setRing` call: a removal is
 * [renew(list without it), setRing(prev, next)], so the keys it lost and its place on the
 * list change in one op or not at all. A ring is never zero, and rides on no other shape.
 * Both co-owner shapes carry a list only when it is 1..10 distinct keys, every weight 1,
 * threshold 1, no delay: the validator accepts an empty list or an unreachable threshold
 * and the account is then locked for good (WoCo-Contracts WeightedRootKernel.t.sol F5).
 * `execute` is accepted only with the default exec type and a single or batch call
 * type, no value on any call, and no `executeUserOp` prefix: WoCo sends none of those.
 *
 * The server's own shop draw (lib/shop/spend-permission.ts, shopAllowed = false)
 * would be refused here if it shares the project; allow its shape when the shop returns.
 */

import {
  decodeAbiParameters,
  decodeFunctionData,
  keccak256,
  parseAbi,
  parseAbiParameters,
  toFunctionSelector,
  type Hex,
} from "viem";
import { getEntryPoint, KERNEL_V3_1, KernelVersionToAddressesMap } from "@zerodev/sdk/constants";
import { getValidatorAddress } from "@zerodev/ecdsa-validator";
import {
  INSTALL_MODULE_FN,
  RECOVERY_ACTION_ADDRESS,
  RECOVERY_EXECUTOR_FN,
  RECOVERY_FALLBACK_MODULE_TYPE,
  RECOVERY_ROUTE_SELECTOR,
  UNINSTALL_MODULE_FN,
  WOCO_GUARDIAN_HOOK,
  WOCO_GUARDIAN_HOOK_ABI,
} from "@woco/shared/kernel/recovery-contracts";
import {
  CHANGE_ROOT_VALIDATOR_FN,
  ECDSA_ROOT_ID,
  isValidCoOwnerList,
  sortCoOwners,
  UNINSTALL_VALIDATION_FN,
  WEIGHTED_ECDSA_VALIDATOR_V3_1,
  WEIGHTED_RENEW_FN,
  WEIGHTED_ROOT_ID,
} from "@woco/shared/kernel/co-owners";
import { FEATURES } from "@woco/shared";
import { KEY_RING_ANCHOR_ABI, KEY_RING_ANCHOR_ADDRESS } from "@woco/shared/keyring/anchor";
import type { GateStatus } from "../gate/check.js";
import { SlidingWindowLimiter } from "../http/rate-limit.js";
import { RollingDayCount } from "./upgrade-intents.js";

export type SponsorShape =
  | "install-route"
  | "guardians"
  | "remove-route"
  | "rotate"
  | "recover"
  | "co-owners"
  | "upgrade"
  | "renew"
  | "ring";

export type Classified =
  | { ok: true; shape: SponsorShape; subject: string; guardian?: string }
  | { ok: false; reason: string };

/** The fields read from ZeroDev's `userOp` (EntryPoint 0.7; 0.6's `initCode` also understood). */
export interface PolicyUserOp {
  sender: string;
  nonce: string;
  callData: Hex;
  /** Deployment factory, or null when the account already exists. */
  factory: string | null;
  /**
   * The most the paymaster can be charged for the gas this op's sender chose
   * (`maxCostOf`). 0 on a stub request, which carries no limits yet.
   */
  maxCostWei: bigint;
}

const lc = (s: string) => s.toLowerCase();
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;

const ECDSA_VALIDATOR = lc(getValidatorAddress(getEntryPoint("0.7"), KERNEL_V3_1));
const KERNEL_FACTORIES = new Set(
  [KernelVersionToAddressesMap[KERNEL_V3_1].factoryAddress, KernelVersionToAddressesMap[KERNEL_V3_1].metaFactoryAddress]
    .filter((a): a is Hex => typeof a === "string")
    .map(lc),
);
const HOOK = lc(WOCO_GUARDIAN_HOOK);
const ACTION = lc(RECOVERY_ACTION_ADDRESS);
const ROUTE_HEAD = lc(RECOVERY_ROUTE_SELECTOR + WOCO_GUARDIAN_HOOK.slice(2));

const KERNEL_ABI = parseAbi([
  INSTALL_MODULE_FN,
  UNINSTALL_MODULE_FN,
  "function execute(bytes32 execMode, bytes executionCalldata)",
]);
const VALIDATOR_ABI = parseAbi(["function onUninstall(bytes)", "function onInstall(bytes)"]);
const RECOVERY_ABI = parseAbi([RECOVERY_EXECUTOR_FN]);
const INSTALL = lc(toFunctionSelector(INSTALL_MODULE_FN));
const EXECUTE = lc(toFunctionSelector("function execute(bytes32 execMode, bytes executionCalldata)"));
const HOOK_MUTATORS = new Set(["addGuardian", "revokeGuardian", "setGuardians", "clearGuardians"]);
const MAX_CALLS = 4;
const WEIGHTED = lc(WEIGHTED_ECDSA_VALIDATOR_V3_1);
const CO_OWNER_ABI = parseAbi([WEIGHTED_RENEW_FN, CHANGE_ROOT_VALIDATOR_FN, UNINSTALL_VALIDATION_FN]);
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const RING_ANCHOR = lc(KEY_RING_ANCHOR_ADDRESS);
const RING_ABI = parseAbi(KEY_RING_ANCHOR_ABI);

function uint(v: unknown): bigint | null {
  if (v === undefined || v === null || v === "" || v === "0x") return 0n;
  if (typeof v !== "string" && typeof v !== "number" && typeof v !== "bigint") return null;
  try {
    const n = BigInt(v);
    return n < 0n ? null : n;
  } catch {
    return null;
  }
}

/** A 32-byte word of two packed uint128s (0.7's packed fields), as [high, low]. */
function unpack128(v: unknown): [bigint, bigint] | null {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v)) return null;
  return [BigInt(`0x${v.slice(2, 34)}`), BigInt(`0x${v.slice(34)}`)];
}

/**
 * The most the paymaster can be charged for the gas the SENDER chose: (pVG + vGL +
 * cGL) x maxFeePerGas, the EntryPoint 0.7 prefund less the paymaster's own two
 * limits, which ZeroDev sets when it signs and the sender cannot raise. Read from
 * unpacked fields or 0.7's packed words. Missing fields read as 0 (a stub request).
 */
function maxCostOf(op: Record<string, unknown>): bigint | null {
  const packedLimits = unpack128(op.accountGasLimits);
  const packedFees = unpack128(op.gasFees);
  const verification = packedLimits ? packedLimits[0] : uint(op.verificationGasLimit);
  const call = packedLimits ? packedLimits[1] : uint(op.callGasLimit);
  const maxFee = packedFees ? packedFees[1] : uint(op.maxFeePerGas);
  const pre = uint(op.preVerificationGas);
  if (verification === null || call === null || maxFee === null || pre === null) return null;
  return (pre + verification + call) * maxFee;
}

/** Read the fields we use out of ZeroDev's body; null when anything is missing or malformed. */
export function readUserOp(raw: unknown): PolicyUserOp | null {
  if (typeof raw !== "object" || raw === null) return null;
  const op = raw as Record<string, unknown>;
  const { sender, callData } = op;
  if (typeof sender !== "string" || !ADDRESS.test(sender)) return null;
  if (typeof callData !== "string" || !HEX.test(callData) || callData.length < 10) return null;
  let nonce: string;
  try {
    if (typeof op.nonce !== "string" && typeof op.nonce !== "number" && typeof op.nonce !== "bigint") return null;
    nonce = BigInt(op.nonce).toString();
  } catch {
    return null;
  }
  let factory: string | null = null;
  if (typeof op.initCode === "string" && op.initCode.length > 2) {
    if (!HEX.test(op.initCode) || op.initCode.length < 42) return null;
    factory = op.initCode.slice(0, 42);
  } else if (typeof op.factory === "string" && op.factory.length > 2) {
    if (!ADDRESS.test(op.factory)) return null;
    factory = op.factory;
  }
  const maxCostWei = maxCostOf(op);
  if (maxCostWei === null) return null;
  return { sender: lc(sender), nonce, callData: callData as Hex, factory: factory && lc(factory), maxCostWei };
}

interface InnerCall {
  to: string;
  value: bigint;
  data: Hex;
}

/** One `execute` call's inner calls, or a refusal reason. */
function readExecute(callData: Hex): InnerCall[] | string {
  let mode: Hex;
  let exec: Hex;
  try {
    const d = decodeFunctionData({ abi: KERNEL_ABI, data: callData });
    if (d.functionName !== "execute") return "selector";
    [mode, exec] = d.args as [Hex, Hex];
  } catch {
    return "malformed";
  }
  // execMode = callType(1) ‖ execType(1) ‖ unused(4) ‖ selector(4) ‖ payload(22): WoCo
  // sends only the default exec type with nothing after the call type.
  const callType = mode.slice(2, 4);
  if (mode.slice(4) !== "0".repeat(62)) return "exec-mode";
  if (callType === "00") {
    if (exec.length < 2 + 2 * 52) return "malformed";
    return [{ to: lc(`0x${exec.slice(2, 42)}`), value: BigInt(`0x${exec.slice(42, 106)}`), data: `0x${exec.slice(106)}` as Hex }];
  }
  if (callType === "01") {
    try {
      const [calls] = decodeAbiParameters(parseAbiParameters("(address target, uint256 value, bytes callData)[]"), exec);
      return calls.map((c) => ({ to: lc(c.target), value: c.value, data: c.callData }));
    } catch {
      return "malformed";
    }
  }
  return "call-type";
}

function isHookMutator(call: InnerCall): boolean {
  if (call.to !== HOOK) return false;
  try {
    return HOOK_MUTATORS.has(decodeFunctionData({ abi: WOCO_GUARDIAN_HOOK_ABI, data: call.data }).functionName);
  } catch {
    return false;
  }
}

function isRouteUninstall(call: InnerCall, sender: string): boolean {
  if (call.to !== sender) return false;
  try {
    const d = decodeFunctionData({ abi: KERNEL_ABI, data: call.data });
    if (d.functionName !== "uninstallModule") return false;
    const [type, module, deInit] = d.args as [bigint, string, Hex];
    return type === RECOVERY_FALLBACK_MODULE_TYPE && lc(module) === ACTION && lc(deInit) === RECOVERY_ROUTE_SELECTOR;
  } catch {
    return false;
  }
}

function validatorCall(call: InnerCall, name: "onUninstall" | "onInstall"): Hex | null {
  if (call.to !== ECDSA_VALIDATOR) return null;
  try {
    const d = decodeFunctionData({ abi: VALIDATOR_ABI, data: call.data });
    return d.functionName === name ? (d.args[0] as Hex) : null;
  } catch {
    return null;
  }
}

/** The co-owner list the account will hold: 1..10 distinct keys in the order the
 *  validator requires (descending, as the ZeroDev plugin writes it - any other order
 *  reverts on our gas), weight 1 each, threshold 1, no delay - anything else locks
 *  the account or is not WoCo's. */
function validCoOwnerConfig(signers: readonly string[], weights: readonly (number | bigint)[], threshold: number | bigint, delay: number | bigint): boolean {
  return (
    isValidCoOwnerList(signers) &&
    sortCoOwners(signers).join() === signers.map((s) => s.toLowerCase()).join() &&
    weights.length === signers.length &&
    weights.every((w) => BigInt(w) === 1n) &&
    BigInt(threshold) === 1n &&
    BigInt(delay) === 0n
  );
}

function isRenew(call: InnerCall): boolean {
  if (call.to !== WEIGHTED) return false;
  try {
    const d = decodeFunctionData({ abi: CO_OWNER_ABI, data: call.data });
    if (d.functionName !== "renew") return false;
    const [signers, weights, threshold, delay] = d.args as [readonly string[], readonly number[], number, number];
    return validCoOwnerConfig(signers, weights, threshold, delay);
  } catch {
    return false;
  }
}

/** [changeRootValidator(weighted, no hook, list, 0x), uninstallValidation(ECDSA, 0x, 0x)], both on the sender:
 *  the number of keys on the list, or 0 when it is not exactly that. */
function coOwnerSwitchSize(calls: InnerCall[], sender: string): number {
  if (calls.length !== 2 || calls[0].to !== sender || calls[1].to !== sender) return 0;
  try {
    const change = decodeFunctionData({ abi: CO_OWNER_ABI, data: calls[0].data });
    if (change.functionName !== "changeRootValidator") return 0;
    const [root, hook, enable, hookData] = change.args as [Hex, string, Hex, Hex];
    if (lc(root) !== WEIGHTED_ROOT_ID || lc(hook) !== ZERO_ADDRESS || hookData !== "0x") return 0;
    const [signers, weights, threshold, delay] = decodeAbiParameters(
      parseAbiParameters("address[], uint24[], uint24, uint48"),
      enable,
    ) as unknown as [readonly string[], readonly number[], number, number];
    if (!validCoOwnerConfig(signers, weights, threshold, delay)) return 0;
    const drop = decodeFunctionData({ abi: CO_OWNER_ABI, data: calls[1].data });
    if (drop.functionName !== "uninstallValidation") return 0;
    const [vId, deinit, hookDeinit] = drop.args as [Hex, Hex, Hex];
    return lc(vId) === ECDSA_ROOT_ID && deinit === "0x" && hookDeinit === "0x" ? signers.length : 0;
  } catch {
    return 0;
  }
}

/** `anchor.setRing(prev, ring)` with a non-zero ring - the contract refuses zero, and a
 *  call it would revert is gas we pay for nothing. */
function isSetRing(call: InnerCall): boolean {
  if (call.to !== RING_ANCHOR) return false;
  try {
    const d = decodeFunctionData({ abi: RING_ABI, data: call.data });
    if (d.functionName !== "setRing") return false;
    const [, ring] = d.args as [Hex, Hex];
    return BigInt(ring) !== 0n;
  } catch {
    return false;
  }
}

function recoveryTarget(call: InnerCall): string | null {
  try {
    const d = decodeFunctionData({ abi: RECOVERY_ABI, data: call.data });
    const [validator, newOwner] = d.args as [string, Hex];
    return lc(validator) === ECDSA_VALIDATOR && newOwner.length === 42 ? call.to : null;
  } catch {
    return null;
  }
}

/** WHAT: the shape of this userOp, and whose unlock pays for it. Pure. */
export function classifyUserOp(op: PolicyUserOp): Classified {
  if (op.factory !== null && !KERNEL_FACTORIES.has(op.factory)) return { ok: false, reason: "factory" };
  const selector = lc(op.callData.slice(0, 10));

  if (selector === INSTALL) {
    try {
      const d = decodeFunctionData({ abi: KERNEL_ABI, data: op.callData });
      const [type, module, init] = d.args as [bigint, string, Hex];
      if (type === RECOVERY_FALLBACK_MODULE_TYPE && lc(module) === ACTION && lc(init).startsWith(ROUTE_HEAD)) {
        return { ok: true, shape: "install-route", subject: op.sender };
      }
    } catch {
      /* falls through to the refusal */
    }
    return { ok: false, reason: "install" };
  }
  if (selector !== EXECUTE) return { ok: false, reason: "selector" };

  const calls = readExecute(op.callData);
  if (typeof calls === "string") return { ok: false, reason: calls };
  if (calls.length === 0) return { ok: false, reason: "empty" };
  // WoCo sends at most two calls; four leaves room and bounds the gas a batch can ask for.
  if (calls.length > MAX_CALLS) return { ok: false, reason: "calls" };
  if (calls.some((c) => c.value !== 0n)) return { ok: false, reason: "value" };

  // The key ring (#186): last, after a co-owner change, or alone. Anywhere else, never.
  const ringLast = isSetRing(calls[calls.length - 1]!);
  if (calls.some((c, i) => c.to === RING_ANCHOR && !(ringLast && i === calls.length - 1))) {
    return { ok: false, reason: "ring" };
  }
  if (!ringLast) return classifyCalls(calls, op.sender);
  if (calls.length === 1) return { ok: true, shape: "ring", subject: op.sender };
  const inner = classifyCalls(calls.slice(0, -1), op.sender);
  return inner.ok && (inner.shape === "renew" || inner.shape === "co-owners") ? inner : { ok: false, reason: "ring" };
}

/** The `execute` calls of every shape but the ring's, classified. */
function classifyCalls(calls: InnerCall[], sender: string): Classified {
  if (calls.length === 1 && calls[0].to === WEIGHTED) {
    return isRenew(calls[0]) ? { ok: true, shape: "renew", subject: sender } : { ok: false, reason: "co-owners" };
  }
  if (calls.length === 2 && calls[0].to === sender && calls[1].to === sender && !isRouteUninstall(calls[0], sender)) {
    const size = coOwnerSwitchSize(calls, sender);
    if (size === 0) return { ok: false, reason: "co-owners" };
    return { ok: true, shape: size === 1 ? "upgrade" : "co-owners", subject: sender };
  }
  if (calls.length === 1 && calls[0].to !== sender && calls[0].to !== HOOK) {
    const target = recoveryTarget(calls[0]);
    return target ? { ok: true, shape: "recover", subject: target, guardian: sender } : { ok: false, reason: "call" };
  }
  if (calls.length === 2 && validatorCall(calls[0], "onUninstall") === "0x") {
    const owner = validatorCall(calls[1], "onInstall");
    return owner !== null && owner.length === 42
      ? { ok: true, shape: "rotate", subject: sender }
      : { ok: false, reason: "call" };
  }
  let uninstalls = 0;
  for (const c of calls) {
    if (isRouteUninstall(c, sender)) uninstalls++;
    else if (!isHookMutator(c)) return { ok: false, reason: "call" };
  }
  return { ok: true, shape: uninstalls > 0 ? "remove-route" : "guardians", subject: sender };
}

export interface PolicyDeps {
  gate(account: string): Promise<GateStatus>;
  /** Is `guardian` on `account`'s recovery list right now? null = could not read. */
  isGuardian(account: string, guardian: string): Promise<boolean | null>;
  /** Spend the intent the locked account's own session asked for: true when it held one. */
  upgradeIntent: { spend(account: string): boolean };
}

export type Decision =
  | { proceed: true; shape: SponsorShape; subject: string; via?: string }
  | { proceed: false; reason: string; shape?: SponsorShape; subject?: string };

/**
 * What one op may cost at most, in wei: 5e14 (0.0005 ETH) is ~25x a normal
 * Arbitrum One recovery op and still fits the 3M verification fallback and the
 * 1M recovery call gas at a spiking fee. `ZERODEV_POLICY_MAX_OP_COST_WEI` overrides.
 */
export const DEFAULT_MAX_OP_COST_WEI = 500_000_000_000_000n;

/**
 * Six an hour and twenty a day per account: setting up recovery, a few changes
 * and a move is a handful of ops in a session; nothing legitimate does more.
 */
export const SPONSOR_WINDOWS = [
  { limit: 6, windowMs: 60 * 60_000 },
  { limit: 20, windowMs: 24 * 60 * 60_000 },
] as const;

/** userOps already counted, so the stub, the final request and a retry count once. */
const SEEN_MAX = 10_000;


export class SponsorPolicy {
  private readonly limiter = new SlidingWindowLimiter(SPONSOR_WINDOWS);
  private readonly seen = new Map<string, true>();
  private readonly lockedUpgradesPaid = new RollingDayCount();

  constructor(
    private readonly deps: PolicyDeps,
    private readonly maxOpCostWei: bigint = DEFAULT_MAX_OP_COST_WEI,
  ) {}

  async decide(op: PolicyUserOp): Promise<Decision> {
    const shape = classifyUserOp(op);
    if (!shape.ok) return { proceed: false, reason: shape.reason };
    const { subject } = shape;
    // Email accounts' backups are off for launch (#186): no op that ADDS one is paid.
    // Removing them stays paid - an upgrade to a passkey removes them first.
    if (!FEATURES.accountBackupsAllowed && (shape.shape === "install-route" || shape.shape === "guardians")) {
      return { proceed: false, reason: "backups-off", shape: shape.shape, subject };
    }
    // Every request, the counted ones too: the stub carries no limits, the final
    // carries the real ones.
    if (op.maxCostWei > this.maxOpCostWei) return { proceed: false, reason: "gas", shape: shape.shape, subject };
    const opKey = `${op.sender}:${op.nonce}:${subject}`;
    const counted = this.seen.has(opKey);
    if (!counted && !this.limiter.peek(subject)) return { proceed: false, reason: "cap", shape: shape.shape, subject };

    // A read that cannot answer refuses (the gate already does): the dashboard
    // retries nothing, and the user retries the action.
    const gate = await this.deps.gate(subject).catch((): GateStatus => ({ gated: false }));
    // The gate's rollout kill-switch opens screens, never the platform's gas.
    const locked = !gate.gated || gate.via === "disabled";
    // A NEW op of a locked account must be an upgrade its own session asked for; the
    // stub, final and a same-nonce retry of one already counted ride on it.
    if (locked) {
      if (shape.shape !== "upgrade") return { proceed: false, reason: "locked", shape: shape.shape, subject };
      // Spent here: nothing after this refuses an upgrade op (it has no guardian read).
      if (!counted && !this.deps.upgradeIntent.spend(subject)) return { proceed: false, reason: "no-intent", shape: shape.shape, subject };
    }
    if (shape.guardian) {
      const listed = await this.deps.isGuardian(subject, shape.guardian).catch(() => null);
      if (listed !== true) {
        return { proceed: false, reason: listed === null ? "unreadable" : "not-guardian", shape: shape.shape, subject };
      }
    }

    if (!counted) {
      this.limiter.record(subject);
      this.seen.set(opKey, true);
      while (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.keys().next().value as string);
      if (locked) this.lockedUpgradesPaid.record();
    }
    if (locked) return { proceed: true, shape: shape.shape, subject, via: "locked-upgrade" };
    return { proceed: true, shape: shape.shape, subject, via: gate.via };
  }

  /** Locked accounts' upgrade ops paid in the last 24 h - each counted once, not per request.
   *  No threshold: the number to watch so the ZeroDev plan is raised in time (owner 10-08). */
  lockedUpgradesPaid24h(): number {
    return this.lockedUpgradesPaid.count();
  }
}

/** For the decision log: enough to find the op, nothing that could replay it. */
export function callDataTag(callData: Hex): string {
  return keccak256(callData).slice(0, 18);
}
