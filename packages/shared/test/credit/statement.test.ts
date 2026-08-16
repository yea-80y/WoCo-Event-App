/**
 * Frozen-vector tests for woco.credit.v1. The hardcoded digest and signature
 * are the spec — see the note in test/statement/discipline.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  creditStatementDigest,
  creditSubject,
  signCreditStatement,
  validateCreditStatementV1,
  verifyCreditStatement,
  type UnsignedCreditStatementV1,
} from "../../src/credit/types.js";

const PRIV = new Uint8Array(32).fill(1);
const HOLDER = bytesToHex(ed25519.getPublicKey(PRIV));

function unsigned(): UnsignedCreditStatementV1 {
  return {
    format: "woco.credit.v1",
    subject: creditSubject("01J4TESTULID00000000000000"),
    holder: HOLDER,
    seq: 3,
    total: 12,
    session: { date: "2026-08-14", count: 2 },
  };
}

test("frozen subject and digest vectors", () => {
  assert.equal(
    creditSubject("01J4TESTULID00000000000000"),
    "0x3da9abaddbeee72a4bcb9de6930b557c1310b2d6d8d64e704309274d1af34147",
  );
  assert.equal(
    bytesToHex(creditStatementDigest(unsigned())),
    "3c74087741b3736b97c8b270c616b9479979adb670ee9cbb8e1cd3426f68b534",
  );
});

test("sign → verify roundtrip, plus the frozen signature vector", () => {
  const signed = signCreditStatement(unsigned(), PRIV);
  assert.equal(
    signed.holderSig,
    "7fd87413b27cd16158840c99155648dacdcc2955f22567db1c9117a5a0bd4cb8ff3fc7222e45f97c705520bcfe8b10a9a9d0168f7edf694b19acfa33cd61c000",
  );
  assert.equal(verifyCreditStatement(signed), true);
});

test("JSON wire round-trip preserves the digest (closure 7)", () => {
  const signed = signCreditStatement(unsigned(), PRIV);
  const roundTripped: unknown = JSON.parse(JSON.stringify(signed));
  assert.equal(verifyCreditStatement(roundTripped), true);
});

test("signing refuses a holder mismatch", () => {
  const other = new Uint8Array(32).fill(2);
  assert.throws(() => signCreditStatement(unsigned(), other));
});

test("closed schema: unknown fields, null, floats, wrong format all rejected", () => {
  const signed = signCreditStatement(unsigned(), PRIV);
  assert.equal(validateCreditStatementV1({ ...signed, extra: 1 }), false);
  assert.equal(validateCreditStatementV1({ ...signed, session: { ...signed.session, gps: "x" } }), false);
  assert.equal(validateCreditStatementV1({ ...signed, session: { ...signed.session, exitTokens: null } }), false);
  assert.equal(validateCreditStatementV1({ ...signed, seq: 1.5 }), false);
  assert.equal(validateCreditStatementV1({ ...signed, format: "woco.credit.v2" }), false);
  assert.equal(validateCreditStatementV1(signed), true);
});

test("exit tokens: opaque format-tagged strings only", () => {
  const withTokens = signCreditStatement(
    { ...unsigned(), session: { date: "2026-08-14", count: 2, exitTokens: ["woco.exit-token.v1:abc_-123"] } },
    PRIV,
  );
  assert.equal(verifyCreditStatement(withTokens), true);
  // padding, spaces and non-base64url payloads are all outside the frozen shape
  assert.equal(
    validateCreditStatementV1({ ...withTokens, session: { ...withTokens.session, exitTokens: ["woco.exit-token.v1:a=="] } }),
    false,
  );
  assert.equal(
    validateCreditStatementV1({ ...withTokens, session: { ...withTokens.session, exitTokens: ["no-colon"] } }),
    false,
  );
});

test("tampering any signed field breaks verification", () => {
  const signed = signCreditStatement(unsigned(), PRIV);
  assert.equal(verifyCreditStatement({ ...signed, total: 13 }), false);
  assert.equal(verifyCreditStatement({ ...signed, seq: 4 }), false);
  assert.equal(verifyCreditStatement({ ...signed, session: { date: "2026-08-15", count: 2 } }), false);
});
