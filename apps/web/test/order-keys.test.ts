/**
 * Orders across key generations (#186): sealed to the current key, opened with
 * whichever generation's key sealed them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { bytesToHex } from "@noble/hashes/utils.js";
import { sealBoxJson, orderSealContext } from "@woco/shared/crypto/sealed-box";
import { newAccountSecret } from "@woco/shared/keyring/account-secret";
import { orderKeysOf, openJsonWithAnyKey } from "../src/lib/keyring/order-keys.ts";

const hex = (b: Uint8Array) => `0x${bytesToHex(b)}`;
const S0 = hex(newAccountSecret());
const S1 = hex(newAccountSecret());
const CTX = orderSealContext("ev-1", "se-1");

test("new boxes seal to the current generation; every held generation opens its own", async () => {
  const before = await orderKeysOf({ current: S0, all: [S0] });
  const after = await orderKeysOf({ current: S1, all: [S0, S1] });
  assert.notEqual(bytesToHex(after.publicKey), bytesToHex(before.publicKey));
  const old = await sealBoxJson(before.publicKey, { n: "old" }, CTX);
  const fresh = await sealBoxJson(after.publicKey, { n: "new" }, CTX);
  assert.deepEqual(await openJsonWithAnyKey(after.secretKeys, old, CTX), { n: "old" });
  assert.deepEqual(await openJsonWithAnyKey(after.secretKeys, fresh, CTX), { n: "new" });
  // A device that never had generation 1 cannot open what was sealed to it.
  await assert.rejects(openJsonWithAnyKey(before.secretKeys, fresh, CTX));
});

test("a box in a format no key reads fails once, not per key", async () => {
  const keys = await orderKeysOf({ current: S1, all: [S0, S1] });
  await assert.rejects(openJsonWithAnyKey(keys.secretKeys, { v: 1, ciphertext: "00" }, CTX), (e: unknown) => e instanceof Error && e.name === "UnsupportedSealedBoxError");
});
