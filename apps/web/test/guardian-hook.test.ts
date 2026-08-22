/**
 * Semantics locks for the WoCo guardian hook client layer (#164).
 *
 * What these pin:
 *  - the calldata the account's `execute` sends to the hook — selector + args
 *    against the deployed contract's ABI (Arb Sepolia 0xF435…d4Db, verified);
 *  - `classifyRouteHook`, which every product branch keys on;
 *  - `decideAddPath`, where the two writes differ in SEMANTICS (install = replace
 *    the set, append = add to it) and where an unreadable chain must refuse rather
 *    than guess — guessing "install" against a WoCo-routed account would silently
 *    drop every other backup.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, encodeFunctionData, toFunctionSelector } from "viem";
import {
  LEGACY_ZERODEV_CALLER_HOOK,
  WOCO_GUARDIAN_HOOK,
  WOCO_GUARDIAN_HOOK_ABI,
  WOCO_GUARDIAN_HOOK_MAX_GUARDIANS,
  buildAddGuardianCall,
  buildClearGuardiansCall,
  buildRevokeGuardianCall,
  buildSetGuardiansCall,
  classifyRouteHook,
  decideAddPath,
} from "../src/lib/auth/guardian-hook.js";

const G1 = "0x1111111111111111111111111111111111111111" as const;
const G2 = "0x2222222222222222222222222222222222222222" as const;

test("the hook address is the deployed CREATE2 singleton and is not the legacy hook", () => {
  assert.equal(WOCO_GUARDIAN_HOOK.toLowerCase(), "0xf43524473ebc651969becc748462ed27ed39d4db");
  assert.notEqual(WOCO_GUARDIAN_HOOK.toLowerCase(), LEGACY_ZERODEV_CALLER_HOOK.toLowerCase());
});

test("hook calls target the hook, carry no value, and decode back to the intended function", () => {
  const add = buildAddGuardianCall(encodeFunctionData, G1);
  assert.equal(add.to, WOCO_GUARDIAN_HOOK);
  assert.equal(add.value, 0n);
  assert.deepEqual(decodeFunctionData({ abi: WOCO_GUARDIAN_HOOK_ABI, data: add.data }), {
    functionName: "addGuardian",
    args: [G1],
  });

  const revoke = buildRevokeGuardianCall(encodeFunctionData, G2);
  assert.equal(revoke.to, WOCO_GUARDIAN_HOOK);
  assert.deepEqual(decodeFunctionData({ abi: WOCO_GUARDIAN_HOOK_ABI, data: revoke.data }), {
    functionName: "revokeGuardian",
    args: [G2],
  });

  const set = buildSetGuardiansCall(encodeFunctionData, [G1, G2]);
  assert.deepEqual(decodeFunctionData({ abi: WOCO_GUARDIAN_HOOK_ABI, data: set.data }), {
    functionName: "setGuardians",
    args: [[G1, G2]],
  });

  const clear = buildClearGuardiansCall(encodeFunctionData);
  assert.deepEqual(decodeFunctionData({ abi: WOCO_GUARDIAN_HOOK_ABI, data: clear.data }), {
    functionName: "clearGuardians",
    args: undefined,
  });
});

test("selectors match the deployed contract's public surface", () => {
  // keccak of the canonical signatures — what the verified Solidity exposes.
  assert.equal(toFunctionSelector("addGuardian(address)"), buildAddGuardianCall(encodeFunctionData, G1).data.slice(0, 10));
  assert.equal(toFunctionSelector("revokeGuardian(address)"), buildRevokeGuardianCall(encodeFunctionData, G1).data.slice(0, 10));
  assert.equal(toFunctionSelector("setGuardians(address[])"), buildSetGuardiansCall(encodeFunctionData, [G1]).data.slice(0, 10));
  assert.equal(toFunctionSelector("clearGuardians()"), buildClearGuardiansCall(encodeFunctionData).data.slice(0, 10));
  // add/revoke must never converge on the same bytes for the same guardian.
  assert.notEqual(buildAddGuardianCall(encodeFunctionData, G1).data, buildRevokeGuardianCall(encodeFunctionData, G1).data);
});

test("classifyRouteHook recognises exactly the two hooks this app knows", () => {
  assert.equal(classifyRouteHook(undefined), "none");
  assert.equal(classifyRouteHook(null), "none");
  assert.equal(classifyRouteHook("0x0000000000000000000000000000000000000000"), "none");
  assert.equal(classifyRouteHook(WOCO_GUARDIAN_HOOK), "woco");
  assert.equal(classifyRouteHook(WOCO_GUARDIAN_HOOK.toLowerCase()), "woco");
  assert.equal(classifyRouteHook(LEGACY_ZERODEV_CALLER_HOOK.toUpperCase().replace("0X", "0x")), "legacy");
  assert.equal(classifyRouteHook(G1), "other");
});

test("decideAddPath: no route → install (fresh set, nothing replaced)", () => {
  assert.deepEqual(decideAddPath({ routeState: "absent", hookKind: "none", set: null, guardian: G1 }), {
    path: "install",
    replacesLegacy: false,
  });
});

test("decideAddPath: WoCo route with a readable set → APPEND, never install", () => {
  const r = decideAddPath({
    routeState: "installed",
    hookKind: "woco",
    set: { state: "read", guardians: [G2.toUpperCase().replace("0X", "0x")] },
    guardian: G1,
  });
  assert.deepEqual(r, { path: "append", currentGuardians: [G2] });
});

test("decideAddPath: WoCo route whose set cannot be read → REFUSE (an install would replace the set)", () => {
  const unknown = decideAddPath({ routeState: "installed", hookKind: "woco", set: { state: "unknown" }, guardian: G1 });
  assert.equal(unknown.path, "refuse");
  const missing = decideAddPath({ routeState: "installed", hookKind: "woco", set: null, guardian: G1 });
  assert.equal(missing.path, "refuse");
});

test("decideAddPath: an unreadable route refuses — it cannot tell replace from append", () => {
  const r = decideAddPath({ routeState: "unknown", hookKind: "none", set: null, guardian: G1 });
  assert.equal(r.path, "refuse");
});

test("decideAddPath: already a guardian, or at the cap → refuse with a reason", () => {
  const dup = decideAddPath({
    routeState: "installed", hookKind: "woco", set: { state: "read", guardians: [G1.toLowerCase()] }, guardian: G1,
  });
  assert.equal(dup.path, "refuse");
  assert.match((dup as { reason: string }).reason, /already/);

  const full = Array.from({ length: WOCO_GUARDIAN_HOOK_MAX_GUARDIANS }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);
  const capped = decideAddPath({ routeState: "installed", hookKind: "woco", set: { state: "read", guardians: full }, guardian: G1 });
  assert.equal(capped.path, "refuse");
  assert.match((capped as { reason: string }).reason, /maximum/);
});

test("decideAddPath: a legacy route is REPLACED on purpose, and says so", () => {
  assert.deepEqual(decideAddPath({ routeState: "installed", hookKind: "legacy", set: null, guardian: G1 }), {
    path: "install",
    replacesLegacy: true,
  });
});

test("decideAddPath: a hook this app did not install is never written over", () => {
  const r = decideAddPath({ routeState: "installed", hookKind: "other", set: null, guardian: G1 });
  assert.equal(r.path, "refuse");
});
