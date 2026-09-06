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
