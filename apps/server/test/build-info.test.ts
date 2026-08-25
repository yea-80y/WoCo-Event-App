/**
 * The deployed-commit stamp (#125).
 *
 * `/api/health` publishes this, and the whole value of publishing it is that it
 * can be TRUSTED. The failure to avoid is not "no stamp" — it is a stamp that
 * says something untrue, because an operator who reads a commit off a health
 * endpoint will act on it.
 *
 * The stamp is read ONCE at module load (it cannot change under a running
 * container), so each case here re-imports the module with a different cwd.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHA = "09e24b3f23d447e8a42a797f82cb4ebc3ffa1bcb";

/** Fresh cwd + fresh module instance, so the boot-time read is re-run. */
async function readStampIn(contents: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "woco-build-info-"));
  if (contents !== null) writeFileSync(join(dir, ".deploy-commit"), contents);
  const prev = process.cwd();
  process.chdir(dir);
  try {
    const mod = await import(`../src/config/build-info.js?case=${encodeURIComponent(contents ?? "absent")}`);
    return mod.buildInfo();
  } finally {
    process.chdir(prev);
  }
}

test("a clean deploy reports its commit", async () => {
  const info = await readStampIn(`${SHA}\n2026-08-25T15:00:00Z\n`);
  assert.equal(info.commit, SHA);
  assert.equal(info.clean, true);
  assert.equal(info.stampedAt, "2026-08-25T15:00:00Z");
});

test("a --allow-dirty deploy is reported as NOT clean", async () => {
  // The half-truth case, and the reason `clean` exists as a separate field: the
  // commit names roughly what shipped, not exactly what shipped. An operator
  // comparing this SHA against main would otherwise conclude they match.
  const info = await readStampIn(`${SHA}-dirty\n2026-08-25T15:00:00Z\n`);
  assert.equal(info.commit, `${SHA}-dirty`);
  assert.equal(info.clean, false);
});

test("an unstamped build says unknown rather than guessing", async () => {
  // A plain `docker compose build`, or a deploy that bypassed the script. The
  // honest answer is that nobody said.
  const info = await readStampIn(null);
  assert.equal(info.commit, "unknown");
  assert.equal(info.clean, false);
  assert.equal(info.stampedAt, undefined);
});

test("an empty or truncated stamp is unknown, not an empty commit", async () => {
  // A partial write must not surface as `commit: ""`, which would render on a
  // dashboard as a blank rather than as a missing answer.
  for (const contents of ["", "\n", "   \n\n"]) {
    const info = await readStampIn(contents);
    assert.equal(info.commit, "unknown", `contents ${JSON.stringify(contents)}`);
    assert.equal(info.clean, false);
  }
});

test("a stamp with no timestamp line still reports the commit", async () => {
  // Forward compatibility with a hand-written stamp: the SHA is the load-bearing
  // half and must not be lost because the second line is missing.
  const info = await readStampIn(`${SHA}\n`);
  assert.equal(info.commit, SHA);
  assert.equal(info.clean, true);
  assert.equal(info.stampedAt, undefined);
});
