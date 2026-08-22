/**
 * After recovery rotates a Kernel's owner, the previous key must stop
 * authenticating (#200).
 *
 * The live on-chain owner decides that, and it decides it correctly whenever the
 * read succeeds AND is current. Two gaps were closed in turn:
 *
 *  - The read FAILING: both "provably no owner" and "could not reach the chain"
 *    fell through to a counterfactual address match, and the Kernel address is
 *    CREATE2-derived from the original owner's init data — so the rotated-out key
 *    satisfies it forever. An account that has never been seen with an on-chain
 *    owner keeps the fallback, because for it the fallback IS the mechanism. An
 *    account that has been seen with one refuses.
 *
 *  - The read being STALE: a read that merely succeeded was taken as current, so
 *    a lagging replica naming the retired owner — asked on every retired-key
 *    request by the #273 re-read — rolled the cache back and readmitted the key
 *    for another cache lifetime. Reads now carry the L2 block they executed at,
 *    and one that names a different owner from a block no later than the last
 *    observed change is discarded (kernel-owner-ordering.ts).
 *
 * The durability tests are the ones that matter most in practice: the record is
 * what a failed read consults and what a stale read is judged against, and a
 * deploy restarts the process. If it did not survive that, the windows would
 * reopen on every release with nothing to notice.
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
const OWNER_EOA = "0xaaaa000000000000000000000000000000000001";
const OTHER_EOA = "0xbbbb000000000000000000000000000000000002";

test("an unseen Kernel is not known-deployed, so the fallback still applies", async () => {
  const s = await freshStore();
  assert.equal(s.isKernelKnownDeployed(KERNEL), false);
  assert.equal(s.getKernelOwnerRecord(KERNEL), undefined);
});

test("recording an owner marks it known-deployed, and only it", async () => {
  const s = await freshStore();
  s.recordKernelOwner(KERNEL, OWNER_EOA, 100);
  assert.equal(s.isKernelKnownDeployed(KERNEL), true);
  assert.equal(s.isKernelKnownDeployed(OTHER), false);
  assert.deepEqual(s.getKernelOwnerRecord(KERNEL), { owner: OWNER_EOA, block: 100 });
});

test("the address is matched case-insensitively", async () => {
  // Kernel addresses arrive checksummed from viem and lowercased from the auth
  // middleware; a case mismatch here would silently fail open.
  const s = await freshStore();
  s.recordKernelOwner(KERNEL.toUpperCase().replace("0X", "0x"), OWNER_EOA.toUpperCase().replace("0X", "0x"), 100);
  assert.equal(s.isKernelKnownDeployed(KERNEL), true);
  assert.deepEqual(s.getKernelOwnerRecord(KERNEL), { owner: OWNER_EOA, block: 100 });
});

test("the record survives a restart — a deploy must not reopen the window", async () => {
  const s1 = await freshStore();
  s1.recordKernelOwner(KERNEL, OWNER_EOA, 100);
  assert.ok(existsSync(join(dir, ".data", "kernel-deployed.json")), "nothing was persisted");

  // Fresh module instance, same cwd — models the process restart a deploy performs.
  const s2 = await freshStore();
  assert.equal(s2.isKernelKnownDeployed(KERNEL), true, "the record did not survive reload");
  // The ORDER survives too: it is what a stale read after the restart is judged against.
  assert.deepEqual(s2.getKernelOwnerRecord(KERNEL), { owner: OWNER_EOA, block: 100 });
});

test("the file is written 0600 — it is under .data with the revocation state", async () => {
  const s = await freshStore();
  s.recordKernelOwner(KERNEL, OWNER_EOA, 100);
  const { mode } = await import("node:fs").then((fs) =>
    fs.statSync(join(dir, ".data", "kernel-deployed.json")),
  );
  assert.equal(mode & 0o777, 0o600);
});

test("re-recording keeps the first-observed timestamp and advances owner/block", async () => {
  const s = await freshStore();
  s.recordKernelOwner(KERNEL, OWNER_EOA, 100);
  const first = JSON.parse(readFileSync(join(dir, ".data", "kernel-deployed.json"), "utf-8"));
  s.recordKernelOwner(KERNEL, OTHER_EOA, 200);
  const second = JSON.parse(readFileSync(join(dir, ".data", "kernel-deployed.json"), "utf-8"));
  assert.equal(second.kernels[KERNEL].firstSeen, first.kernels[KERNEL].firstSeen, "first-observed timestamp was rewritten");
  assert.equal(second.kernels[KERNEL].owner, OTHER_EOA);
  assert.equal(second.kernels[KERNEL].block, 200);
  assert.equal(second.version, 2);
});

test("a v1 file (#208 shape) loads as known-deployed with no ordered record, and is not CRITICAL", async () => {
  // The VM carries v1 entries. They must keep refusing the counterfactual
  // fallback for those accounts, and they must not land in the quarantine branch.
  mkdirSync(join(dir, ".data"), { recursive: true });
  writeFileSync(
    join(dir, ".data", "kernel-deployed.json"),
    JSON.stringify({ version: 1, kernels: { [KERNEL]: "2026-08-09T14:47:03.976Z" } }),
  );
  const s = await freshStore();
  assert.equal(s.kernelDeployedLoadFailed(), false);
  assert.equal(s.isKernelKnownDeployed(KERNEL), true);
  assert.equal(s.getKernelOwnerRecord(KERNEL), undefined, "v1 knew no owner/block — must not invent one");
  // The next fresh read fills in the order; firstSeen carries over.
  s.recordKernelOwner(KERNEL, OWNER_EOA, 100);
  const after = JSON.parse(readFileSync(join(dir, ".data", "kernel-deployed.json"), "utf-8"));
  assert.equal(after.version, 2);
  assert.equal(after.kernels[KERNEL].firstSeen, "2026-08-09T14:47:03.976Z");
  assert.deepEqual(s.getKernelOwnerRecord(KERNEL), { owner: OWNER_EOA, block: 100 });
});

test("an unreadable store fails OPEN, not closed", async () => {
  // A corrupt or unreadable file leaves the set empty, so the counterfactual
  // fallback resumes. That is deliberate and worth pinning: refusing every
  // deployed account because a file would not parse trades one narrow window for
  // a total outage. It is also why the file must be on the survives-restarts list.
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
  s.recordKernelOwner(KERNEL, OWNER_EOA, 1);
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
//
// These go through the real `isKernelOwner` with the chain read replaced by a
// scripted one. `kernel-owner.ts` imports the store statically, so the instance
// it consults is the plain module (not `freshStore`'s per-test copy): each test
// resets it and uses its OWN Kernel address so nothing carries across.

const OLD_KEY = "0xcccc000000000000000000000000000000000003";
const NEW_KEY = "0xdddd000000000000000000000000000000000004";

async function ownerModule() {
  const m = await import("../src/lib/auth/kernel-owner.js");
  m._resetOwnerCacheForTests();
  const store = await import("../src/lib/auth/kernel-deployed.js");
  store._resetKernelDeployedForTests();
  return m;
}

test("#273: the rotated-in key passes on first contact despite a warm stale cache", async () => {
  const KERNEL_A = "0x3333333333333333333333333333333333333333";
  const m = await ownerModule();
  let chain = { owner: OLD_KEY, block: 100 };
  let fetches = 0;
  m._setOwnerFetchForTests(async () => {
    fetches++;
    return chain;
  });
  try {
    // Sibling traffic warms the cache with the pre-rotation owner…
    assert.equal(await m.isKernelOwner(OLD_KEY, KERNEL_A), true);
    assert.equal(fetches, 1);
    // …the ceremony rotates the owner on-chain…
    chain = { owner: NEW_KEY, block: 200 };
    // …and the new key's first delegation must NOT be decided by the cache.
    assert.equal(await m.isKernelOwner(NEW_KEY, KERNEL_A), true, "rotated-in key condemned from cache");
    assert.equal(fetches, 2, "a cache-decided rejection must re-read live");
  } finally {
    m._setOwnerFetchForTests(null);
  }
});

test("#273: a cached match still confirms with no extra chain read", async () => {
  const KERNEL_B = "0x4444444444444444444444444444444444444444";
  const m = await ownerModule();
  let fetches = 0;
  m._setOwnerFetchForTests(async () => {
    fetches++;
    return { owner: OLD_KEY, block: 100 };
  });
  try {
    assert.equal(await m.isKernelOwner(OLD_KEY, KERNEL_B), true);
    assert.equal(await m.isKernelOwner(OLD_KEY, KERNEL_B), true);
    assert.equal(fetches, 1, "steady-state traffic must stay off the RPC");
  } finally {
    m._setOwnerFetchForTests(null);
  }
});

// ── #200: a stale read cannot roll the owner back ────────────────────────────
//
// The path the earlier rounds did not name. After the cache refreshes to the new
// owner, EVERY retired-key request triggers the #273 re-read — and a replica
// lagging behind the recovery answers with the retired owner. Taken as current,
// that answer re-poisons the cache for another TTL, reachable as often as the
// retired key cares to try. The read now carries its block, and the order decides.

test("#200: a lagging replica naming the retired owner is discarded, and the cache stays on the new owner", async () => {
  const KERNEL_C = "0x5555555555555555555555555555555555555555";
  const m = await ownerModule();
  const script: Array<{ owner: string | null; block: number }> = [];
  let fetches = 0;
  m._setOwnerFetchForTests(async () => {
    fetches++;
    const next = script.shift();
    if (!next) throw new Error("unexpected fetch");
    return next;
  });
  try {
    // 1. Steady state: OLD owns it, read at block 100.
    script.push({ owner: OLD_KEY, block: 100 });
    assert.equal(await m.isKernelOwner(OLD_KEY, KERNEL_C), true);

    // 2. Recovery rotates to NEW; the new key's first request forces a re-read
    //    that lands on a caught-up replica (block 200). Rotation observed.
    script.push({ owner: NEW_KEY, block: 200 });
    assert.equal(await m.isKernelOwner(NEW_KEY, KERNEL_C), true);
    assert.equal(fetches, 2);

    // 3. The retired key tries. Cache says NEW → cache-decided rejection → re-read
    //    hits a LAGGING replica still at block 150, which says OLD. Before this
    //    change that answer was cached and OLD was let in. Now it is stale.
    script.push({ owner: OLD_KEY, block: 150 });
    assert.equal(await m.isKernelOwner(OLD_KEY, KERNEL_C), false, "retired key readmitted by a lagging replica");
    assert.equal(fetches, 3);

    // 4. And the cache was NOT rolled back: the new owner confirms from cache
    //    with no further read, and the retired key's next attempt re-reads again
    //    (a wrong-key attempt pays one eth_call — the #273 rule) and is refused
    //    even by a caught-up replica.
    assert.equal(await m.isKernelOwner(NEW_KEY, KERNEL_C), true);
    assert.equal(fetches, 3, "the cache was poisoned — the new owner had to re-read");
    script.push({ owner: NEW_KEY, block: 210 });
    assert.equal(await m.isKernelOwner(OLD_KEY, KERNEL_C), false);
  } finally {
    m._setOwnerFetchForTests(null);
  }
});

test("#200: a same-owner read from an earlier block is accepted — steady-state jitter never refuses", async () => {
  const KERNEL_D = "0x6666666666666666666666666666666666666666";
  const m = await ownerModule();
  const script: Array<{ owner: string | null; block: number }> = [];
  m._setOwnerFetchForTests(async () => {
    const next = script.shift();
    if (!next) throw new Error("unexpected fetch");
    return next;
  });
  try {
    script.push({ owner: OLD_KEY, block: 100 });
    assert.equal(await m.isKernelOwner(OLD_KEY, KERNEL_D), true);
    // Cache expires; the next read comes from a replica a few blocks behind the
    // first one but agreeing on the owner. That contradicts nothing.
    m._resetOwnerCacheForTests();
    script.push({ owner: OLD_KEY, block: 95 });
    assert.equal(await m.isKernelOwner(OLD_KEY, KERNEL_D), true, "agreeing lag was refused");
  } finally {
    m._setOwnerFetchForTests(null);
  }
});

test("#200: re-admission — an owner rotated out can be rotated back in at a later block", async () => {
  // web3auth → passkey → web3auth. The second rotation names the FIRST owner
  // again; a "retired set" would refuse it forever. The order admits it, and a
  // lagging read naming the middle owner after that is stale.
  const KERNEL_E = "0x7777777777777777777777777777777777777777";
  const m = await ownerModule();
  const script: Array<{ owner: string | null; block: number }> = [];
  m._setOwnerFetchForTests(async () => {
    const next = script.shift();
    if (!next) throw new Error("unexpected fetch");
    return next;
  });
  try {
    script.push({ owner: OLD_KEY, block: 100 });
    assert.equal(await m.isKernelOwner(OLD_KEY, KERNEL_E), true);
    script.push({ owner: NEW_KEY, block: 200 });
    assert.equal(await m.isKernelOwner(NEW_KEY, KERNEL_E), true);
    script.push({ owner: OLD_KEY, block: 300 });
    assert.equal(await m.isKernelOwner(OLD_KEY, KERNEL_E), true, "legitimate re-admission refused");
    // NEW is now the retired one; a replica lagging at 250 still names it.
    script.push({ owner: NEW_KEY, block: 250 });
    assert.equal(await m.isKernelOwner(NEW_KEY, KERNEL_E), false, "retired middle owner readmitted by a lagging replica");
  } finally {
    m._setOwnerFetchForTests(null);
  }
});

test("#200: the observed order survives a restart — a stale read after a deploy is still discarded", async () => {
  // The rotation is recorded through the store kernel-owner.ts consults; reload
  // that store from disk (what a restart does) and judge a lagging read against it.
  const KERNEL_F = "0x8888888888888888888888888888888888888888";
  const m = await ownerModule();
  const store = await import("../src/lib/auth/kernel-deployed.js");
  const script: Array<{ owner: string | null; block: number }> = [];
  m._setOwnerFetchForTests(async () => {
    const next = script.shift();
    if (!next) throw new Error("unexpected fetch");
    return next;
  });
  try {
    script.push({ owner: OLD_KEY, block: 100 });
    assert.equal(await m.isKernelOwner(OLD_KEY, KERNEL_F), true);
    script.push({ owner: NEW_KEY, block: 200 });
    assert.equal(await m.isKernelOwner(NEW_KEY, KERNEL_F), true);
    assert.deepEqual(store.getKernelOwnerRecord(KERNEL_F), { owner: NEW_KEY, block: 200 });

    // Restart: in-memory cache and store gone; the store reloads from disk.
    m._resetOwnerCacheForTests();
    store._resetKernelDeployedForTests();
    assert.deepEqual(store.getKernelOwnerRecord(KERNEL_F), { owner: NEW_KEY, block: 200 }, "the order did not survive reload");

    // First read after the restart comes from a lagging replica naming the retired owner.
    script.push({ owner: OLD_KEY, block: 150 });
    assert.equal(await m.isKernelOwner(OLD_KEY, KERNEL_F), false, "stale read accepted after restart");
  } finally {
    m._setOwnerFetchForTests(null);
  }
});
