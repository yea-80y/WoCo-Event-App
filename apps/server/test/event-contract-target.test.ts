/**
 * Which events contract a registration lives on (#563).
 *
 * A successor contract runs BESIDE the old one: tickets on the old contract
 * stay mintable until sold out and verifiable forever. That only holds if a
 * registration's reads and mints go to the contract it was made on, not to
 * whatever env selects today — and for records written before the contract was
 * recorded, `legacyEventContract` is the rule that answers.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  contractKey,
  getDefaultEventContract,
  legacyEventContract,
} from "../src/lib/chain/event-contract.js";

const CHAIN = 421614;
const V2_DEPLOYED = "0x351070aff6deca449506a6ea6dc6cb84d13caedf";
const LEDGER = "0x" + "1e".repeat(20);

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const k of Object.keys(vars)) saved.set(k, process.env[k]);
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const CLEAN = {
  [`WOCO_EVENT_VERSION_${CHAIN}`]: undefined,
  [`WOCO_EVENT_ADDRESS_${CHAIN}`]: undefined,
  [`WOCO_EVENT_ADDRESS_V2_${CHAIN}`]: undefined,
  [`WOCO_EVENT_ADDRESS_LEDGER_${CHAIN}`]: undefined,
};

test("the default contract is the env-selected one, version and all", () => {
  withEnv({ ...CLEAN, [`WOCO_EVENT_VERSION_${CHAIN}`]: "v2" }, () => {
    assert.deepEqual(getDefaultEventContract(CHAIN), { chainId: CHAIN, address: V2_DEPLOYED, version: "v2" });
  });
  withEnv({ ...CLEAN, [`WOCO_EVENT_VERSION_${CHAIN}`]: "ledger", [`WOCO_EVENT_ADDRESS_LEDGER_${CHAIN}`]: LEDGER }, () => {
    assert.deepEqual(getDefaultEventContract(CHAIN), { chainId: CHAIN, address: LEDGER, version: "ledger" });
  });
});

test("an unrecorded registration follows env while env is on a pre-ledger version", () => {
  withEnv({ ...CLEAN, [`WOCO_EVENT_VERSION_${CHAIN}`]: "v2" }, () => {
    assert.deepEqual(legacyEventContract(CHAIN), getDefaultEventContract(CHAIN));
  });
});

test("after the flip to the ledger, an unrecorded registration stays on V2 — never the ledger", () => {
  // The cutover case: following env here would read every pre-cutover ticket on
  // a contract where its id does not exist.
  withEnv({ ...CLEAN, [`WOCO_EVENT_VERSION_${CHAIN}`]: "ledger", [`WOCO_EVENT_ADDRESS_LEDGER_${CHAIN}`]: LEDGER }, () => {
    const t = legacyEventContract(CHAIN);
    assert.deepEqual(t, { chainId: CHAIN, address: V2_DEPLOYED, version: "v2" });
    assert.notEqual(t?.address, LEDGER);
  });
});

test("the V2 override is honoured for the legacy rule, as it is everywhere else", () => {
  const override = "0x" + "2f".repeat(20);
  withEnv(
    {
      ...CLEAN,
      [`WOCO_EVENT_VERSION_${CHAIN}`]: "ledger",
      [`WOCO_EVENT_ADDRESS_LEDGER_${CHAIN}`]: LEDGER,
      [`WOCO_EVENT_ADDRESS_V2_${CHAIN}`]: override,
    },
    () => {
      assert.equal(legacyEventContract(CHAIN)?.address, override);
    },
  );
});

test("a ledger chain V2 never ran on has no legacy contract — callers refuse, never guess", () => {
  const ARB_ONE = 42161;
  withEnv(
    {
      [`WOCO_EVENT_VERSION_${ARB_ONE}`]: "ledger",
      [`WOCO_EVENT_ADDRESS_LEDGER_${ARB_ONE}`]: LEDGER,
      [`WOCO_EVENT_ADDRESS_V2_${ARB_ONE}`]: undefined,
    },
    () => {
      assert.equal(legacyEventContract(ARB_ONE), undefined);
    },
  );
});

test("contractKey names chain and address, case-insensitively", () => {
  assert.equal(
    contractKey({ chainId: CHAIN, address: "0xAbCd" + "00".repeat(18), version: "v2" }),
    `${CHAIN}:0xabcd${"00".repeat(18)}`,
  );
});
