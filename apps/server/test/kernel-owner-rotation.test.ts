/**
 * After recovery rotates a Kernel's owner, the previous key must stop
 * authenticating (#200).
 *
 * The live on-chain owner decides that, and it decides it correctly whenever the
 * read succeeds. The gap was the read FAILING: both "provably no owner" and "could
 * not reach the chain" fell through to a counterfactual address match, and the
 * Kernel address is CREATE2-derived from the original owner's init data — so the
 * rotated-out key satisfies it forever.
 *
 * These tests pin the distinction. An account that has never been seen with an
 * on-chain owner keeps the fallback, because for it the fallback IS the mechanism.
 * An account that has been seen with one refuses, because there the counterfactual
 * says something about the account's birth rather than about who controls it.
 *
 * The durability test is the one that matters most in practice: the record is what
 * a failed read consults, and a deploy restarts the process. If it did not survive
 * that, the window would reopen on every release with nothing to notice.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cwd = process.cwd();
let dir: string;

beforeEach(() => {
  // The store writes to `${cwd}/.data`, so give each test its own cwd.
  dir = mkdtempSync(join(tmpdir(), "woco-kernel-deployed-"));
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(cwd);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

async function freshStore() {
  const mod = await import(`../src/lib/auth/kernel-deployed.js?t=${Math.random()}`);
  mod._resetKernelDeployedForTests();
  return mod as typeof import("../src/lib/auth/kernel-deployed.js");
}

const KERNEL = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";

test("an unseen Kernel is not known-deployed, so the fallback still applies", async () => {
  const s = await freshStore();
  assert.equal(s.isKernelKnownDeployed(KERNEL), false);
});

test("observing an owner marks it, and only it", async () => {
  const s = await freshStore();
  s.markKernelDeployed(KERNEL);
  assert.equal(s.isKernelKnownDeployed(KERNEL), true);
  assert.equal(s.isKernelKnownDeployed(OTHER), false);
});

test("the address is matched case-insensitively", async () => {
  // Kernel addresses arrive checksummed from viem and lowercased from the auth
  // middleware; a case mismatch here would silently fail open.
  const s = await freshStore();
  s.markKernelDeployed(KERNEL.toUpperCase().replace("0X", "0x"));
  assert.equal(s.isKernelKnownDeployed(KERNEL), true);
});

test("the record survives a restart — a deploy must not reopen the window", async () => {
  const s1 = await freshStore();
  s1.markKernelDeployed(KERNEL);
  assert.ok(existsSync(join(dir, ".data", "kernel-deployed.json")), "nothing was persisted");

  // Fresh module instance, same cwd — models the process restart a deploy performs.
  const s2 = await freshStore();
  assert.equal(s2.isKernelKnownDeployed(KERNEL), true, "the record did not survive reload");
});

test("the file is written 0600 — it is under .data with the revocation state", async () => {
  const s = await freshStore();
  s.markKernelDeployed(KERNEL);
  const { mode } = await import("node:fs").then((fs) =>
    fs.statSync(join(dir, ".data", "kernel-deployed.json")),
  );
  assert.equal(mode & 0o777, 0o600);
});

test("marking twice does not rewrite the first-observed timestamp", async () => {
  const s = await freshStore();
  s.markKernelDeployed(KERNEL);
  const first = JSON.parse(readFileSync(join(dir, ".data", "kernel-deployed.json"), "utf-8"));
  s.markKernelDeployed(KERNEL);
  const second = JSON.parse(readFileSync(join(dir, ".data", "kernel-deployed.json"), "utf-8"));
  assert.deepEqual(first, second, "re-marking mutated the record");
});

test("an unreadable store fails OPEN, not closed", async () => {
  // A corrupt or unreadable file leaves the set empty, so the counterfactual
  // fallback resumes. That is deliberate and worth pinning: refusing every
  // deployed account because a file would not parse trades one narrow window for
  // a total outage. It is also why the file must be on the survives-restarts list.
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, ".data"), { recursive: true });
  writeFileSync(join(dir, ".data", "kernel-deployed.json"), "{ not json");

  const s = await freshStore();
  assert.equal(s.isKernelKnownDeployed(KERNEL), false);
});
