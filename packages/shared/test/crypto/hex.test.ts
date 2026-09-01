/**
 * crypto/hex — relocated from `pod/canonical.ts` when the v1 module was
 * deleted (PR 5a). These cases carry over the coverage the deleted
 * `test/pod/canonical.test.ts` held for the helpers: every digest on both
 * rails travels through them, so a quiet regression here mislabels every
 * manifestRef at once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { bytesToHex0x, hex0xToBytes } from "../../src/crypto/hex.js";

test("hex: round-trip random 32 bytes", () => {
  for (let i = 0; i < 16; i++) {
    const bytes = new Uint8Array(randomBytes(32));
    const hex = bytesToHex0x(bytes);
    assert.match(hex, /^0x[0-9a-f]{64}$/);
    assert.deepEqual(hex0xToBytes(hex), bytes);
  }
});

test("hex: empty input round-trips", () => {
  assert.equal(bytesToHex0x(new Uint8Array(0)), "0x");
  assert.deepEqual(hex0xToBytes("0x"), new Uint8Array(0));
});

test("hex: rejects odd-length input", () => {
  assert.throws(() => hex0xToBytes("0xabc"), /odd-length/);
});

test("hex: rejects non-hex characters", () => {
  assert.throws(() => hex0xToBytes("0xzz"), /bad hex char/);
});

test("hex: accepts upper-case 0X prefix", () => {
  assert.deepEqual(hex0xToBytes("0Xab"), new Uint8Array([0xab]));
});

test("hex: emits lowercase, always", () => {
  assert.equal(bytesToHex0x(new Uint8Array([0xde, 0xad, 0xbe, 0xef])), "0xdeadbeef");
});
