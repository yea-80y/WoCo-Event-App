/**
 * `WOCO_EVENT_CHAIN_ID` is required (#607). It used to default to Base Sepolia,
 * a chain nothing watches, so a dropped env line sent every registration there
 * with no signal. Boot runs `assertEventContractConfig`, which reads it first.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";

import { assertEventContractConfig, EventContractConfigError, getActiveChainId } from "../src/lib/chain/event-contract.js";

const saved = process.env.WOCO_EVENT_CHAIN_ID;
after(() => {
  if (saved === undefined) delete process.env.WOCO_EVENT_CHAIN_ID;
  else process.env.WOCO_EVENT_CHAIN_ID = saved;
});

test("unset or empty refuses, naming the variable - never a default chain", () => {
  for (const v of [undefined, "", "  "]) {
    if (v === undefined) delete process.env.WOCO_EVENT_CHAIN_ID;
    else process.env.WOCO_EVENT_CHAIN_ID = v;
    assert.throws(() => getActiveChainId(), (e: unknown) => e instanceof EventContractConfigError && /WOCO_EVENT_CHAIN_ID is not set/.test(e.message));
  }
});

test("a value that is not a chain id refuses instead of parsing a prefix", () => {
  for (const v of ["84532x", "abc", "0", "-1", "4.2", "0x66eee", "12345678901234567"]) {
    process.env.WOCO_EVENT_CHAIN_ID = v;
    assert.throws(() => getActiveChainId(), EventContractConfigError, v);
  }
});

test("a chain id is read as set", () => {
  process.env.WOCO_EVENT_CHAIN_ID = " 421614 ";
  assert.equal(getActiveChainId(), 421614);
  process.env.WOCO_EVENT_CHAIN_ID = "42161";
  assert.equal(getActiveChainId(), 42161);
});

test("the boot check refuses to start without it", () => {
  delete process.env.WOCO_EVENT_CHAIN_ID;
  assert.throws(() => assertEventContractConfig(), EventContractConfigError);
});
