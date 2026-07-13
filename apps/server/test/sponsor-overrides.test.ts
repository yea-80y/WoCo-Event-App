/**
 * Proves the nonce we pass to each sponsor contract call is consumed by ethers
 * as a transaction OVERRIDE, not as a positional argument.
 *
 * This is the load-bearing assumption of the sponsor nonce queue and it is
 * invisible to TypeScript: ethers types contract methods as (...args: any[]),
 * so passing an extra object type-checks either way. If ethers were to bind it
 * positionally the call would fail at runtime, on the money path, in
 * production. So it gets asserted against real ethers, for every call shape
 * routed through sendSponsorTx.
 *
 * ethers v6 treats a trailing object as overrides only when
 * `args.length === fragment.inputs.length + 1`. These cases lock that in.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Contract } from "ethers";

const ADDR = "0x0000000000000000000000000000000000000001";
const B32 = `0x${"11".repeat(32)}`;

/** populateTransaction runs the same overrides handling as an actual send. */
async function nonceOf(abi: string[], fn: string, args: unknown[]): Promise<number | undefined> {
  const c = new Contract(ADDR, abi);
  const tx = await (c.getFunction(fn) as any).populateTransaction(...args, { nonce: 42 });
  return tx.nonce;
}

test("registerEvent (6 scalar args) takes the nonce as an override", async () => {
  const abi = [
    "function registerEvent(uint256 supply, uint128 priceBaseUnits, address payoutRecipient, address dropGate, bytes32 manifestRef, uint64 eventEndTs) returns (bytes32)",
  ];
  assert.equal(await nonceOf(abi, "registerEvent", [10, 0n, ADDR, ADDR, B32, 1784390700]), 42);
});

test("batchClaimFor (address[] arg) takes the nonce as an override", async () => {
  const abi = [
    "function batchClaimFor(bytes32 eventId, address[] burners, bytes32 orderRef) returns (uint256)",
  ];
  assert.equal(await nonceOf(abi, "batchClaimFor", [B32, [ADDR, ADDR], B32]), 42);
});

test("claimFor (3 args) takes the nonce as an override", async () => {
  const abi = ["function claimFor(bytes32 eventId, address burner, bytes32 orderRef) returns (uint256)"];
  assert.equal(await nonceOf(abi, "claimFor", [B32, ADDR, B32]), 42);
});

test("EAS attest (single tuple arg) takes the nonce as an override", async () => {
  // The shape most at risk: one struct argument. A positional bind would try to
  // ABI-encode {nonce:42} as a second tuple and throw.
  const abi = [
    "function attest(tuple(bytes32 schema, tuple(address recipient, uint64 expirationTime, bool revocable, bytes32 refUID, bytes data, uint256 value) data) request) payable returns (bytes32)",
  ];
  const request = {
    schema: B32,
    data: {
      recipient: ADDR,
      expirationTime: 0n,
      revocable: true,
      refUID: B32,
      data: "0x",
      value: 0n,
    },
  };
  assert.equal(await nonceOf(abi, "attest", [request]), 42);
});

test("sub-ENS register (string[] args) takes the nonce as an override", async () => {
  const abi = [
    "function register(string label, address owner, bytes contenthash, string[] textKeys, string[] textValues)",
  ];
  assert.equal(await nonceOf(abi, "register", ["woco", ADDR, "0x", ["url"], ["https://x"]]), 42);
});

test("Stylus record (1 bytes32 arg) takes the nonce as an override", async () => {
  const abi = ["function record(bytes32 uid)"];
  assert.equal(await nonceOf(abi, "record", [B32]), 42);
});

test("sanity: the nonce object is NOT silently encoded as calldata", async () => {
  // Guards the failure mode this suite exists for — if ethers ever bound the
  // override positionally, calldata would differ from the same call made
  // without it. Identical calldata proves it went to the tx envelope.
  const abi = ["function record(bytes32 uid)"];
  const c = new Contract(ADDR, abi);
  const withOverride = await (c.getFunction("record") as any).populateTransaction(B32, { nonce: 42 });
  const without = await (c.getFunction("record") as any).populateTransaction(B32);
  assert.equal(withOverride.data, without.data, "override leaked into calldata");
  assert.equal(without.nonce, undefined);
});
