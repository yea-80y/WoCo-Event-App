/**
 * Likes and follows under banding.
 *
 * Two different answers for two different structures, and conflating them is
 * the mistake this file exists to prevent:
 *
 *   - STATEMENT feeds never leave band 0. A like is latest-wins, so a feed gains
 *     a version per TOGGLE, not per action — there is no growth axis to bound.
 *   - The INDEX does grow: one version per new subject, and subjects are never
 *     removed, so unbanded it was the one structure here whose read cost tracked
 *     how much a user had ever liked.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  likeStatementTopic,
  followStatementTopic,
  likeSubjectIndexTopic,
  followSubjectIndexTopic,
  LIKE_SUBJECT_INDEX_FORMAT,
  FOLLOW_SUBJECT_INDEX_FORMAT,
  STATEMENT_BAND_SIZE,
  type Hex0x,
} from "@woco/shared";

const SUBJECT = `0x${"5c".repeat(32)}` as Hex0x;

test("a like's statement topic is fixed — it takes no band and cannot drift", () => {
  // Deliberately NOT parameterised. If a future edit gives these a band
  // argument, a writer and a reader can disagree about which one to use, and a
  // like lands somewhere nobody looks.
  assert.equal(likeStatementTopic(SUBJECT), likeStatementTopic(SUBJECT));
  assert.equal(likeStatementTopic.length, 1, "subject only — no band parameter");
  assert.equal(followStatementTopic.length, 1, "subject only — no band parameter");
});

test("the index topics ARE banded, and each band is a different address", () => {
  for (const topicFor of [likeSubjectIndexTopic, followSubjectIndexTopic]) {
    const seen = new Set<string>();
    for (let band = 0; band < 4; band++) seen.add(topicFor(band));
    assert.equal(seen.size, 4, "each band must be its own feed");
    for (const t of seen) assert.match(t, /^woco\/(like|follow)\/v1\/index\/[0-9a-f]{64}$/);
  }
});

test("likes and follows never share an index, in any band", () => {
  for (let band = 0; band < 3; band++) {
    assert.notEqual(likeSubjectIndexTopic(band), followSubjectIndexTopic(band));
  }
});

test("the social index formats stay at v1 — only the topic moved", () => {
  // Each index version is already a FULL SNAPSHOT, so banding changes where the
  // index lives without changing what it says. A format bump here would have
  // been surface for nothing.
  assert.equal(LIKE_SUBJECT_INDEX_FORMAT, "woco.like-index.v1");
  assert.equal(FOLLOW_SUBJECT_INDEX_FORMAT, "woco.follow-index.v1");
});

test("social shares the ONE band size — a per-type constant would fork the scheme", () => {
  assert.equal(STATEMENT_BAND_SIZE, 64);
});
