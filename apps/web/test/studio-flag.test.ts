/**
 * The member shell shows a Studio link from a per-account flag on this device.
 * These pin that the flag belongs to one account, ignores address case, and
 * that a browser refusing storage hides the link rather than breaking the shell.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

class MemoryStorage {
  map = new Map<string, string>();
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
}

const storage = new MemoryStorage();
const g = globalThis as unknown as { localStorage: unknown };
g.localStorage = storage;

const { markStudio, hasStudio } = await import("../src/lib/auth/studio-flag.js");

// Hex letters on purpose: an all-digit address reads the same in any case, so
// the case test could never fail against it.
const ALICE = "0xabcdef1111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";

beforeEach(() => {
  storage.map.clear();
  g.localStorage = storage;
});

test("an account has no Studio link until it is marked", () => {
  assert.equal(hasStudio(ALICE), false);
  markStudio(ALICE);
  assert.equal(hasStudio(ALICE), true);
});

test("the flag belongs to one account", () => {
  markStudio(ALICE);
  assert.equal(hasStudio(BOB), false);
});

test("an address matches whatever its case", () => {
  markStudio(ALICE.toUpperCase().replace("0X", "0x"));
  assert.equal(hasStudio(ALICE), true);
});

test("no account means no flag and nothing written", () => {
  markStudio(null);
  markStudio(undefined);
  assert.equal(hasStudio(null), false);
  assert.equal(storage.map.size, 0);
});

test("storage that throws hides the link instead of breaking the shell", () => {
  g.localStorage = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
  };
  assert.doesNotThrow(() => markStudio(ALICE));
  assert.equal(hasStudio(ALICE), false);
});
