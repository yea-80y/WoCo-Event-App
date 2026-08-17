/**
 * The remembered like/follow count (#311).
 *
 * What is pinned here is whatever decides whether the remembered number is
 * honest, rather than the fact that a value round-trips:
 *
 *   - A miss is `null`, never `0`. Absent means "this browser has never been
 *     told"; zero would be a claim that nobody liked it.
 *   - An observed `0` is a real tally and must survive as `0`, or the one
 *     honest way to say "counted, and nobody has" collapses into the miss.
 *   - A like and a follow of the same name are separate totals. One key would
 *     let a follower count paint as likes.
 *   - localStorage is editable and shared with every other tab, so anything
 *     that is not a whole non-negative number is treated as absent.
 *   - A count nobody has been able to confirm for a day stops being asserted.
 *
 * Vocabulary: a count is a tally over many people's own feeds, computed by an
 * indexer — this module only remembers what one was last seen to say.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// Installed before the module under test touches storage. cache.ts reads
// localStorage inside its functions only, so a plain assignment here is enough.
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

const { readCachedCount, rememberCount } = await import("../src/lib/social/count-cache.js");
const { TTL, cacheKey } = await import("../src/lib/cache/cache.js");

type Hex0x = `0x${string}`;
const SUBJECT = `0x${"ab".repeat(32)}` as Hex0x;
const OTHER = `0x${"cd".repeat(32)}` as Hex0x;
const RAW_KEY = (kind: string, subject: string) => `woco:v1:${cacheKey.socialCount(kind, subject)}`;

test("a subject this browser has never seen reads as absent, not as zero", () => {
  storage.clear();
  // The whole absent/zero distinction rests here: a miss that returned 0 would
  // put "0" under a heart that may well have been liked a hundred times.
  assert.equal(readCachedCount("like", SUBJECT), null);
});

test("an observed count is remembered", () => {
  storage.clear();
  rememberCount("like", SUBJECT, 42);
  assert.equal(readCachedCount("like", SUBJECT), 42);
});

test("an observed zero survives as zero", () => {
  storage.clear();
  // Distinct from the miss above, and the distinction has to survive storage:
  // an indexer that answered "0" was reachable and counted.
  rememberCount("like", SUBJECT, 0);
  assert.equal(readCachedCount("like", SUBJECT), 0);
});

test("a like and a follow of the same subject are remembered separately", () => {
  storage.clear();
  rememberCount("like", SUBJECT, 7);
  rememberCount("follow", SUBJECT, 900);
  assert.equal(readCachedCount("like", SUBJECT), 7);
  assert.equal(readCachedCount("follow", SUBJECT), 900);
});

test("two subjects do not share an entry", () => {
  storage.clear();
  rememberCount("like", SUBJECT, 7);
  assert.equal(readCachedCount("like", OTHER), null);
});

test("the same subject in a different case is the same entry", () => {
  storage.clear();
  // Subject ids reach the UI from several producers (namehash, on-chain event
  // id); a casing difference splitting the entry would silently blank the
  // number on one route and not the other.
  rememberCount("like", SUBJECT.toUpperCase().replace("0X", "0x") as Hex0x, 12);
  assert.equal(readCachedCount("like", SUBJECT), 12);
});

test("a stored value that is not a whole count reads as absent", () => {
  for (const bad of ['"12"', "{}", "[1,2]", "-3", "1.5", "null", '"NaN"', "true", "1e21"]) {
    storage.clear();
    // Hand-written entry: another tab, an extension, or a user with devtools.
    // `"12"` is the dangerous one — it passes `> 0` and would render.
    storage.setItem(RAW_KEY("like", SUBJECT), `{"data":${bad},"cachedAt":${Date.now()},"ttl":null}`);
    assert.equal(readCachedCount("like", SUBJECT), null, `stored ${bad}`);
  }
});

test("a value that is not a whole count is never written", () => {
  // 1e21 is an integer to JavaScript and would render as "1e+21" under a heart.
  for (const bad of [-1, 1.5, NaN, Infinity, 1e21]) {
    storage.clear();
    rememberCount("like", SUBJECT, bad);
    assert.equal(storage.getItem(RAW_KEY("like", SUBJECT)), null, `wrote ${bad}`);
  }
});

test("a count that never arrived is not remembered, and does not erase one that did", () => {
  // The rule the whole issue turns on: an unreachable indexer answers `null`,
  // and null must leave the last good figure exactly where it was. A mutant
  // that wrote it through would blank the number on the first outage — the
  // behaviour this change exists to remove.
  storage.clear();
  assert.equal(readCachedCount("like", SUBJECT), null);
  rememberCount("like", SUBJECT, null);
  assert.equal(storage.getItem(RAW_KEY("like", SUBJECT)), null);

  rememberCount("like", SUBJECT, 9);
  rememberCount("like", SUBJECT, null);
  assert.equal(readCachedCount("like", SUBJECT), 9);
});

test("a count nobody has confirmed for longer than the TTL is dropped", () => {
  storage.clear();
  rememberCount("like", SUBJECT, 55);
  const realNow = Date.now;
  try {
    // Eviction, not staleness: inside the window the number is shown however
    // old it is. Past it, this browser stops repeating a figure it has had no
    // confirmation of.
    Date.now = () => realNow() + (TTL.SOCIAL_COUNT + 60) * 1000;
    assert.equal(readCachedCount("like", SUBJECT), null);
  } finally {
    Date.now = realNow;
  }
});
