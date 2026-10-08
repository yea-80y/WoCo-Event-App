/**
 * The one byte form a signature is hashed in (#186). Canonical input must pass
 * through untouched - the identity seed of every existing account hangs off
 * those bytes - and every other encoding of the same signature must land on it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalSignatureBytes } from "../../src/auth/canonical-signature.js";
import { eip712DigestHex } from "../../src/auth/eip712-digest.js";
import { bytesToHex0x } from "../../src/crypto/hex.js";

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const hex32 = (n: bigint) => n.toString(16).padStart(64, "0");
const R = "ab".repeat(32);
const LOW_S = 0x1234n;
const canon = (v: 27 | 28) => "0x" + R + hex32(LOW_S) + v.toString(16);
const out = (sig: string) => bytesToHex0x(canonicalSignatureBytes(sig));

test("a canonical signature passes through byte for byte", () => {
  assert.equal(out(canon(27)), canon(27));
  assert.equal(out(canon(28)), canon(28));
});

test("v 0/1 is v 27/28", () => {
  assert.equal(out("0x" + R + hex32(LOW_S) + "00"), canon(27));
  assert.equal(out("0x" + R + hex32(LOW_S) + "01"), canon(28));
});

test("a high s is the low s with the other parity", () => {
  assert.equal(out("0x" + R + hex32(N - LOW_S) + "1c"), canon(27));
  assert.equal(out("0x" + R + hex32(N - LOW_S) + "1b"), canon(28));
  assert.equal(out("0x" + R + hex32(N - LOW_S) + "00"), canon(28));
});

test("the 64-byte compact form (EIP-2098) is the 65-byte form", () => {
  assert.equal(out("0x" + R + hex32(LOW_S)), canon(27));
  assert.equal(out("0x" + R + hex32(LOW_S | (1n << 255n))), canon(28));
});

test("s exactly at half the order is already low", () => {
  const half = N / 2n;
  assert.equal(out("0x" + R + hex32(half) + "1b"), "0x" + R + hex32(half) + "1b");
  assert.equal(out("0x" + R + hex32(half + 1n) + "1b"), "0x" + R + hex32(N - half - 1n) + "1c");
});

test("what is not a signature is refused, never hashed", () => {
  assert.throws(() => out("0x" + R + hex32(LOW_S) + "02"), /unexpected v/);
  assert.throws(() => out("0x" + R + hex32(LOW_S) + "1d"), /unexpected v/);
  assert.throws(() => out("0x" + R + hex32(LOW_S) + "1b00"), /expected 64 or 65 bytes/);
  assert.throws(() => out("0x" + R + hex32(0n) + "1b"), /out of range/);
  assert.throws(() => out("0x" + R + hex32(N) + "1b"), /out of range/);
  assert.throws(() => out("0x" + "00".repeat(32) + hex32(LOW_S) + "1b"), /out of range/);
  assert.throws(() => out("0x" + "zz".repeat(65)), /bad hex/);
});

test("eip712-digest refuses malformed hex instead of hashing it as zero bytes", () => {
  const domain = { name: "x", version: "1" };
  const fields = [{ name: "a", type: "address" }];
  const zero = "0x" + "00".repeat(20);
  assert.match(eip712DigestHex(domain, "M", fields, { a: zero }), /^0x[0-9a-f]{64}$/);
  assert.throws(() => eip712DigestHex(domain, "M", fields, { a: "0x" + "zz" + "00".repeat(19) }), /invalid hex/);
  assert.throws(
    () => eip712DigestHex({ ...domain, salt: "0x" + "g0".repeat(32) }, "M", fields, { a: zero }),
    /invalid hex/,
  );
});
