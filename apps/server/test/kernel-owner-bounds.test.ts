/**
 * The Kernel-owner read path is bounded (#163, #210).
 *
 * `verifyDelegation` runs before any authorization, so everything the owner
 * check keys on is caller-chosen and every cache miss is an eth_call on the RPC
 * the payment path shares. The properties pinned here are the ones an attacker
 * varying `message.parent` would otherwise exploit:
 *
 *   - a store record is CREATED only by a confirmed read (the chain named the key
 *     that presented), so foreign Kernels never land in `kernel-deployed.json`;
 *   - an existing record is still UPDATED by any fresh read (a retired key's own
 *     request retires it);
 *   - both in-memory caches are capped;
 *   - a failed read is NOT remembered server-side (rejected design, pinned);
 *   - concurrent requests for one Kernel share one chain read;
 *   - a read happens only if the caller's per-client budget allows it, and over
 *     budget can only WITHHOLD (refuse for known-deployed, counterfactual for
 *     unknown) — never grant.
 *
 * And the one that must stay true through all of it: nothing here can
 * manufacture access.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cwd = process.cwd();
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "woco-kernel-bounds-"));
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

const OWNER = "0xaaaa000000000000000000000000000000000001";
const OTHER = "0xbbbb000000000000000000000000000000000002";
const NEW_OWNER = "0xcccc000000000000000000000000000000000003";
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

async function mods() {
  const owner = await import("../src/lib/auth/kernel-owner.js");
  const store = await import("../src/lib/auth/kernel-deployed.js");
  owner._resetOwnerCacheForTests();
  store._resetKernelDeployedForTests();
  return { owner, store };
}

// ── #210: who gets a record ──────────────────────────────────────────────────

test("#210: a read of a foreign Kernel (owner ≠ presenter) creates NO store record", async () => {
  const { owner, store } = await mods();
  const K = "0x1010101010101010101010101010101010101010";
  let fetches = 0;
  owner._setOwnerFetchForTests(async () => {
    fetches++;
    return { owner: OTHER, block: 100 };
  });
  try {
    // An attacker presenting any key for someone else's deployed Kernel: refused,
    // and the store does not learn the Kernel exists.
    assert.equal(await owner.isKernelOwner(OWNER, K), false);
    assert.equal(fetches, 1);
    assert.equal(store.isKernelKnownDeployed(K), false, "foreign Kernel was recorded");
    assert.equal(store.getKernelOwnerRecord(K), undefined);
  } finally {
    owner._setOwnerFetchForTests(null);
  }
});

test("#210: a CONFIRMED read (owner == presenter) creates the record", async () => {
  const { owner, store } = await mods();
  const K = "0x1111111111111111111111111111111111111111";
  owner._setOwnerFetchForTests(async () => ({ owner: OWNER, block: 100 }));
  try {
    assert.equal(await owner.isKernelOwner(OWNER, K), true);
    assert.equal(store.isKernelKnownDeployed(K), true);
    assert.deepEqual(store.getKernelOwnerRecord(K), { owner: OWNER, block: 100 });
  } finally {
    owner._setOwnerFetchForTests(null);
  }
});

test("#210: an EXISTING record is still updated by an unconfirmed read — the retired key retires itself", async () => {
  const { owner, store } = await mods();
  const K = "0x1212121212121212121212121212121212121212";
  let chain = { owner: OWNER, block: 100 };
  owner._setOwnerFetchForTests(async () => chain);
  try {
    assert.equal(await owner.isKernelOwner(OWNER, K), true); // record {OWNER,100}
    chain = { owner: NEW_OWNER, block: 200 }; // recovery rotates
    owner._resetOwnerCacheForTests(); // cache expired; the OLD key comes back
    assert.equal(await owner.isKernelOwner(OWNER, K), false, "retired key passed");
    // The read was unconfirmed (presenter OWNER, chain NEW_OWNER) but the record
    // already existed, so the rotation was recorded.
    assert.deepEqual(store.getKernelOwnerRecord(K), { owner: NEW_OWNER, block: 200 });
  } finally {
    owner._setOwnerFetchForTests(null);
  }
});

test("#210: the 6492-gate read path (no presenter) never creates a record", async () => {
  const { owner, store } = await mods();
  const K = "0x1313131313131313131313131313131313131313";
  owner._setOwnerFetchForTests(async () => ({ owner: OTHER, block: 100 }));
  try {
    assert.equal(await owner.readKernelOwner(K), OTHER); // the live owner is still reported…
    assert.equal(store.isKernelKnownDeployed(K), false); // …but not remembered
  } finally {
    owner._setOwnerFetchForTests(null);
  }
});

test("#210: recording an identical record is a no-op (no rewrite)", async () => {
  // A fresh store instance, so its .data dir is THIS test's cwd (the statically
  // imported one is pinned to whichever cwd first loaded it).
  const store = (await import(`../src/lib/auth/kernel-deployed.js?t=${Math.random()}`)) as typeof import("../src/lib/auth/kernel-deployed.js");
  store._resetKernelDeployedForTests();
  const K = "0x1414141414141414141414141414141414141414";
  const { statSync } = await import("node:fs");
  store.recordKernelOwner(K, OWNER, 100);
  const file = join(dir, ".data", "kernel-deployed.json");
  const m1 = statSync(file).mtimeMs;
  await new Promise((r) => setTimeout(r, 15));
  store.recordKernelOwner(K, OWNER, 100);
  assert.equal(statSync(file).mtimeMs, m1, "an unchanged record was rewritten");
});

// ── #163: caps, negative cache, in-flight dedupe ─────────────────────────────

test("#163: the owner cache is capped — varying the parent cannot grow it without bound", async () => {
  const { owner } = await mods();
  owner._setOwnerFetchForTests(async () => ({ owner: null, block: 1 }));
  try {
    for (let i = 1; i <= 5_200; i++) await owner.readKernelOwner(addr(0x20000 + i));
    assert.ok(owner._cacheSizesForTests().owner <= 5_000, `owner cache grew to ${owner._cacheSizesForTests().owner}`);
  } finally {
    owner._setOwnerFetchForTests(null);
  }
});

test("#163: a failed read is NOT remembered server-side — the very next request asks the chain again", async () => {
  // Rejected design, pinned so it is not re-added: client.ts already throttles a
  // client after a double failure, and any server-side negative window would
  // defeat its single IMMEDIATE retry on a sub-second RPC blip — turning a blip
  // into the #256 "session ended" banner. Upstream load during an outage is
  // bounded by the per-client budget and the shared in-flight read instead.
  const { owner, store } = await mods();
  const K = "0x1515151515151515151515151515151515151515";
  store.recordKernelOwner(K, OWNER, 100); // known-deployed, so "error" → refuse
  let fetches = 0;
  let chain: { owner: string; block: number } | "error" = "error";
  owner._setOwnerFetchForTests(async () => {
    fetches++;
    return chain;
  });
  try {
    assert.equal(await owner.isKernelOwner(OWNER, K), false);
    assert.equal(fetches, 1);
    // The blip clears; the client's immediate retry must succeed.
    chain = { owner: OWNER, block: 101 };
    assert.equal(await owner.isKernelOwner(OWNER, K), true, "a cleared blip was still refused");
    assert.equal(fetches, 2);
  } finally {
    owner._setOwnerFetchForTests(null);
  }
});

test("#210: a cache hit that confirms a presenter records the account when the store has none", async () => {
  // Someone else's UNCONFIRMED read fills the cache (no record); the legitimate
  // owner arrives inside the TTL and is confirmed from cache. They must still be
  // recorded — otherwise an unreadable chain after the cache expires would fall
  // back to the counterfactual for a Kernel we have in fact seen with an owner.
  const { owner, store } = await mods();
  const K = "0x1919191919191919191919191919191919191919";
  let fetches = 0;
  owner._setOwnerFetchForTests(async () => {
    fetches++;
    return { owner: OWNER, block: 100 };
  });
  try {
    assert.equal(await owner.isKernelOwner(OTHER, K), false); // unconfirmed: cache filled, no record
    assert.equal(store.isKernelKnownDeployed(K), false);
    assert.equal(await owner.isKernelOwner(OWNER, K), true); // confirmed FROM CACHE
    assert.equal(fetches, 1, "the confirmation should have come from cache");
    assert.deepEqual(store.getKernelOwnerRecord(K), { owner: OWNER, block: 100 }, "cache-hit confirmation left no record");
  } finally {
    owner._setOwnerFetchForTests(null);
  }
});

test("#163: concurrent requests for one Kernel share a single chain read", async () => {
  const { owner } = await mods();
  const K = "0x1616161616161616161616161616161616161616";
  let fetches = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  owner._setOwnerFetchForTests(async () => {
    fetches++;
    await gate;
    return { owner: OWNER, block: 100 };
  });
  try {
    const results = Promise.all([
      owner.isKernelOwner(OWNER, K),
      owner.isKernelOwner(OWNER, K),
      owner.isKernelOwner(OWNER, K),
    ]);
    release();
    assert.deepEqual(await results, [true, true, true]);
    assert.equal(fetches, 1, "a burst for one Kernel fanned out to the RPC");
  } finally {
    owner._setOwnerFetchForTests(null);
  }
});

// ── #163/#210: the per-client read budget ────────────────────────────────────

test("budget: a client gets its window of reads, then is refused until the window rolls", async () => {
  const b = await import("../src/lib/auth/owner-read-budget.js");
  b._resetOwnerReadBudgetForTests();
  let t = 1_000_000;
  b._setOwnerReadBudgetClockForTests(() => t);
  try {
    let allowed = 0;
    for (let i = 0; i < 200; i++) if (b.takeOwnerReadBudget("1.2.3.4")) allowed++;
    assert.equal(allowed, 120);
    assert.equal(b.takeOwnerReadBudget("1.2.3.4"), false);
    // Another client is unaffected.
    assert.equal(b.takeOwnerReadBudget("5.6.7.8"), true);
    // The window rolls.
    t += 60_001;
    assert.equal(b.takeOwnerReadBudget("1.2.3.4"), true);
  } finally {
    b._setOwnerReadBudgetClockForTests(null);
    b._resetOwnerReadBudgetForTests();
  }
});

test("budget: the tracked-client map is itself bounded, and sweeps expired windows", async () => {
  const b = await import("../src/lib/auth/owner-read-budget.js");
  b._resetOwnerReadBudgetForTests();
  let t = 1_000_000;
  b._setOwnerReadBudgetClockForTests(() => t);
  try {
    for (let i = 0; i < 10_000; i++) assert.equal(b.takeOwnerReadBudget(`c${i}`), true);
    assert.equal(b.ownerReadBudgetTrackedClients(), 10_000);
    // Saturated inside the window: a newcomer is still admitted — the oldest
    // window is evicted for it — and the map does not grow past the cap.
    assert.equal(b.takeOwnerReadBudget("newcomer"), true);
    assert.equal(b.ownerReadBudgetTrackedClients(), 10_000);
    // Once the window passes, the sweep makes room without eviction.
    t += 60_001;
    assert.equal(b.takeOwnerReadBudget("newcomer2"), true);
    assert.ok(b.ownerReadBudgetTrackedClients() < 10_000);
  } finally {
    b._setOwnerReadBudgetClockForTests(null);
    b._resetOwnerReadBudgetForTests();
  }
});

test("budget: over budget, a known-deployed account is REFUSED without a chain read — and a cache hit costs nothing", async () => {
  const { owner, store } = await mods();
  const K = "0x1717171717171717171717171717171717171717";
  store.recordKernelOwner(K, OWNER, 100);
  let fetches = 0;
  owner._setOwnerFetchForTests(async () => {
    fetches++;
    return { owner: OWNER, block: 100 };
  });
  try {
    // Denied: no read, and for a known-deployed account that means refuse.
    assert.equal(await owner.isKernelOwner(OWNER, K, { chainReadAllowed: () => false }), false);
    assert.equal(fetches, 0, "a denied budget still reached the chain");
    // Allowed: reads, confirms, and caches.
    assert.equal(await owner.isKernelOwner(OWNER, K, { chainReadAllowed: () => true }), true);
    assert.equal(fetches, 1);
    // Cache hit: the budget is not even consulted.
    let consulted = 0;
    assert.equal(
      await owner.isKernelOwner(OWNER, K, {
        chainReadAllowed: () => {
          consulted++;
          return false;
        },
      }),
      true,
    );
    assert.equal(consulted, 0, "a cache hit drew on the budget");
    assert.equal(fetches, 1);
  } finally {
    owner._setOwnerFetchForTests(null);
  }
});

test("budget: the gate can only withhold — a denied read never grants what the chain would have refused", async () => {
  const { owner, store } = await mods();
  const K = "0x1818181818181818181818181818181818181818";
  store.recordKernelOwner(K, OWNER, 100);
  owner._setOwnerFetchForTests(async () => ({ owner: OWNER, block: 100 }));
  try {
    // A wrong key, denied the read: refused (known-deployed + "error").
    assert.equal(await owner.isKernelOwner(OTHER, K, { chainReadAllowed: () => false }), false);
    // The same wrong key, allowed the read: still refused — the chain says OWNER.
    assert.equal(await owner.isKernelOwner(OTHER, K, { chainReadAllowed: () => true }), false);
  } finally {
    owner._setOwnerFetchForTests(null);
  }
});

test("budget: the middleware draws on it only when verification reaches the chain", async () => {
  // Plain-EOA parents verify by local ecrecover and never touch the owner path,
  // so a flood of EOA-signed requests must not spend a single unit.
  const b = await import("../src/lib/auth/owner-read-budget.js");
  b._resetOwnerReadBudgetForTests();
  const { Wallet } = await import("ethers");
  const { SESSION_DOMAIN, SESSION_TYPES, SESSION_PURPOSE, SESSION_EXPIRY_MS } = await import("@woco/shared");
  const { verifyDelegation } = await import("../src/lib/auth/verify-delegation.js");
  const parent = Wallet.createRandom();
  const session = Wallet.createRandom();
  const host = "test.woco.local";
  const nonce = "n-1";
  const message = {
    host,
    parent: parent.address,
    session: session.address,
    purpose: SESSION_PURPOSE,
    nonce,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_EXPIRY_MS).toISOString(),
    sessionProof: await session.signMessage(`${host}:${nonce}`),
    clientCodeHash: "0x" + "00".repeat(32),
    statement: `Authorize ${session.address} as session key for ${host}`,
  };
  const parentSig = await parent.signTypedData(SESSION_DOMAIN, SESSION_TYPES as never, message);
  let consulted = 0;
  const r = await verifyDelegation({ message, parentSig } as never, session.address, [host], {
    chainReadAllowed: () => {
      consulted++;
      return true;
    },
  });
  assert.equal(r.valid, true);
  assert.equal(consulted, 0, "an EOA delegation consulted the read budget");
});
