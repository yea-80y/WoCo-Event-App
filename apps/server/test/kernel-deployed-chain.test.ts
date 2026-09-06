/**
 * `kernel-deployed.json` is per-chain (#489).
 *
 * "This Kernel has an on-chain owner" is the fact that makes the counterfactual
 * fallback insufficient, and it is a fact ABOUT A CHAIN. The Kernel moved from
 * Arbitrum Sepolia to Arbitrum One and every address came with it unchanged
 * (CREATE2 reads no chain id), so a Sepolia sighting replayed on Arbitrum One
 * would refuse the fallback for an account that is genuinely counterfactual
 * there — i.e. lock out every existing passkey user on day one, the exact
 * accounts for which the fallback IS the mechanism.
 *
 * The other half matters as much: a foreign-chain record must survive. The move
 * is reversible, and a rollback that found the Sepolia sightings erased would
 * reopen the #200 window silently.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KERNEL_CHAIN_ID } from "@woco/shared";

const cwd = process.cwd();
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "woco-kernel-chain-"));
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

const FILE = () => join(dir, ".data", "kernel-deployed.json");
const KERNEL = "0x1111111111111111111111111111111111111111";
const OWNER = "0xaaaa000000000000000000000000000000000001";
const OTHER_CHAIN = 421614;

function seed(state: unknown): void {
  mkdirSync(join(dir, ".data"), { recursive: true });
  writeFileSync(FILE(), JSON.stringify(state));
}

async function freshStore() {
  const mod = await import(`../src/lib/auth/kernel-deployed.js?t=${Math.random()}`);
  mod._resetKernelDeployedForTests();
  return mod as typeof import("../src/lib/auth/kernel-deployed.js");
}

test("the Kernel chain is Arbitrum One — the premise of everything below", () => {
  // Stated, not assumed: if this ever flips back, the cases below invert and
  // should be read again rather than quietly passing for the other reason.
  assert.equal(KERNEL_CHAIN_ID, 42161);
  assert.notEqual(KERNEL_CHAIN_ID, OTHER_CHAIN);
});

test("a record with no chainId is a Sepolia sighting and does NOT count here", async () => {
  seed({ version: 2, kernels: { [KERNEL]: { firstSeen: "2026-08-09T14:47:03.976Z", owner: OWNER, block: 100 } } });
  const s = await freshStore();
  assert.equal(s.kernelDeployedLoadFailed(), false, "a v2 file is readable, not corrupt");
  assert.equal(s.isKernelKnownDeployed(KERNEL), false, "a pre-move sighting counted on the new chain");
  assert.equal(s.getKernelOwnerRecord(KERNEL), undefined, "a pre-move owner was replayed on the new chain");
});

test("a record stamped with the OLD chain does not count either", async () => {
  seed({
    version: 3,
    kernels: { [`${OTHER_CHAIN}:${KERNEL}`]: { chainId: OTHER_CHAIN, firstSeen: "2026-08-09T14:47:03.976Z", owner: OWNER, block: 100 } },
  });
  const s = await freshStore();
  assert.equal(s.isKernelKnownDeployed(KERNEL), false);
  assert.equal(s.getKernelOwnerRecord(KERNEL), undefined);
});

test("a record stamped with the CURRENT chain counts", async () => {
  seed({
    version: 3,
    kernels: { [`${KERNEL_CHAIN_ID}:${KERNEL}`]: { chainId: KERNEL_CHAIN_ID, firstSeen: "2026-09-06T00:00:00.000Z", owner: OWNER, block: 100 } },
  });
  const s = await freshStore();
  assert.equal(s.isKernelKnownDeployed(KERNEL), true);
  assert.deepEqual(s.getKernelOwnerRecord(KERNEL), { owner: OWNER, block: 100 });
});

test("recording on the new chain leaves the old chain's record untouched", async () => {
  const legacy = { firstSeen: "2026-08-09T14:47:03.976Z", owner: OWNER, block: 100 };
  seed({ version: 2, kernels: { [KERNEL]: legacy } });
  const s = await freshStore();

  s.recordKernelOwner(KERNEL, OWNER, 999);

  const after = JSON.parse(readFileSync(FILE(), "utf-8")) as {
    version: number;
    kernels: Record<string, { chainId?: number; firstSeen: string; owner?: string; block?: number }>;
  };
  assert.deepEqual(after.kernels[KERNEL], legacy, "the pre-move record was rewritten or dropped");
  const fresh = after.kernels[`${KERNEL_CHAIN_ID}:${KERNEL}`];
  assert.ok(fresh, "no record was written under the current chain");
  assert.equal(fresh.chainId, KERNEL_CHAIN_ID);
  assert.equal(fresh.block, 999);
  // firstSeen is fresh: on THIS chain the account was first seen just now, and
  // carrying the Sepolia timestamp over would misdate the observation.
  assert.notEqual(fresh.firstSeen, legacy.firstSeen);
  assert.equal(s.isKernelKnownDeployed(KERNEL), true);
});

test("writes are keyed by chain, so the same address can differ across chains", async () => {
  const s = await freshStore();
  s.recordKernelOwner(KERNEL, OWNER, 42);
  const written = JSON.parse(readFileSync(FILE(), "utf-8")) as { version: number; kernels: Record<string, unknown> };
  assert.equal(written.version, 3);
  assert.deepEqual(Object.keys(written.kernels), [`${KERNEL_CHAIN_ID}:${KERNEL}`]);
});

// ── The rotated-away guard: the hole the chain filter opened, and its plug ────
//
// Ignoring a foreign-chain record is right for the DEPLOYMENT question and
// catastrophic for the TRUST one. On Arbitrum One a recovered account has no
// code, so the live read is `null`, the Sepolia record is (correctly) ignored,
// and the counterfactual — derived from the ORIGINAL owner's init data, valid on
// every chain at once — would re-admit the very key the recovery retired. A
// session grant is the whole identity, so this is not a partial regression of
// #200; it is #200 with the fix in place and looking healthy.
//
// The rows below are the four cases that matter, decided the way the auth path
// decides them: no code on the Kernel chain (`ownerRead: null`).

const RETIRED = "0xbbbb000000000000000000000000000000000002";
const ROTATED_IN = "0xcccc000000000000000000000000000000000003";

async function decideWith(store: typeof import("../src/lib/auth/kernel-deployed.js"), eoa: string, counterfactualMatches: boolean) {
  const { decideKernelOwnership } = await import("../src/lib/auth/kernel-owner.js");
  return decideKernelOwnership({
    ownerRead: null, // Arbitrum One serves no code for a pre-move account
    eoa,
    counterfactualMatches,
    knownDeployed: store.isKernelKnownDeployed(KERNEL),
    knownRotatedAway: store.knownOwnerDisagreesOnAnyChain(KERNEL, eoa),
  });
}

test("(a) never rotated: the original key still passes on day one", async () => {
  // The fallback MUST survive the move for the ordinary account, or every
  // existing passkey user is locked out the moment the chain flips.
  seed({ version: 2, kernels: { [KERNEL]: { firstSeen: "2026-08-01T00:00:00.000Z", owner: OWNER, block: 100 } } });
  const s = await freshStore();
  assert.equal(s.knownOwnerDisagreesOnAnyChain(KERNEL, OWNER), false);
  assert.equal(await decideWith(s, OWNER, true), true);
});

test("(b) rotated on the old chain: the RETIRED key is refused", async () => {
  // recordKernelOwner advanced the record to the rotated-IN owner, so the
  // retired key disagrees with it — on a chain the record was not written for.
  seed({ version: 2, kernels: { [KERNEL]: { firstSeen: "2026-08-01T00:00:00.000Z", owner: ROTATED_IN, block: 200 } } });
  const s = await freshStore();
  assert.equal(s.knownOwnerDisagreesOnAnyChain(KERNEL, RETIRED), true);
  // Its counterfactual still matches — that is exactly the problem, and why the
  // record has to be the thing that refuses.
  assert.equal(await decideWith(s, RETIRED, true), false, "a retired key was re-admitted after the chain move");
});

test("(c) rotated on the old chain: the rotated-IN key is refused too, for the right reason", async () => {
  // Not a regression: on Arbitrum One this account genuinely does not exist, so
  // there is nothing for the new owner to control yet. Re-running recovery on
  // the new chain is the path, and it deploys the account.
  seed({ version: 2, kernels: { [KERNEL]: { firstSeen: "2026-08-01T00:00:00.000Z", owner: ROTATED_IN, block: 200 } } });
  const s = await freshStore();
  assert.equal(s.knownOwnerDisagreesOnAnyChain(KERNEL, ROTATED_IN), false, "the recorded owner must not disagree with itself");
  // A rotated-in key does NOT derive this address, so the counterfactual fails.
  assert.equal(await decideWith(s, ROTATED_IN, false), false);
});

test("(d) a current-chain record naming another owner refuses the old key", async () => {
  seed({
    version: 3,
    kernels: { [`${KERNEL_CHAIN_ID}:${KERNEL}`]: { chainId: KERNEL_CHAIN_ID, firstSeen: "2026-09-06T00:00:00.000Z", owner: ROTATED_IN, block: 300 } },
  });
  const s = await freshStore();
  assert.equal(s.knownOwnerDisagreesOnAnyChain(KERNEL, RETIRED), true);
  assert.equal(await decideWith(s, RETIRED, true), false);
});

test("a v1 record names no owner, so it cannot disagree with anything", async () => {
  // v1 knew only that an owner existed. Treating that as disagreement would
  // refuse a legitimate never-rotated key on the strength of no evidence.
  seed({ version: 1, kernels: { [KERNEL]: "2026-08-09T14:47:03.976Z" } });
  const s = await freshStore();
  assert.equal(s.knownOwnerDisagreesOnAnyChain(KERNEL, OWNER), false);
  assert.equal(s.knownOwnerDisagreesOnAnyChain(KERNEL, RETIRED), false);
});

test("the any-chain predicates ignore other addresses entirely", async () => {
  const OTHER = "0x2222222222222222222222222222222222222222";
  seed({ version: 3, kernels: { [`${KERNEL_CHAIN_ID}:${OTHER}`]: { chainId: KERNEL_CHAIN_ID, firstSeen: "x", owner: ROTATED_IN, block: 1 } } });
  const s = await freshStore();
  assert.equal(s.knownOwnerDisagreesOnAnyChain(KERNEL, RETIRED), false, "another account's rotation refused this one");
  assert.equal(s.isKernelKnownDeployedOnAnyChain(KERNEL), false);
  assert.equal(s.isKernelKnownDeployedOnAnyChain(OTHER), true);
});

test("isKernelKnownDeployedOnAnyChain counts a foreign-chain sighting that isKernelKnownDeployed ignores", async () => {
  // The smart-wallet gate (#209) turns on this one, and must NOT be narrowed by
  // the chain filter: a 6492 wrapper replays the original deployment on every
  // chain the account is not deployed on — the Kernel's own chain included, the
  // day after a move.
  seed({ version: 2, kernels: { [KERNEL]: { firstSeen: "2026-08-01T00:00:00.000Z", owner: OWNER, block: 100 } } });
  const s = await freshStore();
  assert.equal(s.isKernelKnownDeployed(KERNEL), false, "deployment is per-chain");
  assert.equal(s.isKernelKnownDeployedOnAnyChain(KERNEL), true, "the gate lost its evidence to the chain filter");
});

test("knownRotatedAway refuses on its own — the pure row that isolates it", async () => {
  const { decideKernelOwnership } = await import("../src/lib/auth/kernel-owner.js");
  const base = { ownerRead: null as null, eoa: OWNER, counterfactualMatches: true, knownDeployed: false };
  assert.equal(decideKernelOwnership({ ...base, knownRotatedAway: false }), true, "the ordinary day-one fallback must still work");
  assert.equal(decideKernelOwnership({ ...base, knownRotatedAway: true }), false);
  assert.equal(decideKernelOwnership({ ...base, ownerRead: "error" as const, knownRotatedAway: true }), false);
  // It can only withhold, never grant — the same property knownDeployed has.
  assert.equal(
    decideKernelOwnership({ ...base, counterfactualMatches: false, knownRotatedAway: true }),
    false,
  );
});
