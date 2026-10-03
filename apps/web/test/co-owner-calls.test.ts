/**
 * The calls that make every passkey a co-owner (#746) and the list arithmetic
 * around them. The bytes themselves are classified by the server's sponsorship
 * policy in apps/server/test/zerodev-policy.test.ts ("the app's own co-owner builders").
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, decodeAbiParameters } from "viem";
import { MAX_CO_OWNERS, WEIGHTED_ROOT_ID, ECDSA_ROOT_ID, CHANGE_ROOT_VALIDATOR_FN, UNINSTALL_VALIDATION_FN, WEIGHTED_RENEW_FN } from "@woco/shared/kernel/co-owners";
import {
  coOwnerRenewCall,
  coOwnerSwitchCalls,
  listWith,
  listWithout,
  LAST_PASSKEY_MESSAGE,
  TOO_MANY_PASSKEYS_MESSAGE,
  type CoOwnerEncoders,
} from "../src/lib/auth/co-owner-calls.js";

const d = { encodeFunctionData, encodeAbiParameters, parseAbi, parseAbiParameters } as unknown as CoOwnerEncoders;
const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const KERNEL = "0x1111111111111111111111111111111111111111";

test("adding: deduplicated, lowercase, in the validator's order; never past ten", () => {
  assert.deepEqual(listWith([a(1)], a(2)), [a(2), a(1)]);
  assert.deepEqual(listWith([a(1), a(2)], a(2).toUpperCase().replace("0X", "0x")), [a(2), a(1)], "already listed");
  const ten = Array.from({ length: MAX_CO_OWNERS }, (_, i) => a(i + 1));
  assert.throws(() => listWith(ten, a(99)), { message: TOO_MANY_PASSKEYS_MESSAGE });
});

test("removing: never the last passkey", () => {
  assert.deepEqual(listWithout([a(1), a(2)], a(1)), [a(2)]);
  assert.throws(() => listWithout([a(1)], a(1)), { message: LAST_PASSKEY_MESSAGE });
});

test("the switch is changeRootValidator(weighted, no hook, list) then uninstallValidation(ECDSA), on the account", () => {
  const [change, drop] = coOwnerSwitchCalls(d, KERNEL, [a(1), a(2)]);
  const abi = parseAbi([CHANGE_ROOT_VALIDATOR_FN, UNINSTALL_VALIDATION_FN]);
  assert.equal(change.to, KERNEL);
  assert.equal(drop.to, KERNEL);
  const c = decodeFunctionData({ abi, data: change.data });
  assert.equal(c.functionName, "changeRootValidator");
  const [root, hook, enable, hookData] = c.args as [string, string, `0x${string}`, string];
  assert.equal(root.toLowerCase(), WEIGHTED_ROOT_ID);
  assert.equal(hook, "0x0000000000000000000000000000000000000000");
  assert.equal(hookData, "0x");
  assert.deepEqual(decodeAbiParameters(parseAbiParameters("address[], uint24[], uint24, uint48"), enable).map((v) => (Array.isArray(v) ? v.map(String).map((x) => x.toLowerCase()) : String(v))), [[a(2), a(1)], ["1", "1"], "1", "0"]);
  const u = decodeFunctionData({ abi, data: drop.data });
  assert.equal(u.functionName, "uninstallValidation");
  assert.equal((u.args[0] as string).toLowerCase(), ECDSA_ROOT_ID);
});

test("renew carries the whole list, weight 1, threshold 1, no delay; an empty list is never built", () => {
  const call = coOwnerRenewCall(d, [a(3), a(1)]);
  const r = decodeFunctionData({ abi: parseAbi([WEIGHTED_RENEW_FN]), data: call.data });
  assert.deepEqual((r.args[0] as string[]).map((x) => x.toLowerCase()), [a(3), a(1)]);
  assert.deepEqual([...(r.args[1] as readonly number[])], [1, 1]);
  assert.equal(r.args[2], 1);
  assert.equal(Number(r.args[3]), 0);
  assert.throws(() => coOwnerRenewCall(d, []));
  assert.throws(() => coOwnerSwitchCalls(d, KERNEL, []));
});
