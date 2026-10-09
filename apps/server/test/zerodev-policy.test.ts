/**
 * The sponsorship policy (#758): what ZeroDev may pay for, decided here.
 *
 * Every allowed shape is built by the code that really sends it - the app's own
 * builders (apps/web/src/lib/auth/{recovery-route,guardian-hook}.ts) wrapped by the
 * ZeroDev SDK's own `encodeCalls`, offline - so the decoder is pinned to the bytes
 * the browser sends, not to a second copy of the encoding. `rotateOwnerSelf` and
 * `recoverAccount` (kernel-account.ts) encode inline; their two lines are repeated
 * here verbatim.
 *
 * MUTATION: accept any `execute` call, drop the value / exec-mode / factory checks,
 * gate a recovery on its sender, skip the guardian read, or count the stub and the
 * final request twice, and a case goes red.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  concat,
  createPublicClient,
  custom,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  parseAbiParameters,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";
import { arbitrum } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { createKernelAccount } from "@zerodev/sdk";
import { getEntryPoint, KERNEL_V3_1, KernelVersionToAddressesMap } from "@zerodev/sdk/constants";
import { signerToEcdsaValidator, getValidatorAddress } from "@zerodev/ecdsa-validator";
import { KERNEL_CHAIN_ID } from "@woco/shared";
import { RECOVERY_EXECUTOR_FN } from "@woco/shared/kernel/recovery-contracts";
import {
  buildRegisterGuardianCallData,
  buildRemoveRecoveryCalls,
  type RouteEncoders,
} from "../../web/src/lib/auth/recovery-route.js";
import {
  buildAddGuardianCall,
  buildRevokeGuardianCall,
  buildSetGuardiansCall,
  buildClearGuardiansCall,
} from "../../web/src/lib/auth/guardian-hook.js";
import {
  SponsorPolicy,
  classifyUserOp,
  readUserOp,
  type PolicyDeps,
  type PolicyUserOp,
} from "../src/lib/zerodev/sponsor-policy.js";
import type { GateStatus } from "../src/lib/gate/check.js";
import { enableFeature } from "./helpers/features.js";

// The backup ops below are tested as paid; "backups off" has its own test at the end.
enableFeature("accountBackupsAllowed");

const entryPoint = getEntryPoint("0.7");
const ECDSA = getValidatorAddress(entryPoint, KERNEL_V3_1);
const d: RouteEncoders = {
  encodeFunctionData,
  parseAbi,
  parseAbiParameters,
  encodeAbiParameters,
  toFunctionSelector,
  concat,
};

const ACCOUNT = "0x1111111111111111111111111111111111111111" as Address;
const GUARDIAN_KERNEL = "0x2222222222222222222222222222222222222222" as Address;
const GUARDIAN_EOA = "0x3333333333333333333333333333333333333333" as Address;
const NEW_OWNER = "0x4444444444444444444444444444444444444444" as Address;

/** The SDK's own Kernel v3.1 account, offline: only the chain id is ever asked for. */
async function kernelAt(address: Address) {
  const client = createPublicClient({
    chain: arbitrum,
    transport: custom({
      request: async ({ method }) => {
        if (method === "eth_chainId") return "0xa4b1";
        throw new Error(`no network in tests: ${method}`);
      },
    }),
  });
  const signer = privateKeyToAccount(`0x${"11".repeat(32)}`);
  const sudo = await signerToEcdsaValidator(client, { signer, entryPoint, kernelVersion: KERNEL_V3_1 });
  return createKernelAccount(client, { plugins: { sudo }, entryPoint, kernelVersion: KERNEL_V3_1, address });
}

const account = await kernelAt(ACCOUNT);
const guardianAccount = await kernelAt(GUARDIAN_KERNEL);

type Call = { to: Address; data: Hex; value?: bigint };
const viaExecute = (calls: Call[]) => account.encodeCalls(calls.map((c) => ({ ...c, value: c.value ?? 0n })));
const op = (callData: Hex, over: Partial<PolicyUserOp> = {}): PolicyUserOp => ({
  sender: ACCOUNT.toLowerCase(),
  nonce: "1",
  callData,
  factory: null,
  maxCostWei: 0n,
  ...over,
});

// kernel-account.ts rotateOwnerSelf, verbatim.
const rotationAbi = parseAbi(["function onUninstall(bytes)", "function onInstall(bytes)"]);
const rotationCalls = (owner: Address): Call[] => [
  { to: ECDSA, data: encodeFunctionData({ abi: rotationAbi, functionName: "onUninstall", args: ["0x"] }) },
  { to: ECDSA, data: encodeFunctionData({ abi: rotationAbi, functionName: "onInstall", args: [owner.toLowerCase() as Hex] }) },
];
// kernel-account.ts recoverAccount, verbatim.
const recoveryCall = (target: Address): Call => ({
  to: target,
  data: encodeFunctionData({ abi: parseAbi([RECOVERY_EXECUTOR_FN]), functionName: "doRecovery", args: [ECDSA, NEW_OWNER] }),
});

// ── WHAT: the shapes WoCo sends ──────────────────────────────────────────────

test("first backup: the raw installModule setupRecovery sends (not inside execute)", () => {
  const c = classifyUserOp(op(buildRegisterGuardianCallData(d, GUARDIAN_KERNEL)));
  assert.deepEqual(c, { ok: true, shape: "install-route", subject: ACCOUNT.toLowerCase() });
});

test("guardian add / revoke / set / clear through execute", async () => {
  for (const call of [
    buildAddGuardianCall(encodeFunctionData, GUARDIAN_KERNEL),
    buildRevokeGuardianCall(encodeFunctionData, GUARDIAN_KERNEL),
    buildSetGuardiansCall(encodeFunctionData, [GUARDIAN_KERNEL]),
    buildClearGuardiansCall(encodeFunctionData),
  ]) {
    const c = classifyUserOp(op(await viaExecute([call])));
    assert.equal(c.ok && c.shape, "guardians");
  }
});

test("remove all backups: uninstall the route + clear, one batch", async () => {
  const c = classifyUserOp(op(await viaExecute(buildRemoveRecoveryCalls(d, ACCOUNT))));
  assert.equal(c.ok && c.shape, "remove-route");
});

test("make this device the main one: exactly the two validator calls", async () => {
  const c = classifyUserOp(op(await viaExecute(rotationCalls(NEW_OWNER))));
  assert.deepEqual(c, { ok: true, shape: "rotate", subject: ACCOUNT.toLowerCase() });
});

test("recovery: the subject is the TARGET account, the sender is the guardian", async () => {
  const callData = await guardianAccount.encodeCalls([{ ...recoveryCall(ACCOUNT), value: 0n }]);
  const c = classifyUserOp(op(callData, { sender: GUARDIAN_KERNEL.toLowerCase() }));
  assert.deepEqual(c, { ok: true, shape: "recover", subject: ACCOUNT.toLowerCase(), guardian: GUARDIAN_KERNEL.toLowerCase() });
});

test("a counterfactual account deploys through the Kernel v3.1 factory only", async () => {
  const callData = await viaExecute([buildAddGuardianCall(encodeFunctionData, GUARDIAN_KERNEL)]);
  const { factoryAddress, metaFactoryAddress } = KernelVersionToAddressesMap[KERNEL_V3_1];
  assert.equal(classifyUserOp(op(callData, { factory: metaFactoryAddress!.toLowerCase() })).ok, true);
  assert.equal(classifyUserOp(op(callData, { factory: factoryAddress.toLowerCase() })).ok, true);
  assert.deepEqual(classifyUserOp(op(callData, { factory: GUARDIAN_EOA.toLowerCase() })), { ok: false, reason: "factory" });
});

// ── WHAT: everything else is refused ─────────────────────────────────────────

test("an arbitrary call through execute is refused", async () => {
  const transfer = encodeFunctionData({ abi: parseAbi(["function transfer(address,uint256)"]), functionName: "transfer", args: [GUARDIAN_EOA, 1n] });
  assert.deepEqual(classifyUserOp(op(await viaExecute([{ to: GUARDIAN_EOA, data: transfer }]))), { ok: false, reason: "call" });
  // ...even batched behind an allowed one
  const mixed = await viaExecute([buildAddGuardianCall(encodeFunctionData, GUARDIAN_KERNEL), { to: GUARDIAN_EOA, data: transfer }]);
  assert.deepEqual(classifyUserOp(op(mixed)), { ok: false, reason: "call" });
});

test("a hook READ through execute is refused (costs gas, does nothing)", async () => {
  const read = encodeFunctionData({ abi: parseAbi(["function guardiansOf(address) view returns (address[])"]), functionName: "guardiansOf", args: [ACCOUNT] });
  const call = { ...buildAddGuardianCall(encodeFunctionData, GUARDIAN_KERNEL), data: read };
  assert.deepEqual(classifyUserOp(op(await viaExecute([call]))), { ok: false, reason: "call" });
});

test("value on any call is refused", async () => {
  const call = { ...buildAddGuardianCall(encodeFunctionData, GUARDIAN_KERNEL), value: 1n };
  assert.deepEqual(classifyUserOp(op(await viaExecute([call]))), { ok: false, reason: "value" });
});

test("a non-default exec mode or call type is refused", async () => {
  const good = await viaExecute([buildAddGuardianCall(encodeFunctionData, GUARDIAN_KERNEL)]);
  // execute(bytes32 mode, bytes) - the mode word starts right after the selector.
  const withMode = (mode: string) => (good.slice(0, 10) + mode + good.slice(74)) as Hex;
  assert.deepEqual(classifyUserOp(op(withMode(`0001${"0".repeat(60)}`))), { ok: false, reason: "exec-mode" }, "try exec type");
  assert.deepEqual(classifyUserOp(op(withMode(`ff${"0".repeat(62)}`))), { ok: false, reason: "call-type" }, "delegatecall");
  assert.deepEqual(classifyUserOp(op(withMode(`00${"0".repeat(52)}0000000001`))), { ok: false, reason: "exec-mode" }, "payload");
});

test("a rotation with anything else in the batch is refused", async () => {
  const extra = await viaExecute([...rotationCalls(NEW_OWNER), buildAddGuardianCall(encodeFunctionData, GUARDIAN_KERNEL)]);
  assert.equal(classifyUserOp(op(extra)).ok, false);
  const onlyInstall = await viaExecute([rotationCalls(NEW_OWNER)[1]]);
  assert.equal(classifyUserOp(op(onlyInstall)).ok, false);
});

test("installing any other module, or the route with another hook, is refused", () => {
  // concat keeps the checksummed case of the hook address; compare in lower case.
  const route = buildRegisterGuardianCallData(d, GUARDIAN_KERNEL).toLowerCase() as Hex;
  assert.equal(classifyUserOp(op(route)).ok, true);
  const otherHook = route.replace("f43524473ebc651969becc748462ed27ed39d4db", "990a9fc8189d96d59e3ce98bd87f42135a24a30e") as Hex;
  assert.notEqual(otherHook, route, "the hook address is in the init data");
  assert.deepEqual(classifyUserOp(op(otherHook)), { ok: false, reason: "install" });
  const otherModule = route.replace("e884c2868cc82c16177ec73a93f7d9e6f3a5dc6e", "5555555555555555555555555555555555555555") as Hex;
  assert.deepEqual(classifyUserOp(op(otherModule)), { ok: false, reason: "install" });
});

test("the hooked executeUserOp form and unknown selectors are refused", async () => {
  const good = await viaExecute([buildAddGuardianCall(encodeFunctionData, GUARDIAN_KERNEL)]);
  assert.deepEqual(classifyUserOp(op(`0x8dd7712f${good.slice(2)}` as Hex)), { ok: false, reason: "selector" });
});

// ── Reading ZeroDev's body ───────────────────────────────────────────────────

test("reads EntryPoint 0.7 and 0.6 bodies; malformed ones are null", () => {
  const callData = buildRegisterGuardianCallData(d, GUARDIAN_KERNEL);
  const v07 = readUserOp({ sender: ACCOUNT, nonce: "0x1f", callData, factory: null, factoryData: null });
  assert.deepEqual(v07, { sender: ACCOUNT.toLowerCase(), nonce: "31", callData, factory: null, maxCostWei: 0n });
  const meta = KernelVersionToAddressesMap[KERNEL_V3_1].metaFactoryAddress!;
  const v06 = readUserOp({ sender: ACCOUNT, nonce: 5, callData, initCode: `${meta}abcdef` });
  assert.equal(v06?.factory, meta.toLowerCase());
  assert.equal(readUserOp({ sender: "0x12", nonce: "1", callData }), null);
  assert.equal(readUserOp({ sender: ACCOUNT, nonce: "x", callData }), null);
  assert.equal(readUserOp({ sender: ACCOUNT, nonce: "1", callData: "0x12" }), null);
  assert.equal(readUserOp(null), null);
});

test("the cost bound is the gas the sender chose x max fee, unpacked or packed", () => {
  const callData = buildRegisterGuardianCallData(d, GUARDIAN_KERNEL);
  const unpacked = readUserOp({
    sender: ACCOUNT, nonce: "1", callData,
    preVerificationGas: "0x130b0", verificationGasLimit: 3_000_000, callGasLimit: "1000000", maxFeePerGas: "0x1312d00",
  });
  assert.equal(unpacked?.maxCostWei, (78_000n + 3_000_000n + 1_000_000n) * 20_000_000n);
  const word = (hi: bigint, lo: bigint) => `0x${hi.toString(16).padStart(32, "0")}${lo.toString(16).padStart(32, "0")}`;
  const packed = readUserOp({
    sender: ACCOUNT, nonce: "1", callData, preVerificationGas: 78_000,
    accountGasLimits: word(3_000_000n, 1_000_000n), gasFees: word(1n, 20_000_000n),
  });
  assert.equal(packed?.maxCostWei, unpacked?.maxCostWei);
  assert.equal(readUserOp({ sender: ACCOUNT, nonce: "1", callData, maxFeePerGas: "-1" }), null);
});

test("more than four calls in one batch is refused", async () => {
  const add = buildAddGuardianCall(encodeFunctionData, GUARDIAN_KERNEL);
  assert.equal(classifyUserOp(op(await viaExecute([add, add, add, add]))).ok, true);
  assert.deepEqual(classifyUserOp(op(await viaExecute([add, add, add, add, add]))), { ok: false, reason: "calls" });
});

// ── WHO and HOW MUCH ─────────────────────────────────────────────────────────

let unlocked: Set<string>;
let guardians: Map<string, boolean | null>;
let gateCalls: string[];
let intents: Set<string>;
const deps: PolicyDeps = {
  upgradeIntent: { spend: (a) => intents.delete(a) },
  async gate(a): Promise<GateStatus> {
    gateCalls.push(a);
    return unlocked.has(a) ? { gated: true, via: "ticket" } : { gated: false };
  },
  async isGuardian(a, g) {
    return guardians.has(`${a}:${g}`) ? guardians.get(`${a}:${g}`)! : false;
  },
};
beforeEach(() => {
  unlocked = new Set();
  guardians = new Map();
  gateCalls = [];
  intents = new Set();
});

test("a locked account is refused; an unlocked one is paid for", async () => {
  const p = new SponsorPolicy(deps);
  const callData = await viaExecute([buildAddGuardianCall(encodeFunctionData, GUARDIAN_KERNEL)]);
  assert.equal((await p.decide(op(callData))).proceed, false);
  unlocked.add(ACCOUNT.toLowerCase());
  assert.deepEqual(await p.decide(op(callData, { nonce: "2" })), {
    proceed: true,
    shape: "guardians",
    subject: ACCOUNT.toLowerCase(),
    via: "ticket",
  });
});

test("recovery is gated on the account being recovered, and on the guardian being listed", async () => {
  const p = new SponsorPolicy(deps);
  const callData = await guardianAccount.encodeCalls([{ ...recoveryCall(ACCOUNT), value: 0n }]);
  const recovery = op(callData, { sender: GUARDIAN_KERNEL.toLowerCase() });
  const key = `${ACCOUNT.toLowerCase()}:${GUARDIAN_KERNEL.toLowerCase()}`;

  unlocked.add(GUARDIAN_KERNEL.toLowerCase());
  guardians.set(key, true);
  assert.deepEqual(await p.decide(recovery), { proceed: false, reason: "locked", shape: "recover", subject: ACCOUNT.toLowerCase() });
  assert.deepEqual(gateCalls, [ACCOUNT.toLowerCase()], "the guardian's own unlock is never asked");

  unlocked.add(ACCOUNT.toLowerCase());
  guardians.set(key, false);
  assert.deepEqual(await p.decide(recovery), { proceed: false, reason: "not-guardian", shape: "recover", subject: ACCOUNT.toLowerCase() });
  guardians.set(key, null);
  assert.deepEqual(await p.decide(recovery), { proceed: false, reason: "unreadable", shape: "recover", subject: ACCOUNT.toLowerCase() });
  guardians.set(key, true);
  assert.equal((await p.decide(recovery)).proceed, true);
});

test("six ops an hour per account; the stub and final request of one op count once", async () => {
  unlocked.add(ACCOUNT.toLowerCase());
  const p = new SponsorPolicy(deps);
  const callData = await viaExecute([buildAddGuardianCall(encodeFunctionData, GUARDIAN_KERNEL)]);
  for (let n = 1; n <= 6; n++) {
    assert.equal((await p.decide(op(callData, { nonce: String(n) }))).proceed, true, `stub of op ${n}`);
    assert.equal((await p.decide(op(callData, { nonce: String(n) }))).proceed, true, `final of op ${n}`);
  }
  assert.deepEqual(await p.decide(op(callData, { nonce: "7" })), { proceed: false, reason: "cap", shape: "guardians", subject: ACCOUNT.toLowerCase() });
  assert.equal((await p.decide(op(callData, { nonce: "6" }))).proceed, true, "an op already counted still completes");
  // Another account has its own budget.
  const other = "0x9999999999999999999999999999999999999999";
  unlocked.add(other);
  assert.equal((await p.decide(op(callData, { sender: other, nonce: "7" }))).proceed, true);
});

test("an op that could cost more than the ceiling is refused, every request, counted or not", async () => {
  unlocked.add(ACCOUNT.toLowerCase());
  const p = new SponsorPolicy(deps, 1_000n);
  const callData = await viaExecute([buildAddGuardianCall(encodeFunctionData, GUARDIAN_KERNEL)]);
  assert.equal((await p.decide(op(callData, { nonce: "1", maxCostWei: 0n }))).proceed, true, "the stub carries no limits");
  assert.deepEqual(await p.decide(op(callData, { nonce: "1", maxCostWei: 1_001n })), {
    proceed: false, reason: "gas", shape: "guardians", subject: ACCOUNT.toLowerCase(),
  });
  assert.equal((await p.decide(op(callData, { nonce: "1", maxCostWei: 1_000n }))).proceed, true);
});

test("the gate's rollout kill-switch never opens the platform's gas", async () => {
  const p = new SponsorPolicy({ ...deps, gate: async () => ({ gated: true, via: "disabled" }) });
  const callData = await viaExecute([buildAddGuardianCall(encodeFunctionData, GUARDIAN_KERNEL)]);
  assert.equal((await p.decide(op(callData))).proceed, false);
});

test("one guardian op counted against one account never rides free on another", async () => {
  const p = new SponsorPolicy(deps);
  const a = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
  const b = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;
  for (const t of [a, b]) {
    unlocked.add(t);
    guardians.set(`${t}:${GUARDIAN_KERNEL.toLowerCase()}`, true);
  }
  // Six ops recovering A with nonces 1..6 spend A's hour.
  for (let n = 1; n <= 6; n++) {
    const callData = await guardianAccount.encodeCalls([{ ...recoveryCall(a), value: 0n }]);
    assert.equal((await p.decide(op(callData, { sender: GUARDIAN_KERNEL.toLowerCase(), nonce: String(n) }))).proceed, true);
  }
  const forA = await guardianAccount.encodeCalls([{ ...recoveryCall(a), value: 0n }]);
  assert.equal((await p.decide(op(forA, { sender: GUARDIAN_KERNEL.toLowerCase(), nonce: "7" }))).proceed, false, "A is capped");
  // The same nonces naming B are different ops, each counted on B's budget.
  const forB = await guardianAccount.encodeCalls([{ ...recoveryCall(b), value: 0n }]);
  for (let n = 1; n <= 6; n++) {
    assert.equal((await p.decide(op(forB, { sender: GUARDIAN_KERNEL.toLowerCase(), nonce: String(n) }))).proceed, true);
  }
  assert.equal((await p.decide(op(forB, { sender: GUARDIAN_KERNEL.toLowerCase(), nonce: "7" }))).proceed, false, "B is capped too");
});

test("a refused shape never reaches the gate", async () => {
  const p = new SponsorPolicy(deps);
  const transfer = encodeFunctionData({ abi: parseAbi(["function transfer(address,uint256)"]), functionName: "transfer", args: [GUARDIAN_EOA, 1n] });
  await p.decide(op(await viaExecute([{ to: GUARDIAN_EOA, data: transfer }])));
  assert.deepEqual(gateCalls, []);
});

// ── The route ────────────────────────────────────────────────────────────────

const SECRET = "s".repeat(40);
const PROJECT = "test-project-id";
const { Hono } = await import("hono");
const { zerodevPolicy, zerodevPolicyHealth, _resetZerodevPolicyForTests } = await import("../src/routes/zerodev-policy.js");
const app = new Hono();
app.route("/api/zerodev/policy", zerodevPolicy);

async function post(secret: string, body: unknown) {
  const res = await app.request(`/api/zerodev/policy/${secret}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: res.status === 200 ? await res.json() : null };
}

test("route: unset config refuses everything; a wrong secret is a 404; project and chain are pinned", async () => {
  _resetZerodevPolicyForTests(deps);
  unlocked.add(ACCOUNT.toLowerCase());
  const userOp = { sender: ACCOUNT, nonce: "0x1", callData: buildRegisterGuardianCallData(d, GUARDIAN_KERNEL), factory: null };
  const body = { projectId: PROJECT, chainId: KERNEL_CHAIN_ID, userOp };

  delete process.env.ZERODEV_POLICY_SECRET;
  process.env.ZERODEV_PROJECT_ID = PROJECT;
  assert.equal((await post(SECRET, body)).status, 503);
  assert.equal(zerodevPolicyHealth().ok, false);
  process.env.ZERODEV_POLICY_SECRET = "too-short";
  assert.equal((await post("too-short", body)).status, 503, "a short secret is no secret");
  process.env.ZERODEV_POLICY_SECRET = SECRET;
  delete process.env.ZERODEV_PROJECT_ID;
  assert.equal((await post(SECRET, body)).status, 503);
  process.env.ZERODEV_PROJECT_ID = PROJECT;
  assert.equal(zerodevPolicyHealth().ok, true);

  assert.equal((await post(`${SECRET}x`, body)).status, 404);
  assert.deepEqual((await post(SECRET, { ...body, projectId: "another" })).json, { proceed: false, logicalOperator: "and" });
  assert.deepEqual((await post(SECRET, { ...body, chainId: 421614 })).json, { proceed: false, logicalOperator: "and" });
  assert.deepEqual((await post(SECRET, { ...body, userOp: { ...userOp, sender: "0x12" } })).json, { proceed: false, logicalOperator: "and" });
  assert.deepEqual((await post(SECRET, body)).json, { proceed: true, logicalOperator: "or" });
  assert.equal(zerodevPolicyHealth().allowed, 1);
  assert.equal(zerodevPolicyHealth().lastRefusal?.reason, "userop");
  assert.equal(zerodevPolicyHealth().maxOpCostWei, "500000000000000");
});

test("route: wrong guesses lock out only the guessing address; a flood past the secret is 'busy'", async () => {
  _resetZerodevPolicyForTests(deps);
  unlocked.add(ACCOUNT.toLowerCase());
  process.env.ZERODEV_POLICY_SECRET = SECRET;
  process.env.ZERODEV_PROJECT_ID = PROJECT;
  const userOp = { sender: ACCOUNT, nonce: "0x1", callData: buildRegisterGuardianCallData(d, GUARDIAN_KERNEL), factory: null };
  const body = { projectId: PROJECT, chainId: KERNEL_CHAIN_ID, userOp };
  const at = async (ip: string, secret: string) =>
    (await app.request(`/api/zerodev/policy/${secret}`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": ip },
      body: JSON.stringify(body),
    })).status;
  for (let i = 0; i < 100; i++) assert.equal(await at("198.51.100.1", "x".repeat(40)), 404);
  assert.equal(await at("198.51.100.1", SECRET), 404, "that address is locked out, right secret or not");
  assert.equal(await at("198.51.100.2", SECRET), 200, "ZeroDev's address never guessed, so it is never locked out");

  for (let i = 0; i < 119; i++) await post(SECRET, body);
  assert.deepEqual((await post(SECRET, body)).json, { proceed: false, logicalOperator: "and" });
  assert.equal(zerodevPolicyHealth().lastRefusal?.reason, "busy");
});

test("a yes stands on its own ('or'); a no can never become a yes ('and')", async () => {
  const { policyReply } = await import("../src/routes/zerodev-policy.js");
  assert.deepEqual(policyReply(true), { proceed: true, logicalOperator: "or" });
  assert.deepEqual(policyReply(false), { proceed: false, logicalOperator: "and" });
});

// ── Co-owners (#746): every passkey a signer on the weighted root ──────────────
// Built with the ZeroDev SDK's own encoders: the Kernel v3.1 ABI its
// changeSudoValidator uses, and the weighted plugin's getUpdateConfigCall. The
// enable data is the plugin's getEnableData layout (descending signers).

const { KernelV3_1AccountAbi } = await import("@zerodev/sdk");
const { getUpdateConfigCall } = await import("@zerodev/weighted-ecdsa-validator");
const WEIGHTED_V31 = "0xeD89244160CfE273800B58b1B534031699dFeEEE" as Address;
const P1 = "0x5555555555555555555555555555555555555555" as Address;
const P2 = "0x6666666666666666666666666666666666666666" as Address;
const desc = (xs: Address[]) => [...xs].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? 1 : -1));
const enableOf = (signers: Address[], weights?: number[], threshold = 1, delay = 0) =>
  encodeAbiParameters(parseAbiParameters("address[], uint24[], uint24, uint48"), [
    desc(signers),
    weights ?? signers.map(() => 1),
    threshold,
    delay,
  ]);
const switchCalls = (enable: Hex, over: { root?: Hex; hook?: Address; dropped?: Address } = {}): Call[] => [
  {
    to: ACCOUNT,
    data: encodeFunctionData({
      abi: KernelV3_1AccountAbi,
      functionName: "changeRootValidator",
      args: [over.root ?? (`0x01${WEIGHTED_V31.slice(2)}` as Hex), over.hook ?? "0x0000000000000000000000000000000000000000", enable, "0x"],
    }),
  },
  {
    to: ACCOUNT,
    data: encodeFunctionData({
      abi: KernelV3_1AccountAbi,
      functionName: "uninstallValidation",
      args: [`0x01${(over.dropped ?? ECDSA).slice(2)}` as Hex, "0x", "0x"],
    }),
  },
];
const renewCall = (signers: Address[], threshold = 1, weight = 1): Call => {
  const c = getUpdateConfigCall(entryPoint, KERNEL_V3_1, { threshold, signers: signers.map((address) => ({ address, weight })) });
  return { to: c.to as Address, data: c.data as Hex };
};

test("co-owners: the switch is changeRootValidator(weighted) + uninstallValidation(ECDSA), one batch", async () => {
  const c = classifyUserOp(op(await viaExecute(switchCalls(enableOf([P1, P2])))));
  assert.deepEqual(c, { ok: true, shape: "co-owners", subject: ACCOUNT.toLowerCase() });
  // a counterfactual account deploys and switches in its first op
  const { metaFactoryAddress } = KernelVersionToAddressesMap[KERNEL_V3_1];
  const first = await viaExecute(switchCalls(enableOf([P1, P2])));
  assert.equal(classifyUserOp(op(first, { factory: metaFactoryAddress!.toLowerCase() })).ok, true);
});

test("co-owners: renew through the weighted plugin's own update call", async () => {
  const c = classifyUserOp(op(await viaExecute([renewCall([P1, P2, NEW_OWNER])])));
  assert.deepEqual(c, { ok: true, shape: "renew", subject: ACCOUNT.toLowerCase() });
  assert.equal(classifyUserOp(op(await viaExecute([renewCall([P2])]))).ok, true, "down to one passkey");
});

test("co-owners: a list that would lock the account is never paid for", async () => {
  const refused = async (calls: Call[], why: string) =>
    assert.deepEqual(classifyUserOp(op(await viaExecute(calls))), { ok: false, reason: "co-owners" }, why);
  await refused([renewCall([])], "empty list");
  await refused([renewCall([P1, P2], 2)], "threshold above one");
  await refused([renewCall([P1], 1, 2)], "weight above one");
  await refused([renewCall([P1, P1])], "the same key twice");
  const eleven = Array.from({ length: 11 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}` as Address);
  await refused([renewCall(eleven)], "more than ten");
  await refused([{ to: WEIGHTED_V31, data: encodeFunctionData({ abi: parseAbi(["function renew(address[],uint24[],uint24,uint48)"]), functionName: "renew", args: [[P1], [1], 1, 60] }) }], "a delay");
  await refused(switchCalls(enableOf([])), "switch to an empty list");
  await refused(switchCalls(enableOf([P1, P2], [1, 1], 2)), "switch with threshold two");
});

test("co-owners: the switch without dropping ECDSA, with a hook, or to another root is refused", async () => {
  const enable = enableOf([P1, P2]);
  assert.equal(classifyUserOp(op(await viaExecute([switchCalls(enable)[0]]))).ok, false, "alone: the old key keeps a 1271 path");
  assert.equal(classifyUserOp(op(await viaExecute(switchCalls(enable, { hook: GUARDIAN_EOA })))).ok, false, "with a hook");
  assert.equal(classifyUserOp(op(await viaExecute(switchCalls(enable, { root: `0x01${GUARDIAN_EOA.slice(2)}` as Hex })))).ok, false, "another root");
  assert.equal(classifyUserOp(op(await viaExecute(switchCalls(enable, { dropped: GUARDIAN_EOA })))).ok, false, "drops another validation");
  const reversed = switchCalls(enable).reverse();
  assert.equal(classifyUserOp(op(await viaExecute(reversed))).ok, false, "uninstall first would drop the live root");
  // renew aimed at anything but the weighted validator is not a renew
  const elsewhere = { ...renewCall([P1, P2]), to: GUARDIAN_EOA };
  assert.equal(classifyUserOp(op(await viaExecute([elsewhere]))).ok, false);
});

test("co-owners: a list out of the validator's order is refused (it would revert on our gas)", async () => {
  const renewAbi = parseAbi(["function renew(address[],uint24[],uint24,uint48)"]);
  const ascending = [P1, P2].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
  const call = { to: WEIGHTED_V31, data: encodeFunctionData({ abi: renewAbi, functionName: "renew", args: [ascending, [1, 1], 1, 0] }) };
  assert.deepEqual(classifyUserOp(op(await viaExecute([call]))), { ok: false, reason: "co-owners" });
  const enableAsc = encodeAbiParameters(parseAbiParameters("address[], uint24[], uint24, uint48"), [ascending, [1, 1], 1, 0]);
  assert.equal(classifyUserOp(op(await viaExecute(switchCalls(enableAsc)))).ok, false);
});

test("co-owners: the app's own builders are exactly what the policy pays for", async () => {
  const { coOwnerSwitchCalls, coOwnerRenewCall } = await import("../../web/src/lib/auth/co-owner-calls.js");
  const enc = { encodeFunctionData, encodeAbiParameters, parseAbi, parseAbiParameters } as never;
  const sw = coOwnerSwitchCalls(enc, ACCOUNT, [P1, P2]).map((c) => ({ to: c.to as Address, data: c.data }));
  assert.deepEqual(classifyUserOp(op(await viaExecute(sw))), { ok: true, shape: "co-owners", subject: ACCOUNT.toLowerCase() });
  const rn = coOwnerRenewCall(enc, [P1, P2, NEW_OWNER]);
  assert.deepEqual(classifyUserOp(op(await viaExecute([{ to: rn.to as Address, data: rn.data }]))), {
    ok: true,
    shape: "renew",
    subject: ACCOUNT.toLowerCase(),
  });
});

// ── The key ring (#186) ──────────────────────────────────────────────────────
// setRing on the anchor rides LAST on a co-owner change, so a removal and the keys it
// takes away land in one op; alone, it gives a passkey the keys at the same generation.

const { KEY_RING_ANCHOR_ABI, KEY_RING_ANCHOR_ADDRESS } = await import("@woco/shared/keyring/anchor");
const ringAbi = parseAbi(KEY_RING_ANCHOR_ABI);
const NO_RING_HEX = `0x${"0".repeat(64)}` as Hex;
const ringCall = (ring: Hex = `0x${"ab".repeat(32)}` as Hex, to: Address = KEY_RING_ANCHOR_ADDRESS as Address): Call => ({
  to,
  data: encodeFunctionData({ abi: ringAbi, functionName: "setRing", args: [NO_RING_HEX, ring] }),
});

test("ring: last on a renew or on the switch keeps that shape; alone it is its own", async () => {
  const subject = ACCOUNT.toLowerCase();
  assert.deepEqual(classifyUserOp(op(await viaExecute([renewCall([P1, P2]), ringCall()]))), { ok: true, shape: "renew", subject });
  assert.deepEqual(classifyUserOp(op(await viaExecute([...switchCalls(enableOf([P1, P2])), ringCall()]))), {
    ok: true,
    shape: "co-owners",
    subject,
  });
  assert.deepEqual(classifyUserOp(op(await viaExecute([ringCall()]))), { ok: true, shape: "ring", subject });
});

test("ring: never zero, never first or twice, never on another shape, never another call on the anchor", async () => {
  const refused = async (calls: Call[], why: string) =>
    assert.equal(classifyUserOp(op(await viaExecute(calls))).ok, false, why);
  await refused([ringCall(NO_RING_HEX)], "a zero ring (the contract reverts: our gas for nothing)");
  await refused([ringCall(), renewCall([P1, P2])], "before the list change");
  await refused([ringCall(), renewCall([P1, P2]), ringCall()], "twice");
  const { coOwnerSwitchCalls } = await import("../../web/src/lib/auth/co-owner-calls.js");
  const enc = { encodeFunctionData, encodeAbiParameters, parseAbi, parseAbiParameters } as never;
  const upgrade = coOwnerSwitchCalls(enc, ACCOUNT, [P1]).map((c) => ({ to: c.to as Address, data: c.data }));
  await refused([...upgrade, ringCall()], "on the locked-account upgrade");
  await refused([...switchCalls(enableOf([])), ringCall()], "after a list that would lock the account");
  const view = { to: KEY_RING_ANCHOR_ADDRESS as Address, data: encodeFunctionData({ abi: ringAbi, functionName: "ringOf", args: [ACCOUNT] }) };
  await refused([renewCall([P1, P2]), view], "anything but setRing on the anchor");
  await refused([ringCall(undefined, GUARDIAN_EOA)], "setRing on another contract");
});

test("ring: the app's own builders - renew + ring, switch + ring, ring alone - are what the policy pays for", async () => {
  const { coOwnerSwitchCalls, coOwnerRenewCall, coOwnerRingCall } = await import("../../web/src/lib/auth/co-owner-calls.js");
  const enc = { encodeFunctionData, encodeAbiParameters, parseAbi, parseAbiParameters } as never;
  const subject = ACCOUNT.toLowerCase();
  const as = (c: { to: string; data: Hex }) => ({ to: c.to as Address, data: c.data });
  const ring = as(coOwnerRingCall(enc, "aa".repeat(32), "bb".repeat(32)));
  const first = as(coOwnerRingCall(enc, null, "bb".repeat(32)));
  assert.deepEqual(classifyUserOp(op(await viaExecute([as(coOwnerRenewCall(enc, [P1, P2])), ring]))), { ok: true, shape: "renew", subject });
  assert.deepEqual(classifyUserOp(op(await viaExecute([...coOwnerSwitchCalls(enc, ACCOUNT, [P1, P2]).map(as), first]))), {
    ok: true,
    shape: "co-owners",
    subject,
  });
  assert.deepEqual(classifyUserOp(op(await viaExecute([ring]))), { ok: true, shape: "ring", subject });
});

test("ring: a locked account's ring op is refused like any other", async () => {
  const p = new SponsorPolicy(deps);
  const callData = await viaExecute([ringCall()]);
  assert.deepEqual(await p.decide(op(callData)), { proceed: false, reason: "locked", shape: "ring", subject: ACCOUNT.toLowerCase() });
  unlocked.add(ACCOUNT.toLowerCase());
  assert.deepEqual(await p.decide(op(callData)), { proceed: true, shape: "ring", subject: ACCOUNT.toLowerCase(), via: "ticket" });
});

// ── The email -> passkey upgrade (#746, owner 10-07) ─────────────────────────
// The switch to a list of ONE key: an email account handing itself to its new
// passkey. A locked account gets exactly one, under a platform-wide daily cap.

test("upgrade: the co-owner switch to one key is its own shape, deployed or counterfactual", async () => {
  const { coOwnerSwitchCalls } = await import("../../web/src/lib/auth/co-owner-calls.js");
  const enc = { encodeFunctionData, encodeAbiParameters, parseAbi, parseAbiParameters } as never;
  const sw = coOwnerSwitchCalls(enc, ACCOUNT, [P1]).map((c) => ({ to: c.to as Address, data: c.data }));
  const callData = await viaExecute(sw);
  assert.deepEqual(classifyUserOp(op(callData)), { ok: true, shape: "upgrade", subject: ACCOUNT.toLowerCase() });
  const { metaFactoryAddress } = KernelVersionToAddressesMap[KERNEL_V3_1];
  assert.deepEqual(classifyUserOp(op(callData, { factory: metaFactoryAddress!.toLowerCase() })), {
    ok: true,
    shape: "upgrade",
    subject: ACCOUNT.toLowerCase(),
  });
  // The same checks as any switch: the ECDSA validation must go in the same batch.
  assert.equal(classifyUserOp(op(await viaExecute([switchCalls(enableOf([P1]))[0]]))).ok, false, "alone");
  assert.deepEqual(classifyUserOp(op(await viaExecute(switchCalls(enableOf([P1], [2]))))), { ok: false, reason: "co-owners" });
});

test("upgrade: a locked account is paid for an upgrade op only against an intent its session asked for", async () => {
  const p = new SponsorPolicy(deps);
  const upgrade = await viaExecute(switchCalls(enableOf([P1])));
  const subject = ACCOUNT.toLowerCase();
  assert.deepEqual(await p.decide(op(upgrade, { nonce: "0" })), { proceed: false, reason: "no-intent", shape: "upgrade", subject });
  intents.add(subject);
  const paid = { proceed: true, shape: "upgrade", subject, via: "locked-upgrade" };
  assert.deepEqual(await p.decide(op(upgrade, { nonce: "0" })), paid, "stub");
  assert.equal(intents.has(subject), false, "the op spent the intent");
  assert.deepEqual(await p.decide(op(upgrade, { nonce: "0" })), paid, "final: rides on the counted op");
  assert.deepEqual(await p.decide(op(upgrade, { nonce: "0" })), paid, "a retry at the same nonce");
  assert.deepEqual(await p.decide(op(upgrade, { nonce: "1" })), { proceed: false, reason: "no-intent", shape: "upgrade", subject }, "a new op needs a new intent");
  intents.add(subject);
  assert.deepEqual(await p.decide(op(upgrade, { nonce: "1" })), paid, "after an op that landed and reverted, a fresh intent pays the retry");
  // Every other op of a locked account stays refused, the upgrade's neighbours included - intent or not.
  intents.add(subject);
  const locked = async (callData: Hex, shape: string) =>
    assert.deepEqual(await p.decide(op(callData, { nonce: "5" })), { proceed: false, reason: "locked", shape, subject }, shape);
  await locked(await viaExecute(switchCalls(enableOf([P1, P2]))), "co-owners");
  await locked(await viaExecute([renewCall([P1, P2])]), "renew");
  await locked(await viaExecute(buildRemoveRecoveryCalls(d, ACCOUNT)), "remove-route");
  assert.equal(intents.has(subject), true, "a refused op spends nothing");
});

test("upgrade: the paid count counts each locked upgrade op once, not each request; unlocked ones not at all", async () => {
  const p = new SponsorPolicy(deps);
  const upgrade = await viaExecute(switchCalls(enableOf([P1])));
  intents.add(ACCOUNT.toLowerCase());
  for (let i = 0; i < 3; i++) await p.decide(op(upgrade, { nonce: "0" })); // stub, final, retry
  assert.equal(p.lockedUpgradesPaid24h(), 1);
  await p.decide(op(upgrade, { nonce: "1" })); // no intent: refused, not counted
  assert.equal(p.lockedUpgradesPaid24h(), 1);
  unlocked.add(ACCOUNT.toLowerCase());
  await p.decide(op(upgrade, { nonce: "2" }));
  assert.equal(p.lockedUpgradesPaid24h(), 1, "an unlocked account's upgrade is not this exception");
});

test("upgrade: an unlocked account's upgrade is an ordinary paid op and spends no intent", async () => {
  unlocked.add(ACCOUNT.toLowerCase());
  intents.add(ACCOUNT.toLowerCase());
  const p = new SponsorPolicy(deps);
  const upgrade = await viaExecute(switchCalls(enableOf([P1])));
  assert.deepEqual(await p.decide(op(upgrade, { nonce: "0" })), {
    proceed: true, shape: "upgrade", subject: ACCOUNT.toLowerCase(), via: "ticket",
  });
  assert.equal(intents.has(ACCOUNT.toLowerCase()), true);
});

test("upgrade: the gate's kill-switch reads as locked - an intent's one op, never more", async () => {
  const p = new SponsorPolicy({ ...deps, gate: async () => ({ gated: true, via: "disabled" }) });
  intents.add(ACCOUNT.toLowerCase());
  const upgrade = await viaExecute(switchCalls(enableOf([P1])));
  assert.equal((await p.decide(op(upgrade, { nonce: "0" }))).via, "locked-upgrade");
  assert.equal((await p.decide(op(upgrade, { nonce: "1" }))).proceed, false);
  assert.equal((await p.decide(op(await viaExecute([renewCall([P1, P2])]), { nonce: "2" }))).proceed, false);
});

test("upgrade: no platform-wide cap - every locked account with an intent is paid for (owner 10-08)", async () => {
  const { coOwnerSwitchCalls } = await import("../../web/src/lib/auth/co-owner-calls.js");
  const enc = { encodeFunctionData, encodeAbiParameters, parseAbi, parseAbiParameters } as never;
  const p = new SponsorPolicy(deps);
  const sender = (i: number) => `0x${(0xa000 + i).toString(16).padStart(40, "0")}`;
  for (let i = 0; i < 50; i++) {
    intents.add(sender(i));
    const callData = await viaExecute(coOwnerSwitchCalls(enc, sender(i), [P1]).map((c) => ({ to: c.to as Address, data: c.data })));
    assert.equal((await p.decide(op(callData, { sender: sender(i), nonce: "0" }))).proceed, true, `account ${i}`);
  }
});

test("upgrade: the per-op gas ceiling and the per-account count still apply", async () => {
  intents.add(ACCOUNT.toLowerCase());
  const p = new SponsorPolicy(deps, 1_000n);
  const upgrade = await viaExecute(switchCalls(enableOf([P1])));
  assert.deepEqual(await p.decide(op(upgrade, { nonce: "0", maxCostWei: 1_001n })), {
    proceed: false, reason: "gas", shape: "upgrade", subject: ACCOUNT.toLowerCase(),
  });
  assert.equal((await p.decide(op(upgrade, { nonce: "0", maxCostWei: 1_000n }))).proceed, true);
});

// ── The intent store (lib/zerodev/upgrade-intents.ts) ────────────────────────

test("intents: one per grant, spent by its op, gone after its window; ten a day per network", async () => {
  const { UpgradeIntents, UPGRADE_INTENT_TTL_MS, UPGRADE_INTENTS_PER_IP } = await import("../src/lib/zerodev/upgrade-intents.js");
  const store = new UpgradeIntents();
  const t0 = 1_000_000;
  assert.equal(store.spend(ACCOUNT, t0), false, "none granted");
  assert.equal(store.grant(ACCOUNT, "1.2.3.4", t0), true);
  assert.equal(store.spend(ACCOUNT.toUpperCase().replace("0X", "0x"), t0), true, "keyed by the lowercased account");
  assert.equal(store.spend(ACCOUNT, t0), false, "spent: one op per intent");
  assert.equal(store.grant(ACCOUNT, "1.2.3.4", t0), true);
  assert.equal(store.spend(ACCOUNT, t0 + UPGRADE_INTENT_TTL_MS), false, "expired");
  assert.equal(store.grant(GUARDIAN_EOA, "1.2.3.4", t0), true);
  assert.equal(store.spend(GUARDIAN_EOA, t0 + UPGRADE_INTENT_TTL_MS - 1), true, "inside its window");
  assert.equal(UPGRADE_INTENTS_PER_IP, 10, "a household or a venue is not turned away");
  for (let i = 4; i <= UPGRADE_INTENTS_PER_IP; i++) {
    assert.equal(store.grant(`0x${i.toString(16).padStart(40, "0")}`, "1.2.3.4", t0), true, `grant ${i} today from this network`);
  }
  assert.equal(store.grant(NEW_OWNER, "1.2.3.4", t0), false, "one more refused");
  assert.equal(store.spend(NEW_OWNER, t0), false);
  assert.deepEqual(store.stats(t0), { granted24h: UPGRADE_INTENTS_PER_IP, refusedByNetwork24h: 1 }, "health sees both");
  assert.equal(store.grant(NEW_OWNER, "5.6.7.8", t0), true, "another network has its own share");
  assert.equal(store.grant(NEW_OWNER, "1.2.3.4", t0 + 24 * 60 * 60_000 + 1), true, "a day later");
  assert.deepEqual(store.stats(t0 + 2 * 24 * 60 * 60_000), { granted24h: 0, refusedByNetwork24h: 0 }, "the counts roll off");
});

test("intents: the route charges the caller's network and grants only the signed-in account", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/routes/upgrade-intent.ts", import.meta.url), "utf8");
  assert.match(src, /upgradeIntent\.post\("\/", jsonBodyLimit\(1024\), requireAuth,/);
  assert.match(src, /const ip = clientIp\(c\);\s*if \(!upgradeIntents\.grant\(account, ip\)\)/);
  assert.match(src, /const account = \(c\.get\("parentAddress"\) as string\)\.toLowerCase\(\);/, "the verified session's account, never a body field");
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(index, /app\.route\("\/api\/auth\/upgrade-intent", upgradeIntent\);/);
});

test("health reports the locked upgrades paid and what the per-network limit did - numbers, no threshold", async () => {
  const { zerodevPolicyHealth, _resetZerodevPolicyForTests } = await import("../src/routes/zerodev-policy.js");
  _resetZerodevPolicyForTests(deps);
  const h = zerodevPolicyHealth() as Record<string, unknown>;
  assert.equal(h.lockedUpgradesPaid24h, 0);
  assert.deepEqual(Object.keys(h.upgradeIntents as object).sort(), ["granted24h", "refusedByNetwork24h"]);
  assert.equal(h.ok, h.configured, "neither number turns the section red");
});

test("backups off (#186): an op that ADDS a backup is refused before any read; removing all of them is still paid", async () => {
  enableFeature("accountBackupsAllowed", false);
  try {
    const p = new SponsorPolicy(deps);
    unlocked.add(ACCOUNT.toLowerCase());
    for (const [callData, shape] of [
      [buildRegisterGuardianCallData(d, GUARDIAN_KERNEL), "install-route"],
      [await viaExecute([buildAddGuardianCall(encodeFunctionData, GUARDIAN_KERNEL)]), "guardians"],
    ] as const) {
      assert.deepEqual(await p.decide(op(callData)), { proceed: false, reason: "backups-off", shape, subject: ACCOUNT.toLowerCase() });
    }
    assert.deepEqual(gateCalls, [], "refused before the gate is read");
    const removal = await p.decide(op(await viaExecute(buildRemoveRecoveryCalls(d, ACCOUNT)), { nonce: "9" }));
    assert.equal(removal.proceed, true, "an upgrade to a passkey removes backups first");
  } finally {
    enableFeature("accountBackupsAllowed");
  }
});
