import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ECDSA_ROOT_ID,
  ECDSA_VALIDATOR_V3_1,
  MAX_CO_OWNERS,
  WEIGHTED_ECDSA_VALIDATOR_V3_1,
  WEIGHTED_ROOT_ID,
  isValidCoOwnerList,
  sortCoOwners,
} from "../../src/kernel/co-owners.js";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

test("the root ids are type 0x01 followed by the validator addresses", () => {
  assert.equal(ECDSA_ROOT_ID, `0x01${ECDSA_VALIDATOR_V3_1.slice(2).toLowerCase()}`);
  assert.equal(WEIGHTED_ROOT_ID, `0x01${WEIGHTED_ECDSA_VALIDATOR_V3_1.slice(2).toLowerCase()}`);
});

test("a list the account may hold: 1..10 distinct real addresses", () => {
  assert.equal(isValidCoOwnerList([addr(1)]), true);
  assert.equal(isValidCoOwnerList(Array.from({ length: MAX_CO_OWNERS }, (_, i) => addr(i + 1))), true);
  assert.equal(isValidCoOwnerList([]), false, "empty locks the account");
  assert.equal(isValidCoOwnerList(Array.from({ length: MAX_CO_OWNERS + 1 }, (_, i) => addr(i + 1))), false);
  assert.equal(isValidCoOwnerList([addr(1), addr(1).toUpperCase().replace("0X", "0x")]), false, "same key, any case");
  assert.equal(isValidCoOwnerList([addr(0)]), false, "zero address");
  assert.equal(isValidCoOwnerList([`0x${"f".repeat(40)}`]), false, "the validator's list sentinel");
  assert.equal(isValidCoOwnerList(["0x1234"]), false, "not an address");
});

test("signers sort as the ZeroDev plugin writes them: lowercase, descending", () => {
  assert.deepEqual(sortCoOwners([addr(1), addr(3).toUpperCase().replace("0X", "0x"), addr(2)]), [addr(3), addr(2), addr(1)]);
});
