/**
 * Frozen-vector tests for woco.like.v1 / woco.follow.v1 — see the note in
 * test/statement/discipline.test.ts: vectors are the spec.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  followStatementTopic,
  likeStatementTopic,
  likeSubjectIndexTopic,
  validateFollowStatementV1,
  validateLikeStatementV1,
} from "../../src/social/types.js";

const SUBJECT = "0x3da9abaddbeee72a4bcb9de6930b557c1310b2d6d8d64e704309274d1af34147" as const;

test("frozen topic vectors — like and follow partition under their own public salts", () => {
  assert.equal(
    likeStatementTopic(SUBJECT),
    "woco/like/v1/5a276b97da373fea6b78e2a95a93016457dafdfbc3b19418522de95635c3c8e6",
  );
  assert.equal(
    likeSubjectIndexTopic(0),
    "woco/like/v1/index/0320164dfe125ecd7c4897cc2e5128e0a458d20a3b2207ed4c58a2179226fc1b",
  );
  assert.equal(
    followStatementTopic(SUBJECT),
    "woco/follow/v1/5b00ad8a9da0d1be84fde5a0b42a734492b76877a45b5fb16a5e1c0ebaea78dd",
  );
  // Same subject, different type → different address. The type segment AND the
  // salt both partition; a like can never land on a follow topic.
  assert.notEqual(likeStatementTopic(SUBJECT), followStatementTopic(SUBJECT));

  // The INDEX is banded because it grows — one version per new subject, and
  // subjects are never removed. The statement feeds are not: a like is
  // latest-wins, so they gain a version per toggle and never leave band 0.
  assert.equal(
    likeSubjectIndexTopic(1),
    "woco/like/v1/index/823318ce084a30f0666b5fbd2fbf34201970c4f1bb556cb9d63a0a13efa60194",
  );
  assert.notEqual(likeSubjectIndexTopic(0), likeSubjectIndexTopic(1));
});

test("closed schema: exactly {format, subject, value}", () => {
  assert.equal(validateLikeStatementV1({ format: "woco.like.v1", subject: SUBJECT, value: true }), true);
  assert.equal(validateLikeStatementV1({ format: "woco.like.v1", subject: SUBJECT, value: false }), true);
  assert.equal(validateLikeStatementV1({ format: "woco.follow.v1", subject: SUBJECT, value: true }), false);
  assert.equal(validateLikeStatementV1({ format: "woco.like.v1", subject: SUBJECT, value: 1 }), false);
  assert.equal(validateLikeStatementV1({ format: "woco.like.v1", subject: SUBJECT, value: true, seq: 1 }), false);
  assert.equal(validateFollowStatementV1({ format: "woco.follow.v1", subject: SUBJECT, value: true }), true);
});
