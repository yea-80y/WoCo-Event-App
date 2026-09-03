/**
 * Subject derivation is the one place likes and follows can fragment silently —
 * two call sites deriving the same subject differently split its audience with
 * no error on either side. These vectors are the spec; a change here is a
 * change to every statement already written.
 *
 * PROFILE keying moved to the account ADDRESS on 2026-09-03 and is owned by
 * `subject-keying.test.ts`. The namehash vectors that used to live here were
 * removed with the derivation they pinned — a name is display now, and an
 * audience keyed to one could be moved by WoCo governance, by whoever re-mints
 * a released name, and by the custody of `woco.eth` itself.
 *
 * What remains here is the EVENT derivation, which did not change.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { socialEventSubject } from "../../src/social/subject.js";

test("event subject normalises case rather than fragmenting on it", () => {
  const lower = `0x${"ab".repeat(32)}`;
  assert.equal(socialEventSubject(`0x${"AB".repeat(32)}`), lower);
  assert.equal(socialEventSubject(`  ${lower}  `), lower);
});

test("event subject rejects anything that is not a bytes32", () => {
  // The frozen topic scheme has no defined behaviour for another width, so a
  // wrong-width id must fail loudly rather than derive a plausible topic.
  assert.throws(() => socialEventSubject("0xdeadbeef"), /bytes32/);
  assert.throws(() => socialEventSubject("ab".repeat(32)), /bytes32/); // missing 0x
  assert.throws(() => socialEventSubject(""), /bytes32/);
});

test("the social rail imports nothing from the retired EAS likes module", () => {
  // `social/subject.ts` used to borrow `profileSubject` from `likes/`, which was
  // the last edge from live social code into a rail being deleted. A future
  // deleter must be able to remove `likes/` without discovering that the live
  // follow derivation depended on it.
  const src = readFileSync(new URL("../../src/social/subject.js".replace(".js", ".ts"), import.meta.url), "utf-8");
  const imports = [...src.matchAll(/^import .*from "([^"]+)";$/gm)].map((m) => m[1]);
  for (const spec of imports) {
    assert.doesNotMatch(spec, /likes/, `social/subject.ts must not import from ${spec}`);
  }
});
