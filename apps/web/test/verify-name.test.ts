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

// ---------------------------------------------------------------------------
// The LAST-GOOD-VERDICT rule — the half that is not in `name-verdict.ts`
// ---------------------------------------------------------------------------
//
// Fail-closed is only bounded by this: an unanswered check keeps whatever the
// chain last said, so an RPC outage costs a viewer the FIRST paint of a name on
// a device and nothing else. Two ways to break it, both silent — writing a
// failure into the cache (every already-verified name goes dark for a day), and
// letting a failure fabricate a verdict (fail-open, the thing the module
// exists to prevent). Neither shows up in `verdictAllows`, so they are driven
// here through the real `refreshVerdict` / `verifyName` with the owner lookup
// injected and the real localStorage cache behind a memory shim.

class MemoryStorage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
}
const storage = new MemoryStorage();
(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = storage;

const { refreshVerdict, verifyName, cachedVerdict } = await import(
  "../src/lib/sub-ens/verify-name.js"
);
const { cacheSet } = await import("../src/lib/cache/cache.js");

const DAY = 24 * 60 * 60;

/** Seed the cache through its REAL writer, so only the key string is restated —
 *  a key change here makes these tests miss and fail, which is the point. */
function seed(label: string, owner: string | null, ageMs: number): void {
  cacheSet(`subens-owner:${label}`, { owner, checkedAt: Date.now() - ageMs }, DAY);
}

const STALE = 20 * 60_000; // past FRESH_MS.found, so a revalidation is forced
const answers = (owner: string | null) => async () => ({
  ok: true,
  data: owner ? { available: false, owner } : { available: true },
});
const throws = async () => {
  throw new Error("RPC quota exhausted");
};

test("a read that fails leaves the remembered verdict exactly as it was", async () => {
  storage.clear();
  seed("punkpub", OWNER, STALE);
  const before = cachedVerdict("punkpub");
  assert.ok(before, "precondition: the seeded verdict is readable at the module's own key");

  assert.equal(
    await verifyName("punkpub", OWNER, throws),
    true,
    "an outage must not hide a name this device has already verified",
  );
  assert.deepEqual(
    cachedVerdict("punkpub"),
    before,
    "a failed lookup is not a verdict and must never be written",
  );
});

test("a read that fails returns no verdict, rather than inventing one", async () => {
  storage.clear();
  assert.equal(await refreshVerdict("punkpub", throws), null);
  assert.equal(cachedVerdict("punkpub"), null, "nothing may be remembered from a failure");
});

test("an ERROR ENVELOPE is a failure too, not an absence", async () => {
  // `{ ok: false }` is the server saying it could not answer. Recording it as
  // "no such name" would be the same fail-open by a different door.
  storage.clear();
  seed("punkpub", OWNER, STALE);
  const before = cachedVerdict("punkpub");
  assert.equal(await refreshVerdict("punkpub", async () => ({ ok: false, error: "rpc down" })), null);
  assert.deepEqual(cachedVerdict("punkpub"), before);
});

test("a read that SUCCEEDS replaces the cache", async () => {
  storage.clear();
  seed("punkpub", OTHER, STALE);
  const v = await refreshVerdict("punkpub", answers(OWNER));
  assert.equal(v?.owner, OWNER);
  assert.equal(cachedVerdict("punkpub")?.owner, OWNER, "the new verdict must be the remembered one");
  assert.equal(await verifyName("punkpub", OWNER), true);
});

test("a definitive 'no such name' IS a verdict and is remembered", async () => {
  // The dead-stamp case (`finaltest`): absence is an answer, unlike a failure,
  // and remembering it is what stops the name being re-checked on every paint.
  storage.clear();
  seed("finaltest", OWNER, STALE);
  const v = await refreshVerdict("finaltest", answers(null));
  assert.equal(v?.owner, null, "an unregistered name is an ANSWER: the verdict is owner=null");
  assert.equal(cachedVerdict("finaltest")?.owner, null, "and it is remembered, unlike a failure");
  assert.equal(await verifyName("finaltest", OWNER), false);
});

test("no cache and a failing read paints nothing — never a fabricated verdict", async () => {
  storage.clear();
  assert.equal(await verifyName("punkpub", OWNER, throws), false);
  assert.equal(cachedVerdict("punkpub"), null);
});

test("a FRESH cached verdict is answered without a read at all", async () => {
  storage.clear();
  seed("punkpub", OWNER, 0);
  let calls = 0;
  const counted = async () => {
    calls++;
    return { ok: true, data: { available: true } };
  };
  assert.equal(await verifyName("punkpub", OWNER, counted), true);
  assert.equal(calls, 0, "a fresh verdict must not spend a request");
});
