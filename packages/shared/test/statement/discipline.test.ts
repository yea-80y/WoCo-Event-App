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
    statementTopic("credit", 1, publicTopicSalt("credit", 1), subjectToBytes(SUBJECT), 0),
    "woco/credit/v1/66676f11af1c0953737f4cd1cd3b1a8a8e4d607fa57ed89ee83f2de4f23dc6d3",
  );
  assert.equal(
    statementTopic("credit", 1, privateTopicSalt(ENC_KEY, "credit", 1), subjectToBytes(SUBJECT), 0),
    "woco/credit/v1/6c839fc1a31f13e3e50eff5e75773708f294f0ae57c4deb4bc47bc2baac86702",
  );
  assert.equal(
    subjectIndexTopic("credit", 1, publicTopicSalt("credit", 1), 0),
    "woco/credit/v1/index/89952d0108f729f726a4c327b475b8fdec3c3d37de1128c22d11c24017ea1566",
  );
});

test("the band changes the address, and band 0 is not the pre-banding topic", () => {
  const salt = publicTopicSalt("credit", 1);
  const b0 = statementTopic("credit", 1, salt, subjectToBytes(SUBJECT), 0);
  const b1 = statementTopic("credit", 1, salt, subjectToBytes(SUBJECT), 1);
  assert.equal(b1, "woco/credit/v1/e0764efcab3a027c4ca119611d399fad5011cb8dccd2ec4ac8ba84fce54bc2c9");
  assert.notEqual(b0, b1);

  // The pre-banding scheme hashed the bare 32 subject bytes. The banded message
  // is 40 bytes, so no banded address can collide with one written before this
  // change — the disjointness the freeze record claims, asserted rather than argued.
  assert.notEqual(b0, "woco/credit/v1/79449ed07f4336c65c19fb6ef2aeab1e0f3d638cbc2e2eb36821b4a80d76748d");

  // Same for the index.
  assert.notEqual(
    subjectIndexTopic("credit", 1, salt, 0),
    subjectIndexTopic("credit", 1, salt, 1),
  );
  assert.equal(
    subjectIndexTopic("credit", 1, salt, 1),
    "woco/credit/v1/index/94ffa69fea2136c60fd9bf785fdd3f122eb9a760f56c9c9dd46d83a55e7e2d87",
  );
});

test("band must be a non-negative safe integer", () => {
  const salt = publicTopicSalt("credit", 1);
  const subj = subjectToBytes(SUBJECT);
  for (const bad of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 2]) {
    assert.throws(() => statementTopic("credit", 1, salt, subj, bad), /invalid band/);
    assert.throws(() => subjectIndexTopic("credit", 1, salt, bad), /invalid band/);
  }
});

test("the topic functions stay TYPE-GENERIC (Gate B depends on this)", () => {
  // The emblem rail rides these same functions with type "emblem". If either
  // ever hard-codes a type or version, that rail has to be rebuilt rather than
  // reused — see SWARM_SOCIAL_PLAN.md "Gate B is the EMBLEM rail".
  const salt = publicTopicSalt("emblem", 1);
  assert.match(statementTopic("emblem", 1, salt, subjectToBytes(SUBJECT), 0), /^woco\/emblem\/v1\/[0-9a-f]{64}$/);
  assert.match(subjectIndexTopic("emblem", 2, salt, 3), /^woco\/emblem\/v2\/index\/[0-9a-f]{64}$/);
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
