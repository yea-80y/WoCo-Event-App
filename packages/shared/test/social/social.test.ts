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
    "woco/like/v1/993477793bcabbc4b062ea24094f8cc273a6d582aed4f91ebcec95eb31e6af20",
  );
  assert.equal(
    likeSubjectIndexTopic(),
    "woco/like/v1/index/aaadaa52832027b78a0d636926b1c5c8c1dc1c2b3e1485915da6a53527aff8f3",
  );
  assert.equal(
    followStatementTopic(SUBJECT),
    "woco/follow/v1/11a79c38acb1b8718aeb22dd8012b577a13c555c3fc776801464e93ec32529f8",
  );
  // Same subject, different type → different address. The type segment AND the
  // salt both partition; a like can never land on a follow topic.
  assert.notEqual(likeStatementTopic(SUBJECT), followStatementTopic(SUBJECT));
});

test("closed schema: exactly {format, subject, value}", () => {
  assert.equal(validateLikeStatementV1({ format: "woco.like.v1", subject: SUBJECT, value: true }), true);
  assert.equal(validateLikeStatementV1({ format: "woco.like.v1", subject: SUBJECT, value: false }), true);
  assert.equal(validateLikeStatementV1({ format: "woco.follow.v1", subject: SUBJECT, value: true }), false);
  assert.equal(validateLikeStatementV1({ format: "woco.like.v1", subject: SUBJECT, value: 1 }), false);
  assert.equal(validateLikeStatementV1({ format: "woco.like.v1", subject: SUBJECT, value: true, seq: 1 }), false);
  assert.equal(validateFollowStatementV1({ format: "woco.follow.v1", subject: SUBJECT, value: true }), true);
});
