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
 *   HOW MUCH - a per-account cap, counted once per userOp (`sender:nonce`), so the
 *           stub and final sponsorship requests and any retry count once.
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
import type { GateStatus } from "../gate/check.js";
import { SlidingWindowLimiter } from "../http/rate-limit.js";

export type SponsorShape = "install-route" | "guardians" | "remove-route" | "rotate" | "recover";

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
  return { sender: lc(sender), nonce, callData: callData as Hex, factory: factory && lc(factory) };
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
  if (calls.some((c) => c.value !== 0n)) return { ok: false, reason: "value" };

  if (calls.length === 1 && calls[0].to !== op.sender && calls[0].to !== HOOK) {
    const target = recoveryTarget(calls[0]);
    return target ? { ok: true, shape: "recover", subject: target, guardian: op.sender } : { ok: false, reason: "call" };
  }
  if (calls.length === 2 && validatorCall(calls[0], "onUninstall") === "0x") {
    const owner = validatorCall(calls[1], "onInstall");
    return owner !== null && owner.length === 42
      ? { ok: true, shape: "rotate", subject: op.sender }
      : { ok: false, reason: "call" };
  }
  let uninstalls = 0;
  for (const c of calls) {
    if (isRouteUninstall(c, op.sender)) uninstalls++;
    else if (!isHookMutator(c)) return { ok: false, reason: "call" };
  }
  return { ok: true, shape: uninstalls > 0 ? "remove-route" : "guardians", subject: op.sender };
}

export interface PolicyDeps {
  gate(account: string): Promise<GateStatus>;
  /** Is `guardian` on `account`'s recovery list right now? null = could not read. */
  isGuardian(account: string, guardian: string): Promise<boolean | null>;
}

export type Decision =
  | { proceed: true; shape: SponsorShape; subject: string; via?: string }
  | { proceed: false; reason: string; shape?: SponsorShape; subject?: string };

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

  constructor(private readonly deps: PolicyDeps) {}

  async decide(op: PolicyUserOp): Promise<Decision> {
    const shape = classifyUserOp(op);
    if (!shape.ok) return { proceed: false, reason: shape.reason };
    const { subject } = shape;
    const opKey = `${op.sender}:${op.nonce}`;
    const counted = this.seen.has(opKey);
    if (!counted && !this.limiter.peek(subject)) return { proceed: false, reason: "cap", shape: shape.shape, subject };

    // A read that cannot answer refuses (the gate already does): the dashboard
    // retries nothing, and the user retries the action.
    const gate = await this.deps.gate(subject).catch((): GateStatus => ({ gated: false }));
    if (!gate.gated) return { proceed: false, reason: "locked", shape: shape.shape, subject };
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
    }
    return { proceed: true, shape: shape.shape, subject, via: gate.via };
  }
}

/** For the decision log: enough to find the op, nothing that could replay it. */
export function callDataTag(callData: Hex): string {
  return keccak256(callData).slice(0, 18);
}
