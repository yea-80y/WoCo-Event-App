/**
 * The profile page must not read the retired EAS likes rail (#475).
 *
 * Likes and follows left the chain: the live rail is Swarm-native
 * (`lib/social/`, `docs/SWARM_SOCIAL_PLAN.md`). ProfilePage's Following tab and
 * Trending block, however, still called `getFollowing`/`getTrending` against
 * `/api/likes/*`, so a visitor saw June's test attestations presented as the
 * account's real follows. Both surfaces were removed rather than repointed,
 * because the Swarm-native replacement does not exist yet — and the cheapest way
 * for them to come back by accident is for someone to re-add the import while
 * rebuilding the tab.
 *
 * SOURCE SCAN, deliberately. The property is "this component does not talk to
 * that module at all", which is a fact about the import graph. A runtime test
 * would have to render Svelte to observe it and would still pass if the call
 * simply never fired for the fixture's address.
 *
 * MUTATION: add `import { getFollowing } from "../../api/likes.js";` back to
 * ProfilePage.svelte, and this goes red.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PAGE = fileURLToPath(
  new URL("../src/lib/components/profile/ProfilePage.svelte", import.meta.url),
);
const text = readFileSync(PAGE, "utf-8");

test("the scan actually reaches ProfilePage", () => {
  // Without this, a rename or a move would empty the scan and every assertion
  // below would pass vacuously — the classic way a source ratchet stops guarding
  // anything while staying green.
  assert.ok(text.length > 10_000, `ProfilePage.svelte read as ${text.length} bytes — wrong file?`);
  assert.match(text, /<script lang="ts">/, "…and it must be the Svelte component");
});

test("ProfilePage imports nothing from the EAS likes API", () => {
  assert.doesNotMatch(
    text,
    /from\s*["'][^"']*api\/likes(\.js)?["']/,
    "the EAS likes API is the retired rail — follows come from lib/social/",
  );
});

test("ProfilePage calls neither getFollowing nor getTrending", () => {
  // Named separately from the import assertion: a re-export elsewhere, or a
  // dynamic import(), would reach the same two functions past that check.
  for (const fn of ["getFollowing(", "getTrending("]) {
    assert.ok(!text.includes(fn), `${fn}) reads retired EAS attestations (#475)`);
  }
});

test("the Swarm-native follow button is still there", () => {
  // The removal was of the READS, not of following itself. If this goes red,
  // the page lost the live rail too and the fix above over-reached.
  assert.match(text, /socialProfileSubject\(/, "the follow button's Swarm-native subject");
  assert.match(text, /variant="follow"/, "the LikeButton follow variant");
});
