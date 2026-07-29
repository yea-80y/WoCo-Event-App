/**
 * Durable persistence for the compliance stores.
 *
 * These files are the enforcement and evidence layer for marketing consent —
 * losing marketing-suppression.json means mailing people who unsubscribed. Two
 * failure modes are pinned here: a torn write must not be observable, and a
 * failed write must not be silent.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let persist: typeof import("../src/lib/marketing/persist.js");
let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "woco-persist-test-"));
  persist = await import("../src/lib/marketing/persist.js");
});

test("a value round-trips through the file", () => {
  const file = join(dir, "round-trip.json");
  assert.equal(persist.writeJsonAtomic(file, { a: 1, b: ["x"] }, "t1"), true);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf-8")), { a: 1, b: ["x"] });
});

test("missing parent directories are created", () => {
  const file = join(dir, "nested", "deeper", "store.json");
  assert.equal(persist.writeJsonAtomic(file, { ok: true }, "t2"), true);
  assert.ok(existsSync(file));
});

/**
 * The torn-write guarantee. writeFileSync truncates before writing, so a crash
 * mid-write leaves a half-file — and every store's loader treats an unparseable
 * file as "doesn't exist yet", which would resurrect an EMPTY suppression list
 * without a word. Temp-then-rename means a reader sees only whole files.
 */
test("an overwrite never leaves the previous contents truncated", () => {
  const file = join(dir, "overwrite.json");
  persist.writeJsonAtomic(file, { generation: 1 }, "t3");
  persist.writeJsonAtomic(file, { generation: 2, padding: "x".repeat(100_000) }, "t3");

  const parsed = JSON.parse(readFileSync(file, "utf-8")) as { generation: number };
  assert.equal(parsed.generation, 2);
});

test("no .tmp file is left behind after a successful write", () => {
  const file = join(dir, "no-litter.json");
  persist.writeJsonAtomic(file, { ok: true }, "t4");
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
});

/**
 * Forced failure. The parent path is a FILE, so mkdirSync raises ENOTDIR —
 * deterministic regardless of uid, unlike a permissions-based test.
 */
test("a failed write reports false rather than throwing", () => {
  const blocker = join(dir, "blocker");
  writeFileSync(blocker, "not a directory");
  const impossible = join(blocker, "sub", "store.json");

  assert.equal(persist.writeJsonAtomic(impossible, { a: 1 }, "doomed"), false);
});

test("a failed write surfaces on the health payload, and clears on recovery", () => {
  const blocker = join(dir, "blocker2");
  writeFileSync(blocker, "not a directory");

  persist.writeJsonAtomic(join(blocker, "sub", "s.json"), { a: 1 }, "flaky");
  const sick = persist.persistHealth();
  assert.equal(sick.ok, false);
  const entry = sick.failing.find((f) => f.store === "flaky");
  assert.ok(entry, "the failing store must be named");
  assert.equal(entry.consecutiveFailures, 1);
  assert.ok(entry.lastError.length > 0);

  // The same tag succeeding again must clear it, or the alarm never resets.
  persist.writeJsonAtomic(join(dir, "flaky-recovered.json"), { a: 1 }, "flaky");
  assert.equal(persist.persistHealth().failing.some((f) => f.store === "flaky"), false);
});

test("consecutive failures accumulate for the same store", () => {
  const blocker = join(dir, "blocker3");
  writeFileSync(blocker, "not a directory");
  const impossible = join(blocker, "sub", "s.json");

  persist.writeJsonAtomic(impossible, {}, "repeatedly");
  persist.writeJsonAtomic(impossible, {}, "repeatedly");
  const entry = persist.persistHealth().failing.find((f) => f.store === "repeatedly");
  assert.equal(entry?.consecutiveFailures, 2);
});

/** What lets eraseSubject report `persisted: false` without threading booleans. */
test("the global failure counter moves only on failure", () => {
  const before = persist.persistFailureCount();
  persist.writeJsonAtomic(join(dir, "fine.json"), { a: 1 }, "counter");
  assert.equal(persist.persistFailureCount(), before, "a success must not move it");

  const blocker = join(dir, "blocker4");
  writeFileSync(blocker, "not a directory");
  persist.writeJsonAtomic(join(blocker, "sub", "s.json"), {}, "counter");
  assert.equal(persist.persistFailureCount(), before + 1);
});

test("health is ok when nothing is failing", () => {
  // Recover every tag this suite deliberately broke.
  for (const tag of ["doomed", "repeatedly", "counter"]) {
    persist.writeJsonAtomic(join(dir, `${tag}-ok.json`), { a: 1 }, tag);
  }
  assert.deepEqual(persist.persistHealth(), { ok: true, failing: [] });
});
