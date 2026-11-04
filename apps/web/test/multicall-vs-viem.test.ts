/**
 * The seat map's hand-written Multicall3 encoder (`@woco/shared/chain/multicall`) must
 * produce and read exactly the bytes viem does. viem stays out of shared and out of
 * the map's chunk; it is the reference here only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionResult, encodeFunctionData, encodeFunctionResult, parseAbi } from "viem";
import { decodeAggregate3, encodeAggregate3, uintAt } from "@woco/shared/chain/multicall";
import { seatBatch } from "@woco/shared/seating/chain";

const MULTICALL_ABI = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);
const LEDGER_ABI = parseAbi([
  "function getEvent(bytes32 eventId) view returns (uint64 totalSupply, uint64 nextSlot, address organiser, bytes32 manifestRef)",
  "function isSeated(bytes32 eventId) view returns (bool)",
  "function getEventStatus(bytes32 eventId) view returns (uint64 eventEndTs, bool cancelled)",
  "function remaining(bytes32 eventId) view returns (uint256)",
  "function getCurrentBlockTimestamp() view returns (uint256)",
  "function seatWord(bytes32 eventId, uint256 word) view returns (uint256)",
  "function seatNonces(bytes32 eventId, uint256 seat) view returns (uint256)",
  "function arbBlockNumber() view returns (uint256)",
]);

const ledger = "0x5cD8394EF7A4E50403fF72d6aDDd4582332A6050";
const eventId = `0x${"7e".repeat(32)}` as const;

test("aggregate3 calldata is byte-identical to viem's", () => {
  const batch = seatBatch(ledger.toLowerCase(), eventId, { event: true, words: [0, 1, 781], nonceSeats: [3, 199_999] });
  const mine = encodeAggregate3(batch.calls);
  const theirs = encodeFunctionData({
    abi: MULTICALL_ABI,
    functionName: "aggregate3",
    args: [batch.calls.map((c) => ({ target: c.target as `0x${string}`, allowFailure: true, callData: c.data as `0x${string}` }))],
  });
  assert.equal(mine, theirs);
});

test("each call's calldata is what viem encodes for that view", () => {
  const batch = seatBatch(ledger.toLowerCase(), eventId, { event: true, words: [5], nonceSeats: [42] });
  const expected = [
    encodeFunctionData({ abi: LEDGER_ABI, functionName: "arbBlockNumber" }),
    encodeFunctionData({ abi: LEDGER_ABI, functionName: "getEvent", args: [eventId] }),
    encodeFunctionData({ abi: LEDGER_ABI, functionName: "isSeated", args: [eventId] }),
    encodeFunctionData({ abi: LEDGER_ABI, functionName: "getEventStatus", args: [eventId] }),
    encodeFunctionData({ abi: LEDGER_ABI, functionName: "remaining", args: [eventId] }),
    encodeFunctionData({ abi: LEDGER_ABI, functionName: "getCurrentBlockTimestamp" }),
    encodeFunctionData({ abi: LEDGER_ABI, functionName: "seatWord", args: [eventId, 5n] }),
    encodeFunctionData({ abi: LEDGER_ABI, functionName: "seatNonces", args: [eventId, 42n] }),
  ];
  assert.deepEqual(batch.calls.map((c) => c.data), expected);
});

test("an aggregate3 answer viem encodes decodes to the same values, failures as null", () => {
  const word = (2n ** 255n) | 5n;
  const returnData = [
    { success: true, returnData: encodeFunctionResult({ abi: LEDGER_ABI, functionName: "arbBlockNumber", result: 520_749_813n }) },
    { success: true, returnData: encodeFunctionResult({ abi: LEDGER_ABI, functionName: "seatWord", result: word }) },
    { success: false, returnData: "0x08c379a0" as `0x${string}` },
    {
      success: true,
      returnData: encodeFunctionResult({
        abi: LEDGER_ABI, functionName: "getEvent",
        result: [100n, 7n, "0x1111111111111111111111111111111111111111", `0x${"22".repeat(32)}`],
      }),
    },
  ];
  const hex = encodeFunctionResult({ abi: MULTICALL_ABI, functionName: "aggregate3", result: returnData });
  const viemSaw = decodeFunctionResult({ abi: MULTICALL_ABI, functionName: "aggregate3", data: hex });
  assert.equal(viemSaw.length, 4);
  const out = decodeAggregate3(hex, [32, 32, 32, 128]);
  assert.equal(uintAt(out[0]!, 0), 520_749_813n);
  assert.equal(uintAt(out[1]!, 0), word);
  assert.equal(out[2], null);
  assert.equal(uintAt(out[3]!, 1), 7n);
});
