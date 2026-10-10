/**
 * Frozen vectors and the closed schema for woco.lap-diary.v1.
 *
 * Entries are write-once at addresses derived here, so a change to the salt
 * label or the topic recipe does not break a build — it silently orphans every
 * time a rider has ever saved. The hardcoded strings below are the spec.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  LAP_DIARY_FORMAT,
  LAP_DIARY_MAX_TIMES,
  buildLapDiaryEntry,
  lapDiaryEntryTopic,
  lapDiaryPrivateSalt,
  validateLapDiaryEntryV1,
  type LapDiaryEntryV1,
} from "../../src/credit/lap-diary.js";
import { creditPrivateSalt, creditStatementTopic } from "../../src/credit/types.js";
import type { Hex0x } from "../../src/types.js";

const KEY = new Uint8Array(32).fill(7);
const SUBJECT = `0x${"11".repeat(32)}` as Hex0x;

function entry(over: Partial<LapDiaryEntryV1> = {}): LapDiaryEntryV1 {
  return {
    format: LAP_DIARY_FORMAT,
    subject: SUBJECT,
    seq: 4,
    total: 9,
    times: [1790000000000, 1790000185000],
    ...over,
  };
}

test("frozen salt and topic vectors", () => {
  const salt = lapDiaryPrivateSalt(KEY);
  assert.equal(bytesToHex(salt), "425438efbf14b7992f8f60a51c8b2e403da27fa2cac320df12d95cef19c654c8");
  assert.equal(
    lapDiaryEntryTopic(salt, SUBJECT, 0),
    "woco/lap-diary/v1/ecfeca16d5d3250627b7f268e10ffef1e3e6600851886ad4cd224a351bf57516",
  );
  assert.equal(
    lapDiaryEntryTopic(salt, SUBJECT, 57),
    "woco/lap-diary/v1/60e076de4c3dbbfd86b7662195505b183b498c46512683db055737c3001eec19",
  );
});

test("the diary salt is not the logbook salt, and neither are its topics", () => {
  // A disclosed diary topic must not locate the rider's private logbook.
  const diary = lapDiaryPrivateSalt(KEY);
  const logbook = creditPrivateSalt(KEY);
  assert.notEqual(bytesToHex(diary), bytesToHex(logbook));
  assert.notEqual(lapDiaryEntryTopic(diary, SUBJECT, 0), creditStatementTopic(logbook, SUBJECT, 0));
});

test("every seq has its own address", () => {
  const salt = lapDiaryPrivateSalt(KEY);
  const topics = new Set(Array.from({ length: 200 }, (_, seq) => lapDiaryEntryTopic(salt, SUBJECT, seq)));
  assert.equal(topics.size, 200);
});

test("a well-formed entry validates", () => {
  assert.equal(validateLapDiaryEntryV1(entry()), true);
  assert.equal(validateLapDiaryEntryV1(entry({ times: [1790000000000], total: 1, seq: 0 })), true);
});

test("the schema is closed: an unknown field is rejected, not ignored", () => {
  assert.equal(validateLapDiaryEntryV1({ ...entry(), note: "x" }), false);
  const { total: _t, ...missing } = entry();
  assert.equal(validateLapDiaryEntryV1(missing), false);
});

test("a different format id does not validate", () => {
  assert.equal(validateLapDiaryEntryV1({ ...entry(), format: "woco.lap-diary.v2" }), false);
  assert.equal(validateLapDiaryEntryV1({ ...entry(), format: "woco.credit.v1" }), false);
});

test("times must be whole, positive, ascending and bounded", () => {
  assert.equal(validateLapDiaryEntryV1(entry({ times: [] })), false);
  assert.equal(validateLapDiaryEntryV1(entry({ times: [1790000000000.5] })), false);
  assert.equal(validateLapDiaryEntryV1(entry({ times: [0] })), false);
  assert.equal(validateLapDiaryEntryV1(entry({ times: [1790000185000, 1790000000000] })), false);
  assert.equal(validateLapDiaryEntryV1(entry({ times: ["1790000000000" as unknown as number] })), false);
  const tooMany = Array.from({ length: LAP_DIARY_MAX_TIMES + 1 }, (_, i) => 1790000000000 + i);
  assert.equal(validateLapDiaryEntryV1(entry({ times: tooMany, total: tooMany.length })), false);
  // Two taps inside the same millisecond are equal, not descending.
  assert.equal(validateLapDiaryEntryV1(entry({ times: [1790000000000, 1790000000000] })), true);
});

test("an entry cannot carry more times than the statement's lifetime total", () => {
  assert.equal(validateLapDiaryEntryV1(entry({ total: 1 })), false);
});

test("subject and seq are shape-checked", () => {
  assert.equal(validateLapDiaryEntryV1(entry({ subject: "0xABC" as Hex0x })), false);
  assert.equal(validateLapDiaryEntryV1(entry({ seq: -1 })), false);
  assert.equal(validateLapDiaryEntryV1(entry({ seq: 1.5 })), false);
});

test("building sorts, so a clock that stepped backwards cannot strand the times", () => {
  const built = buildLapDiaryEntry({ subject: SUBJECT, seq: 4, total: 9, times: [1790000185000, 1790000000000] });
  assert.deepEqual(built.times, [1790000000000, 1790000185000]);
  assert.equal(validateLapDiaryEntryV1(built), true);
});

test("building refuses what the validator would refuse", () => {
  assert.throws(() => buildLapDiaryEntry({ subject: SUBJECT, seq: 4, total: 9, times: [] }));
  assert.throws(() => buildLapDiaryEntry({ subject: SUBJECT, seq: 4, total: 1, times: [1, 2] }));
});

test("an entry survives the JSON round trip it travels in", () => {
  const e = entry();
  assert.deepEqual(JSON.parse(JSON.stringify(e)), e);
});
