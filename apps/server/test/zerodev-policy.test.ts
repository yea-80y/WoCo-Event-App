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
  assert.deepEqual(v07, { sender: ACCOUNT.toLowerCase(), nonce: "31", callData, factory: null });
  const meta = KernelVersionToAddressesMap[KERNEL_V3_1].metaFactoryAddress!;
  const v06 = readUserOp({ sender: ACCOUNT, nonce: 5, callData, initCode: `${meta}abcdef` });
  assert.equal(v06?.factory, meta.toLowerCase());
  assert.equal(readUserOp({ sender: "0x12", nonce: "1", callData }), null);
  assert.equal(readUserOp({ sender: ACCOUNT, nonce: "x", callData }), null);
  assert.equal(readUserOp({ sender: ACCOUNT, nonce: "1", callData: "0x12" }), null);
  assert.equal(readUserOp(null), null);
});

// ── WHO and HOW MUCH ─────────────────────────────────────────────────────────

let unlocked: Set<string>;
let guardians: Map<string, boolean | null>;
let gateCalls: string[];
const deps: PolicyDeps = {
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
  assert.deepEqual((await post(SECRET, body)).json, { proceed: true, logicalOperator: "and" });
  assert.equal(zerodevPolicyHealth().allowed, 1);
  assert.equal(zerodevPolicyHealth().lastRefusal?.reason, "userop");
});
