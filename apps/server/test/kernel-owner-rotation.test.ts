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
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
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


// ── The decision itself ──────────────────────────────────────────────────────
//
// Everything above pins the STORE. Until this section existed the decision was
// unpinned: the whole kernel-owner.ts change could be reverted and the suite
// stayed green. It is a pure function precisely so the truth table can be stated
// without an RPC.

const OWNER_EOA = "0xaaaa000000000000000000000000000000000001";
const OTHER_EOA = "0xbbbb000000000000000000000000000000000002";

async function decide() {
  const m = await import("../src/lib/auth/kernel-owner.js");
  return m.decideKernelOwnership;
}

test("a readable owner settles it, both ways, regardless of anything else", async () => {
  const d = await decide();
  // Even a counterfactual match and a known-deployed record cannot override a
  // definitive read — that is what "authoritative" means.
  assert.equal(d({ ownerRead: OWNER_EOA, eoa: OWNER_EOA, counterfactualMatches: false, knownDeployed: true }), true);
  assert.equal(d({ ownerRead: OTHER_EOA, eoa: OWNER_EOA, counterfactualMatches: true, knownDeployed: false }), false);
});

test("never seen deployed + no owner on chain → the counterfactual decides", async () => {
  const d = await decide();
  assert.equal(d({ ownerRead: null, eoa: OWNER_EOA, counterfactualMatches: true, knownDeployed: false }), true);
  assert.equal(d({ ownerRead: null, eoa: OWNER_EOA, counterfactualMatches: false, knownDeployed: false }), false);
});

test("never seen deployed + read error → the counterfactual still decides", async () => {
  const d = await decide();
  assert.equal(d({ ownerRead: "error", eoa: OWNER_EOA, counterfactualMatches: true, knownDeployed: false }), true);
});

test("KNOWN DEPLOYED + read error → refuse, counterfactual or not", async () => {
  const d = await decide();
  assert.equal(d({ ownerRead: "error", eoa: OWNER_EOA, counterfactualMatches: true, knownDeployed: true }), false);
});

test("KNOWN DEPLOYED + a read returning NO owner → refuse, counterfactual or not", async () => {
  // The half missed on the first pass. A storage read against state a node does
  // not have returns zero rather than failing, so a lagging or load-balanced RPC
  // serving pre-deployment state is indistinguishable from "no owner" — and used
  // to fall straight through to the counterfactual, readmitting the retired key.
  // A validator-address change or an uninstalled ECDSA validator reads the same.
  const d = await decide();
  assert.equal(d({ ownerRead: null, eoa: OWNER_EOA, counterfactualMatches: true, knownDeployed: true }), false);
});

test("the record cannot manufacture access, only withhold it", async () => {
  // knownDeployed only ever turns true into false. If it could turn false into
  // true it would be an authentication bypass rather than a guard.
  const d = await decide();
  for (const ownerRead of [null, "error"] as const) {
    for (const counterfactualMatches of [true, false]) {
      const withRecord = d({ ownerRead, eoa: OWNER_EOA, counterfactualMatches, knownDeployed: true });
      const without = d({ ownerRead, eoa: OWNER_EOA, counterfactualMatches, knownDeployed: false });
      assert.ok(!(withRecord && !without), `record granted access it should not: ${ownerRead}/${counterfactualMatches}`);
    }
  }
});

// ── An unreadable store is loud, and keeps its evidence ──────────────────────

test("a corrupt store logs, quarantines, and does not overwrite itself", async () => {
  // The failure is fail-OPEN by design, which is the right default — but it is
  // also the one event that silently restores the behaviour this module removes,
  // so it must not be silent, and the next write must not destroy the evidence.
  mkdirSync(join(dir, ".data"), { recursive: true });
  writeFileSync(join(dir, ".data", "kernel-deployed.json"), "{ not json");

  const s = await freshStore();
  assert.equal(s.kernelDeployedLoadFailed(), true, "the load failure was not recorded");
  assert.equal(s.isKernelKnownDeployed(KERNEL), false, "should fail open");

  const quarantined = readdirSync(join(dir, ".data")).filter((f) => f.includes(".corrupt."));
  assert.equal(quarantined.length, 1, "the unreadable file was not preserved");
  assert.match(readFileSync(join(dir, ".data", quarantined[0]), "utf-8"), /not json/);

  // And a subsequent write must not have clobbered it.
  s.markKernelDeployed(KERNEL);
  assert.equal(readdirSync(join(dir, ".data")).filter((f) => f.includes(".corrupt.")).length, 1);
});

test("a missing store is silent — that is a normal first boot", async () => {
  const s = await freshStore();
  assert.equal(s.kernelDeployedLoadFailed(), false);
});

// ── #273: a cached read may CONFIRM a signer, never CONDEMN one ──────────────
//
// The live incident: a sibling device's session traffic keeps the owner cache
// warm with the PRE-rotation owner; recovery rotates the owner on-chain and the
// new key's first delegation arrives seconds later — inside the TTL. Deciding
// the rejection from cache locked the legitimate new owner out ("Invalid
// signature") for the cache lifetime, un-healable by any number of retries.

const KERNEL_A = "0x3333333333333333333333333333333333333333";
const OLD_KEY = "0xcccc000000000000000000000000000000000003";
const NEW_KEY = "0xdddd000000000000000000000000000000000004";

async function ownerModule() {
  const m = await import("../src/lib/auth/kernel-owner.js");
  m._resetOwnerCacheForTests();
  return m;
}

test("#273: the rotated-in key passes on first contact despite a warm stale cache", async () => {
  const m = await ownerModule();
  let chainOwner: string = OLD_KEY;
  let fetches = 0;
  m._setOwnerFetchForTests(async () => {
    fetches++;
    return chainOwner;
  });
  try {
    // Sibling traffic warms the cache with the pre-rotation owner…
    assert.equal(await m.isKernelOwner(OLD_KEY, KERNEL_A), true);
    assert.equal(fetches, 1);
    // …the ceremony rotates the owner on-chain…
    chainOwner = NEW_KEY;
    // …and the new key's first delegation must NOT be decided by the cache.
    assert.equal(await m.isKernelOwner(NEW_KEY, KERNEL_A), true, "rotated-in key condemned from cache");
    assert.equal(fetches, 2, "a cache-decided rejection must re-read live");
  } finally {
    m._setOwnerFetchForTests(null);
  }
});

test("#273: a cached match still confirms with no extra chain read", async () => {
  const m = await ownerModule();
  let fetches = 0;
  m._setOwnerFetchForTests(async () => {
    fetches++;
    return OLD_KEY;
  });
  try {
    assert.equal(await m.isKernelOwner(OLD_KEY, KERNEL_A), true);
    assert.equal(await m.isKernelOwner(OLD_KEY, KERNEL_A), true);
    assert.equal(fetches, 1, "steady-state traffic must stay off the RPC");
  } finally {
    m._setOwnerFetchForTests(null);
  }
});

test("#273: a FRESH mismatch is decided once — no doubled read", async () => {
  const m = await ownerModule();
  let fetches = 0;
  m._setOwnerFetchForTests(async () => {
    fetches++;
    return OLD_KEY;
  });
  try {
    assert.equal(await m.isKernelOwner(NEW_KEY, KERNEL_A), false);
    assert.equal(fetches, 1, "the answer was already live; re-reading buys nothing");
  } finally {
    m._setOwnerFetchForTests(null);
  }
});

test("#200: the refresh retires the rotated-out key at first contact, not at TTL", async () => {
  const m = await ownerModule();
  let chainOwner: string = OLD_KEY;
  m._setOwnerFetchForTests(async () => chainOwner);
  try {
    assert.equal(await m.isKernelOwner(OLD_KEY, KERNEL_A), true); // warm: OLD
    chainOwner = NEW_KEY; // rotation
    assert.equal(await m.isKernelOwner(NEW_KEY, KERNEL_A), true); // heal refreshes cache to NEW
    // The old key's next request now mismatches the REFRESHED cache, re-reads,
    // and is refused — no ≤TTL grace left.
    assert.equal(await m.isKernelOwner(OLD_KEY, KERNEL_A), false);
  } finally {
    m._setOwnerFetchForTests(null);
  }
});
