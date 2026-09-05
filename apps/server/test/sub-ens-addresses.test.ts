import { test } from "node:test";
import assert from "node:assert/strict";
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
