/** The curve-free scalar map (crypto/secp-scalar.ts) the passkey window uses. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { SECP256K1_N } from "../../src/crypto/secp-scalar.js";
import { scalarFromOkm48 } from "../../src/crypto/secp-hkdf.js";

test("the literal curve order is secp256k1's", () => {
  assert.equal(SECP256K1_N, secp256k1.Point.Fn.ORDER);
});

test("secp-hkdf still hands out the same scalar map", () => {
  assert.equal(scalarFromOkm48(new Uint8Array(48)), 1n);
  assert.equal(scalarFromOkm48(new Uint8Array(48).fill(0xff)), ((1n << 384n) - 1n) % (SECP256K1_N - 1n) + 1n);
});
