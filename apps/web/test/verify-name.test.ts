/**
 * Display verification (plan doc §3 point F) — the rule that decides whether a
 * name claimed by a feed is rendered at all.
 *
 * The pure half is tested here: what a verdict permits, and when a verdict is
 * stale. Those two functions are the whole policy; the IO around them is a
 * fetch and a localStorage write.
 *
 * The property that matters is FAIL-CLOSED: anything short of "the chain said
 * this label belongs to this address" renders nothing. `/api/sub-ens/check` is
 * public and RPC-backed, so a fail-open rule would let an attacker who can
 * exhaust the RPC quota get a forged name rendered for every viewer.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { verdictAllows, verdictIsFresh } from "../src/lib/sub-ens/name-verdict.js";

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const NOW = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// verdictAllows — fail closed
// ---------------------------------------------------------------------------

test("a matching owner is rendered", () => {
  assert.equal(verdictAllows({ owner: OWNER, checkedAt: NOW }, OWNER), true);
});

test("case never decides the answer", () => {
  assert.equal(verdictAllows({ owner: OWNER, checkedAt: NOW }, OWNER.toUpperCase()), true);
});

test("a DIFFERENT owner is refused — this is the impersonation case", () => {
  assert.equal(verdictAllows({ owner: OTHER, checkedAt: NOW }, OWNER), false);
});

test("an unregistered name is refused — the dead-stamp case", () => {
  // `finaltest` / `testevent` point at a registry that no longer exists. Their
  // feeds are client-signed and cannot be rewritten, so refusing to render is
  // the only thing that makes them disappear.
  assert.equal(verdictAllows({ owner: null, checkedAt: NOW }, OWNER), false);
});

test("NO verdict is refused — an unchecked name is never painted", () => {
  // The alternative, painting the claim while the check is in flight, hands the
  // impersonation most of its value: viewers read the page, not the timing.
  assert.equal(verdictAllows(null, OWNER), false);
});

test("a verdict with nobody to compare against is refused", () => {
  assert.equal(verdictAllows({ owner: OWNER, checkedAt: NOW }, null), false);
  assert.equal(verdictAllows({ owner: OWNER, checkedAt: NOW }, undefined), false);
  assert.equal(verdictAllows({ owner: OWNER, checkedAt: NOW }, ""), false);
});

// ---------------------------------------------------------------------------
// verdictIsFresh — when to revalidate
// ---------------------------------------------------------------------------

test("no verdict is never fresh, so the first render always checks", () => {
  assert.equal(verdictIsFresh(null, NOW), false);
});

test("a positive verdict is fresh for ten minutes", () => {
  const v = { owner: OWNER, checkedAt: NOW };
  assert.equal(verdictIsFresh(v, NOW + 9 * 60_000), true);
  assert.equal(verdictIsFresh(v, NOW + 11 * 60_000), false);
});

test("a NEGATIVE verdict goes stale sooner than a positive one", () => {
  // "No such name" is the verdict that changes under the viewer's feet: a name
  // minted seconds ago reads as absent until the mint lands. A positive verdict
  // going stale only means a name changed hands, which is not what this
  // module exists to catch.
  const none = { owner: null, checkedAt: NOW };
  const found = { owner: OWNER, checkedAt: NOW };
  assert.equal(verdictIsFresh(none, NOW + 3 * 60_000), false);
  assert.equal(verdictIsFresh(found, NOW + 3 * 60_000), true);
});

test("freshness is not retroactive — a verdict is fresh the instant it is taken", () => {
  assert.equal(verdictIsFresh({ owner: OWNER, checkedAt: NOW }, NOW), true);
});
