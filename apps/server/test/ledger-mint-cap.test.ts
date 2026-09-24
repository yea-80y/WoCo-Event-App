/**
 * The events ledger's per-sponsor hourly mint cap (#662, WoCo-Contracts #30).
 *
 * Two things fail silently without this: an ABI that does not declare
 * `MintCapExceeded` turns the refusal into raw revert data, and a refusal read
 * without its `perHour` promises a retry time that, for a stopped sponsor, lifts
 * nothing. The fragments are pinned to the compiled contract (ground truth from
 * `out/WoCoTicketLedger.sol`, commit 7f6083e), because a drifted output tuple
 * compiles here and decodes garbage against the chain.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Interface, id } from "ethers";

import {
  LEDGER_ABI,
  LEDGER_UNLIMITED_MINTS,
  decodeMintCapExceeded,
  isNotThisAbi,
  mintCapRefusal,
  MintCapExceededError,
} from "../src/lib/chain/event-contract-ledger.js";

const iface = new Interface(LEDGER_ABI as unknown as string[]);
const SPONSOR = "0x" + "ab".repeat(20);
const LEDGER = "0x" + "cd".repeat(20);
const RESETS_AT = 1_790_000_000;

test("sponsorMintAllowance matches the compiled contract: selector and output tuple", () => {
  const fn = iface.getFunction("sponsorMintAllowance")!;
  assert.equal(fn.selector, "0xc7fa48dc");
  assert.deepEqual(
    fn.outputs.map((o) => [o.name, o.type]),
    [["perHour", "uint32"], ["mintable", "uint32"], ["windowResetsAt", "uint64"]],
  );
});

test("getSlotData decodes by the contract's own output names", () => {
  // The reader reads `holder` BY NAME; a stale `owner` name here would decode
  // the claimer into the slot owner the door verifies against.
  const fn = iface.getFunction("getSlotData")!;
  assert.equal(fn.selector, "0x7bc1a811");
  assert.deepEqual(fn.outputs.map((o) => o.name), ["holder", "claimer", "orderRef"]);
});

test("the audit-959 errors and events carry the contract's signatures", () => {
  assert.equal(iface.getError("MintCapExceeded")!.selector, id("MintCapExceeded(address,uint64)").slice(0, 10));
  assert.equal(iface.getError("TransferToLedger")!.selector, id("TransferToLedger()").slice(0, 10));
  assert.equal(
    iface.getEvent("EventCancelled")!.topicHash,
    id("EventCancelled(bytes32,address,bool)"),
  );
  const moved = iface.getEvent("SlotTransferred")!;
  assert.equal(moved.topicHash, id("SlotTransferred(bytes32,uint256,address,address)"));
  // topic0 did not change when `slot` stopped being indexed — only this does.
  assert.deepEqual(moved.inputs.map((i) => [i.name, i.indexed === true]), [
    ["eventId", true],
    ["slot", false],
    ["from", true],
    ["to", true],
  ]);
});

test("SlotTransferred decodes `from` as an address, not as the slot", () => {
  const moved = iface.getEvent("SlotTransferred")!;
  const eventId = "0x" + "11".repeat(32);
  const from = "0x" + "22".repeat(20);
  const to = "0x" + "33".repeat(20);
  const log = iface.encodeEventLog(moved, [eventId, 7n, from, to]);
  const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data })!;
  assert.equal(parsed.args.slot, 7n);
  assert.equal((parsed.args.from as string).toLowerCase(), from);
  assert.equal((parsed.args.to as string).toLowerCase(), to);
});

test("UNLIMITED_MINTS is type(uint32).max", () => {
  assert.equal(LEDGER_UNLIMITED_MINTS, 2 ** 32 - 1);
});

// ---------------------------------------------------------------------------
// Decoding the refusal
// ---------------------------------------------------------------------------

test("MintCapExceeded decodes from a contract-level CALL_EXCEPTION", () => {
  const data = iface.encodeErrorResult("MintCapExceeded", [SPONSOR, BigInt(RESETS_AT)]);
  // `makeError` is how a contract's staticCall/estimateGas builds its
  // CALL_EXCEPTION, `revert` attached. A sponsor SEND carries raw data only —
  // that shape is driven end to end in sponsor-mint-gate.test.ts.
  const err = iface.makeError(data, { to: LEDGER, data: "0x" });
  assert.deepEqual(decodeMintCapExceeded(err), { sponsor: SPONSOR, windowResetsAt: RESETS_AT });
});

test("MintCapExceeded decodes from raw revert data when the provider strips `revert`", () => {
  const data = iface.encodeErrorResult("MintCapExceeded", [SPONSOR, BigInt(RESETS_AT)]);
  assert.deepEqual(decodeMintCapExceeded({ data }), { sponsor: SPONSOR, windowResetsAt: RESETS_AT });
});

test("MintCapExceeded decodes from `revert` alone, the field ethers documents", () => {
  const revert = { name: "MintCapExceeded", args: [SPONSOR.toUpperCase().replace("0X", "0x"), BigInt(RESETS_AT)] };
  assert.deepEqual(decodeMintCapExceeded({ revert }), { sponsor: SPONSOR, windowResetsAt: RESETS_AT });
});

test("any other refusal is not read as the cap", () => {
  const closed = iface.makeError(iface.encodeErrorResult("SalesClosed", []), { to: LEDGER, data: "0x" });
  assert.equal(decodeMintCapExceeded(closed), null);
  assert.equal(decodeMintCapExceeded(new Error("nonce too low")), null);
  assert.equal(decodeMintCapExceeded({ data: "0x" }), null);
  assert.equal(decodeMintCapExceeded(null), null);
});

// ---------------------------------------------------------------------------
// Retry semantics
// ---------------------------------------------------------------------------

test("a stopped sponsor (perHour 0) is NEVER given a retry time", () => {
  const r = mintCapRefusal({ perHour: 0, windowResetsAt: RESETS_AT });
  assert.equal(r.stopped, true);
  assert.equal(r.retryAt, null);
  assert.doesNotMatch(r.message, /resets at|retry/i);
  assert.doesNotMatch(r.message, new RegExp(new Date(RESETS_AT * 1000).toISOString()));
  assert.match(r.message, /stopped/);
});

test("an unreadable cap withholds the retry time — it might be a stop", () => {
  const r = mintCapRefusal({ perHour: null, windowResetsAt: RESETS_AT });
  assert.equal(r.stopped, null);
  assert.equal(r.retryAt, null);
  assert.doesNotMatch(r.message, /resets at/);
});

test("an exhausted window names when it resets", () => {
  const r = mintCapRefusal({ perHour: 50, windowResetsAt: RESETS_AT });
  assert.equal(r.stopped, false);
  assert.equal(r.retryAt, RESETS_AT);
  assert.match(r.message, /50\/h/);
  assert.match(r.message, new RegExp(new Date(RESETS_AT * 1000).toISOString()));
});

test("the error thrown to fulfilment carries the refusal as its message", () => {
  const e = new MintCapExceededError(mintCapRefusal({ perHour: 0, windowResetsAt: RESETS_AT }));
  assert.equal(e.name, "MintCapExceededError");
  assert.equal(e.stopped, true);
  assert.match(e.message, /stopped/);
});

// ---------------------------------------------------------------------------
// "This address does not speak the cap ABI"
// ---------------------------------------------------------------------------

test("an empty revert or an undecodable empty return is not-this-ABI; a timeout or a revert with data is not", () => {
  const fn = iface.getFunction("sponsorMintAllowance")!;
  // What a contract call raises when the node answers a revert with data "0x".
  const emptyRevert = iface.makeError("0x", { to: LEDGER, data: iface.encodeFunctionData(fn, [SPONSOR]) });
  assert.equal(isNotThisAbi(emptyRevert), true, "revert with empty data");
  let badData: unknown;
  try {
    iface.decodeFunctionResult(fn, "0x");
  } catch (err) {
    badData = err;
  }
  assert.equal(isNotThisAbi(badData), true, "an EOA answers 0x");
  assert.equal(isNotThisAbi(new Error("timeout")), false);
  const withData = iface.makeError(iface.encodeErrorResult("SalesClosed", []), { to: LEDGER, data: "0x" });
  assert.equal(isNotThisAbi(withData), false, "a revert that carries data is an answer");
});
