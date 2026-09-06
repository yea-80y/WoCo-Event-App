import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { SUB_ENS_DEPLOYMENTS, SUB_ENS_DEFAULT_CHAIN_ID, getSubEnsDeployment } from "@woco/shared";
import {
  getRegistrarAddress,
  getRegistryAddress,
  getSubEnsChainId,
} from "../src/lib/chain/sub-ens-contract.js";

// The registrar/registry pair used to be restated in this workspace AND in
// apps/web/src/lib/auth/kernel-account.ts, with no compiler relationship — they
// drifted for months (#472). Both sides now import the map in @woco/shared, so
// the equality that a source-scraping test used to assert is structural and
// needs no test. What still needs one is the ENV OVERRIDE path, which is the
// only way an address can differ from the map at runtime.

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("with no env override, both addresses come from the shared map", () => {
  withEnv(
    {
      SUB_ENS_CHAIN_ID: undefined,
      SUB_ENS_REGISTRAR_ADDRESS: undefined,
      SUB_ENS_REGISTRY_ADDRESS: undefined,
    },
    () => {
      const chainId = getSubEnsChainId();
      assert.equal(chainId, SUB_ENS_DEFAULT_CHAIN_ID);
      assert.equal(getRegistrarAddress(chainId), SUB_ENS_DEPLOYMENTS[SUB_ENS_DEFAULT_CHAIN_ID].registrar);
      assert.equal(getRegistryAddress(chainId), SUB_ENS_DEPLOYMENTS[SUB_ENS_DEFAULT_CHAIN_ID].registry);
    },
  );
});

test("the registry and the registrar are different contracts", () => {
  // A copy-paste that pointed both accessors at one address would make the
  // gateway read names out of the registrar and every ownership check answer
  // null — a whole-feature outage that no other test in the suite distinguishes
  // from "nobody owns anything".
  const d = SUB_ENS_DEPLOYMENTS[SUB_ENS_DEFAULT_CHAIN_ID];
  assert.notEqual(d.registry.toLowerCase(), d.registrar.toLowerCase());
});

test("every address in the map is a well-formed 20-byte address", () => {
  for (const [chainId, d] of Object.entries(SUB_ENS_DEPLOYMENTS)) {
    assert.match(d.registry, /^0x[0-9a-fA-F]{40}$/, `registry for chain ${chainId}`);
    assert.match(d.registrar, /^0x[0-9a-fA-F]{40}$/, `registrar for chain ${chainId}`);
  }
});

test("an env override replaces the map value", () => {
  const other = "0x00000000000000000000000000000000000000aa";
  withEnv({ SUB_ENS_REGISTRAR_ADDRESS: other, SUB_ENS_REGISTRY_ADDRESS: undefined }, () => {
    assert.equal(getRegistrarAddress(SUB_ENS_DEFAULT_CHAIN_ID), other);
    // …and only the one that was overridden.
    assert.equal(
      getRegistryAddress(SUB_ENS_DEFAULT_CHAIN_ID),
      SUB_ENS_DEPLOYMENTS[SUB_ENS_DEFAULT_CHAIN_ID].registry,
    );
  });
});

test("an override that is set but EMPTY throws instead of falling back", () => {
  // A bare `SUB_ENS_REGISTRAR_ADDRESS=` is the empty string to dotenv and to a
  // Docker env_file alike. Treating it as "unset" would silently run on the
  // built-in default on the one code path where the operator explicitly asked
  // for a different address; returning it would put "" in calldata.
  for (const empty of ["", "   "]) {
    withEnv({ SUB_ENS_REGISTRAR_ADDRESS: empty }, () => {
      assert.throws(
        () => getRegistrarAddress(SUB_ENS_DEFAULT_CHAIN_ID),
        /SUB_ENS_REGISTRAR_ADDRESS is set but empty/,
      );
    });
    withEnv({ SUB_ENS_REGISTRY_ADDRESS: empty }, () => {
      assert.throws(
        () => getRegistryAddress(SUB_ENS_DEFAULT_CHAIN_ID),
        /SUB_ENS_REGISTRY_ADDRESS is set but empty/,
      );
    });
  }
});

test("a chain with no deployment and no override throws rather than returning undefined", () => {
  withEnv({ SUB_ENS_REGISTRAR_ADDRESS: undefined, SUB_ENS_REGISTRY_ADDRESS: undefined }, () => {
    assert.throws(() => getRegistrarAddress(1), /No sub-ENS deployment for chain 1/);
    assert.throws(() => getRegistryAddress(1), /No sub-ENS deployment for chain 1/);
    assert.throws(() => getSubEnsDeployment(1), /No sub-ENS deployment for chain 1/);
  });
});

// ---------------------------------------------------------------------------
// The map against the deployment records.
//
// The map is what every caller uses; the JSON under contracts/deployments is
// what was actually broadcast. Nothing links them but a human retyping 40 hex
// characters, and a single wrong nibble is an address that exists, parses, and
// resolves nothing — every name read answers "unowned" and every permit is
// signed for a contract nobody deployed.
//
// contracts/ is a separate repo and gitignored here (.gitignore:53), so CI has
// no records to read and this SKIPS there. It is a local pre-merge check by
// design — hence a visible skip rather than a quiet pass, which would make the
// absence look like agreement.

const DEPLOYMENTS_DIR = new URL("../../../contracts/deployments/", import.meta.url);

interface DeploymentRecord {
  l2Registry?: string;
  wocoRegistrar?: string;
}

test("every map row matches its deployment record", (t) => {
  if (!existsSync(DEPLOYMENTS_DIR)) {
    t.skip("contracts/ not checked out — record equality not verified here");
    return;
  }

  let verified = 0;
  for (const [chainId, d] of Object.entries(SUB_ENS_DEPLOYMENTS)) {
    const file = new URL(`${chainId}-subens.json`, DEPLOYMENTS_DIR);
    if (!existsSync(file)) continue;

    const record = JSON.parse(readFileSync(file, "utf-8")) as DeploymentRecord;
    assert.equal(
      record.l2Registry?.toLowerCase(),
      d.registry.toLowerCase(),
      `registry for chain ${chainId} disagrees with ${chainId}-subens.json`,
    );
    assert.equal(
      record.wocoRegistrar?.toLowerCase(),
      d.registrar.toLowerCase(),
      `registrar for chain ${chainId} disagrees with ${chainId}-subens.json`,
    );
    verified++;
  }

  // A checked-out contracts/ that happens to hold no record for any row would
  // otherwise pass while asserting nothing at all.
  if (verified === 0) t.skip("no deployment record found for any mapped chain");
});

test("the default chain is a real row, and not the Kernel's chain", () => {
  // KERNEL_CHAIN_ID stayed on Arbitrum Sepolia when the names moved to Arbitrum
  // One (#489). A default that slipped back would produce permits signed for the
  // Sepolia registrar's EIP-712 domain — well-formed, verifiable, and refused by
  // the mainnet registrar the frontend actually calls. Distinct registrar
  // addresses are what make that mistake detectable at all.
  const d = SUB_ENS_DEPLOYMENTS[SUB_ENS_DEFAULT_CHAIN_ID];
  assert.ok(d, `no deployment row for the default chain ${SUB_ENS_DEFAULT_CHAIN_ID}`);
  assert.notEqual(
    d.registrar.toLowerCase(),
    SUB_ENS_DEPLOYMENTS[421614].registrar.toLowerCase(),
    "the default sub-ENS chain is the Kernel's testnet chain — a mainnet permit would be signed for the wrong registrar",
  );
});
