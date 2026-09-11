/**
 * "No route read older than what this device has already seen" (#510).
 *
 * THE SEQUENCE THIS PINS — the residual #505 left open. A user adds backup A. The
 * "Backup added" screen is terminal, so adding B ALWAYS remounts the panel, and the
 * panel's own mount-time read is answered by a replica that has not seen A's
 * install. It reports `absent`, honestly, from where it is standing. The panel then
 * shows "not protected", passes `expectInstalled: false`, and #505's guard — which
 * only ever refuses a read that RETRACTS what the panel listed — has nothing to
 * protect. `absent` maps to `install`, an install SETS the hook's set to exactly the
 * new guardian, and A is gone while the user is told it worked.
 *
 * The fix: every recovery write already knows the block its userOp landed in, so
 * remember it; every later read is pinned at a block at or after it. A replica that
 * lacks the block ERRORS, which surfaces as "couldn't load" — never as `absent`.
 *
 * Tested here as the pure/injectable functions they are, plus source pins for the
 * two call sites this tsx suite cannot execute (a Svelte runes store, and a module
 * that loads viem + the ZeroDev SDK) — same device as `backup-add-stale-read.test.ts`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  decidePinnedBlock,
  readRouteNoOlderThan,
  rememberLandingBlock,
  rememberedLandingBlock,
  type PinnedRouteReadDeps,
} from "../src/lib/auth/recovery-landing-block.js";

// --- a localStorage that behaves, and one that does not ---------------------

function installStorage(impl: { getItem(k: string): string | null; setItem(k: string, v: string): void }): void {
  Object.defineProperty(globalThis, "localStorage", { value: impl, configurable: true, writable: true });
}

function workingStorage(): Map<string, string> {
  const store = new Map<string, string>();
  installStorage({
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, v),
  });
  return store;
}

function throwingStorage(): void {
  installStorage({
    getItem() { throw new DOMException("blocked", "SecurityError"); },
    setItem() { throw new DOMException("blocked", "SecurityError"); },
  });
}

/** Unique per test: the module keeps an in-memory mirror that outlives one test. */
let n = 0;
const freshKernel = (): string => `0x${(++n).toString(16).padStart(40, "a")}`;

// --- decidePinnedBlock ------------------------------------------------------

test("no remembered block: pin whatever head the RPC reports", () => {
  assert.deepEqual(decidePinnedBlock({ head: 100n, minBlock: null }), { pin: 100n });
});

test("a head BELOW the remembered block is a replica standing before a change we saw", () => {
  assert.deepEqual(decidePinnedBlock({ head: 99n, minBlock: 100n }), { lagging: true });
});

test("head exactly AT the bound is fine — that block contains the change", () => {
  assert.deepEqual(decidePinnedBlock({ head: 100n, minBlock: 100n }), { pin: 100n });
});

test("head ABOVE the bound pins the HEAD, never the bound itself", () => {
  // Pinning at `minBlock` would read state AS OF the old block and hide every later
  // change — a removal made on another device would read back as still-installed.
  assert.deepEqual(decidePinnedBlock({ head: 140n, minBlock: 100n }), { pin: 140n });
});

// --- the landing-block memory ----------------------------------------------

test("the bound is monotonic: a lower block never lowers it", () => {
  workingStorage();
  const k = freshKernel();
  rememberLandingBlock(k, 100n);
  rememberLandingBlock(k, 40n);
  assert.equal(rememberedLandingBlock(k), 100n, "seeing something newer cannot unsee the older change");
  rememberLandingBlock(k, 101n);
  assert.equal(rememberedLandingBlock(k), 101n);
});

test("one bound per account — two accounts on a device do not lend each other one", () => {
  workingStorage();
  const a = freshKernel();
  const b = freshKernel();
  rememberLandingBlock(a, 500n);
  assert.equal(rememberedLandingBlock(a), 500n);
  assert.equal(rememberedLandingBlock(b), null, "an untouched account must demand nothing");
});

test("the key is case-insensitive — the same account written either way is one bound", () => {
  workingStorage();
  const k = freshKernel();
  rememberLandingBlock(k.toUpperCase().replace("0X", "0x"), 700n);
  assert.equal(rememberedLandingBlock(k), 700n);
});

test("a browser that refuses storage still holds the bound for this session", () => {
  throwingStorage();
  const k = freshKernel();
  rememberLandingBlock(k, 900n); // must not throw out of the write path
  assert.equal(rememberedLandingBlock(k), 900n, "the tab that just added a backup is the likeliest to add a second");
});

test("garbage in the slot is no bound, not a crash", () => {
  const store = workingStorage();
  const k = freshKernel();
  store.set(`woco:recovery:landing-block:${k.toLowerCase()}`, "not-a-number");
  assert.equal(rememberedLandingBlock(k), null);
});

test("another tab's later write wins over this tab's memo", () => {
  const store = workingStorage();
  const k = freshKernel();
  rememberLandingBlock(k, 100n);
  store.set(`woco:recovery:landing-block:${k.toLowerCase()}`, "250"); // the other tab
  assert.equal(rememberedLandingBlock(k), 250n);
});

// --- readRouteNoOlderThan ---------------------------------------------------

const INSTALLED_WOCO = { state: "installed" as const, deployed: true, hookKind: "woco" as const };

function spyDeps(over: Partial<PinnedRouteReadDeps> = {}): {
  deps: PinnedRouteReadDeps;
  routeCalls: (bigint | undefined)[];
  setCalls: (bigint | undefined)[];
} {
  const routeCalls: (bigint | undefined)[] = [];
  const setCalls: (bigint | undefined)[] = [];
  const deps: PinnedRouteReadDeps = {
    headBlock: async () => 200n,
    readRoute: async (_k, at) => { routeCalls.push(at); return INSTALLED_WOCO; },
    readSet: async (_k, at) => { setCalls.push(at); return { state: "read", guardians: ["0xa"] }; },
    ...over,
  };
  return { deps, routeCalls, setCalls };
}

test("a lagging RPC is reported as unreadable and is NEVER asked about the route", () => {
  workingStorage();
  const k = freshKernel();
  rememberLandingBlock(k, 300n);
  const { deps, routeCalls, setCalls } = spyDeps({ headBlock: async () => 299n });
  return readRouteNoOlderThan(k, deps).then((r) => {
    assert.deepEqual(r, { route: { state: "unknown" }, set: null, pinnedAt: null });
    assert.equal(routeCalls.length, 0, "there is no answer a stale replica could give that we may act on");
    assert.equal(setCalls.length, 0);
  });
});

test("at or above the bound, BOTH reads are answered at the same pinned block", async () => {
  workingStorage();
  const k = freshKernel();
  rememberLandingBlock(k, 200n);
  const { deps, routeCalls, setCalls } = spyDeps();
  const r = await readRouteNoOlderThan(k, deps);
  assert.deepEqual(routeCalls, [200n]);
  assert.deepEqual(setCalls, [200n], "route and set must describe ONE chain state, not two");
  assert.equal(r.pinnedAt, 200n);
  assert.deepEqual(r.set, { state: "read", guardians: ["0xa"] });
});

test("with no bound the reads still pin, so load balancing cannot split them", async () => {
  workingStorage();
  const { deps, routeCalls, setCalls } = spyDeps({ headBlock: async () => 42n });
  await readRouteNoOlderThan(freshKernel(), deps);
  assert.deepEqual(routeCalls, [42n]);
  assert.deepEqual(setCalls, [42n]);
});

test("a route behind another hook is not asked for a WoCo set", async () => {
  workingStorage();
  const { deps, setCalls } = spyDeps({
    readRoute: async () => ({ state: "installed", deployed: true, hookKind: "legacy" }),
  });
  const r = await readRouteNoOlderThan(freshKernel(), deps);
  assert.equal(r.set, null);
  assert.equal(setCalls.length, 0);
});

test("an unreadable head is UNKNOWN, and asks nothing further", async () => {
  workingStorage();
  const { deps, routeCalls } = spyDeps({ headBlock: async () => { throw new Error("rpc down"); } });
  const r = await readRouteNoOlderThan(freshKernel(), deps);
  assert.equal(r.route.state, "unknown");
  assert.equal(r.pinnedAt, null);
  assert.equal(routeCalls.length, 0);
});

test("a read that throws is UNKNOWN — never `absent`, which is the dangerous answer", async () => {
  workingStorage();
  for (const over of [
    { readRoute: async () => { throw new Error("no such block"); } },
    { readSet: async () => { throw new Error("no such block"); } },
  ] as Partial<PinnedRouteReadDeps>[]) {
    const { deps } = spyDeps(over);
    const r = await readRouteNoOlderThan(freshKernel(), deps);
    assert.equal(r.route.state, "unknown");
    assert.equal(r.set, null);
  }
});

// --- The wiring, as a text check --------------------------------------------
//
// A pinned read nobody calls pins nothing, and a write that forgets its landing
// block leaves the NEXT read unpinnable. Both live in modules this suite cannot
// execute, so the calls are asserted on the source: deleting one is a red test
// rather than a review miss.

const src = (rel: string): string => readFileSync(new URL(`../src/${rel}`, import.meta.url), "utf8");
const KERNEL_ACCOUNT = src("lib/auth/kernel-account.ts");
const BACKUP_MANAGEMENT = src("lib/auth/backup-management.ts");
const AUTH_STORE = src("lib/auth/auth-store.svelte.ts");
const PANEL = src("lib/components/recovery/AccountRecoverySetup.svelte");

/** The body of a top-level `async function name(` (exported or module-private). */
function fnBody(source: string, name: string): string {
  let start = source.indexOf(`export async function ${name}(`);
  if (start === -1) start = source.indexOf(`\nasync function ${name}(`);
  assert.notEqual(start, -1, `${name} not found`);
  const end = source.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `${name} body not terminated`);
  return source.slice(start, end);
}

test("every deciding read on the backup surface goes through the pinned helper", () => {
  for (const [where, body] of [
    ["readBackupProtection", fnBody(BACKUP_MANAGEMENT, "readBackupProtection")],
    ["setupAccountRecovery", fnBody(AUTH_STORE, "setupAccountRecovery")],
    ["removeAllBackups", fnBody(KERNEL_ACCOUNT, "removeAllBackups")],
  ] as const) {
    assert.match(body, /readRecoveryRouteNoOlderThan\(/, `${where} must pin its route read`);
    // A call with ONE argument is a read at "latest". (The post-write read-backs
    // pass their landing block as a second argument and are pinned by construction.)
    assert.doesNotMatch(
      body,
      /[^a-zA-Z]readRecoveryRoute\([^,)]*\)/,
      `${where} must not read the route at "latest" — that is the read one lagging replica turns into a silent drop`,
    );
    assert.doesNotMatch(
      body,
      /[^a-zA-Z]readGuardianSet\([^,)]*\)/,
      `${where} must take the set from the SAME pinned read, not a second unpinned one`,
    );
  }
});

test("every proven recovery write records its landing block", () => {
  for (const fn of ["setupRecovery", "addGuardianOnChain", "revokeGuardianOnChain", "removeAllBackups"]) {
    const body = fnBody(KERNEL_ACCOUNT, fn);
    assert.match(
      body,
      /rememberLandingBlock\(builtKernel\.address, blockNumber\)/,
      `${fn} must record the block it landed in, or the next read cannot be pinned`,
    );
  }
  // The rotation goes THROUGH the recovery route, so the route provably existed at
  // that block — and this device is about to become the account's own device.
  assert.match(AUTH_STORE, /rememberLandingBlock\(target, blockNumber\)/);
});

test("each write records its block only AFTER the read-back has proven it", () => {
  for (const [fn, proof] of [
    ["setupRecovery", "await assertGuardianSetAfterWrite("],
    ["addGuardianOnChain", "await assertGuardianSetAfterWrite("],
    ["revokeGuardianOnChain", "if (still === null)"],
    ["removeAllBackups", 'if (after.state === "unknown")'],
  ] as const) {
    const body = fnBody(KERNEL_ACCOUNT, fn);
    const provenAt = body.indexOf(proof);
    const rememberAt = body.indexOf("rememberLandingBlock(");
    assert.notEqual(provenAt, -1, `${fn}: proof step "${proof}" not found`);
    assert.ok(
      provenAt < rememberAt,
      `${fn} must not claim to have seen a change it has not proven`,
    );
  }
});

test("the panel shows the set the write PROVED, not a re-read that may still lag", () => {
  assert.match(PANEL, /const added = await auth\.setupAccountRecovery\(/);
  assert.match(PANEL, /onChainGuardians = added\.guardians;/);
  assert.match(AUTH_STORE, /return \{ guardianAddress, txHash, guardians: expectedGuardiansAfter \};/);
});
