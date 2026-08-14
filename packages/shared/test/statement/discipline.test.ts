/**
 * Frozen-vector tests for the statement discipline. The hardcoded values ARE
 * the spec: if any of them changes, the derivation changed, and statements
 * already written at computed addresses are orphaned. Fix the code, never the
 * vector — a deliberate change is a NEW type/version.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import {
  compareStatementDigests,
  isJsonSafeStatementValue,
  privateTopicSalt,
  publicTopicSalt,
  statementSigningPrefix,
  statementTopic,
  subjectIndexTopic,
  subjectToBytes,
  validateSubjectIndexV1,
} from "../../src/statement/discipline.js";

const SUBJECT = "0x3da9abaddbeee72a4bcb9de6930b557c1310b2d6d8d64e704309274d1af34147" as const;
const ENC_KEY = new Uint8Array(32).fill(7);

test("signing prefix shape and type-name charset", () => {
  assert.equal(statementSigningPrefix("credit", 1), "woco-credit-v1\n");
  assert.throws(() => statementSigningPrefix("Credit", 1));
  assert.throws(() => statementSigningPrefix("a\nb", 1));
  assert.throws(() => statementSigningPrefix("credit", 0));
});

test("public salt is the documented constant", () => {
  assert.deepEqual(publicTopicSalt("credit", 1), utf8ToBytes("woco-credit-public-v1"));
});

test("frozen topic vectors", () => {
  assert.equal(
    bytesToHex(privateTopicSalt(ENC_KEY, "credit", 1)),
    "dfc1bf2985670003ff15c5fc72c4b9ef98201b9326b41e7a2f8511726db53def",
  );
  assert.equal(
    statementTopic("credit", 1, publicTopicSalt("credit", 1), subjectToBytes(SUBJECT)),
    "woco/credit/v1/79449ed07f4336c65c19fb6ef2aeab1e0f3d638cbc2e2eb36821b4a80d76748d",
  );
  assert.equal(
    statementTopic("credit", 1, privateTopicSalt(ENC_KEY, "credit", 1), subjectToBytes(SUBJECT)),
    "woco/credit/v1/59172ddd922843dae0efa079c2e3767db0fdbf767acfcb9c2df8122d3e2f3579",
  );
  assert.equal(
    subjectIndexTopic("credit", 1, publicTopicSalt("credit", 1)),
    "woco/credit/v1/index/510ba40edd51770b997c532ed8dbbfe54ebd7e801d65619159efaf616fc3ec51",
  );
});

test("subjectToBytes rejects non-canonical subjects", () => {
  assert.throws(() => subjectToBytes(SUBJECT.toUpperCase() as never)); // uppercase
  assert.throws(() => subjectToBytes("0x1234" as never)); // short
  assert.throws(() => subjectToBytes(SUBJECT.slice(2) as never)); // no 0x
});

test("JSON-safe wire form: integers only, no null, no floats, plain objects", () => {
  assert.equal(isJsonSafeStatementValue({ a: 1, b: "x", c: [true] }), true);
  assert.equal(isJsonSafeStatementValue(1.5), false);
  assert.equal(isJsonSafeStatementValue(null), false);
  assert.equal(isJsonSafeStatementValue({ a: undefined }), false);
  assert.equal(isJsonSafeStatementValue(Number.MAX_SAFE_INTEGER + 1), false);
  assert.equal(isJsonSafeStatementValue(new Uint8Array(2)), false); // byte strings don't survive JSON
});

test("tie-break: lower digest wins, lexicographic over 32 raw bytes", () => {
  const lo = new Uint8Array(32);
  const hi = new Uint8Array(32);
  hi[31] = 1;
  assert.equal(compareStatementDigests(lo, hi), -1);
  assert.equal(compareStatementDigests(hi, lo), 1);
  assert.equal(compareStatementDigests(lo, new Uint8Array(32)), 0);
  assert.throws(() => compareStatementDigests(new Uint8Array(31), hi));
});

test("subject index: closed schema", () => {
  const good = { format: "woco.credit-index.v1", subjects: [SUBJECT] };
  assert.equal(validateSubjectIndexV1(good, "woco.credit-index.v1"), true);
  assert.equal(validateSubjectIndexV1({ ...good, extra: 1 }, "woco.credit-index.v1"), false);
  assert.equal(validateSubjectIndexV1({ format: "woco.credit-index.v2", subjects: [] }, "woco.credit-index.v1"), false);
  assert.equal(validateSubjectIndexV1({ format: "woco.credit-index.v1", subjects: ["nope"] }, "woco.credit-index.v1"), false);
});
