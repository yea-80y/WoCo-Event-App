import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  ARBSYS_ADDRESS, ARB_BLOCK_NUMBER, MULTICALL3_ADDRESS, RpcError, abiWord, boolAt, bytes32At, decodeAggregate3,
  encodeAggregate3, ethCall, multicall, staticCall, uintAt,
} from "../../src/chain/multicall.js";
import { MULTICALL3_ADDRESS as FROM_TERMS } from "../../src/ticket/ledger2-terms.js";
import { seatBatch, seatWordCount } from "../../src/seating/chain.js";

const selector = (sig: string) => bytesToHex(keccak_256(new TextEncoder().encode(sig))).slice(0, 8);
const w = (n: number | bigint) => BigInt(n).toString(16).padStart(64, "0");

/** An aggregate3 answer, built the long way: (bool, bytes)[] with each tuple's own offsets. */
function answer(results: ({ ok: boolean; data: string })[]): string {
  const tuples = results.map((r) => {
    const len = r.data.length / 2;
    return w(r.ok ? 1 : 0) + w(0x40) + w(len) + r.data.padEnd(Math.ceil(len / 32) * 64, "0");
  });
  let off = 32 * tuples.length;
  const offs = tuples.map((t) => { const o = w(off); off += t.length / 2; return o; });
  return `0x${w(0x20)}${w(results.length)}${offs.join("")}${tuples.join("")}`;
}

test("selectors are the keccak of the signatures they claim", () => {
  assert.equal(ARB_BLOCK_NUMBER, `0x${selector("arbBlockNumber()")}`);
  assert.ok(encodeAggregate3([]).startsWith(`0x${selector("aggregate3((address,bool,bytes)[])")}`));
  const batch = seatBatch(`0x${"11".repeat(20)}`, `0x${"22".repeat(32)}`, { event: true, words: [0], nonceSeats: [7] });
  const sels = batch.calls.map((c) => c.data.slice(2, 10));
  assert.deepEqual(sels, [
    selector("arbBlockNumber()"), selector("getEvent(bytes32)"), selector("isSeated(bytes32)"), selector("getEventStatus(bytes32)"),
    selector("remaining(bytes32)"), selector("getCurrentBlockTimestamp()"), selector("seatWord(bytes32,uint256)"),
    selector("seatNonces(bytes32,uint256)"),
  ]);
  assert.equal(batch.calls[0].target, ARBSYS_ADDRESS);
  assert.equal(batch.calls[5].target, MULTICALL3_ADDRESS);
  assert.equal(FROM_TERMS, MULTICALL3_ADDRESS, "one constant, re-exported");
});

test("golden vector: one call", () => {
  const hex = encodeAggregate3([{ target: ARBSYS_ADDRESS, data: ARB_BLOCK_NUMBER }]);
  assert.equal(
    hex,
    "0x82ad56cb" + w(0x20) + w(1) + w(0x20) +
      w(0x64) + w(1) + w(0x60) + w(4) + "a3b1b31d".padEnd(64, "0"),
  );
});

test("static calls pad every argument to a word and refuse bad input", () => {
  assert.equal(staticCall("0x10173035", `0x${"ab".repeat(32)}`, 3), `0x10173035${"ab".repeat(32)}${w(3)}`);
  assert.throws(() => staticCall("1017303", 1));
  assert.throws(() => abiWord(-1n));
  assert.throws(() => abiWord("0xzz"));
  assert.throws(() => encodeAggregate3([{ target: "0x1234", data: "0x" }]));
});

test("decode: answers in order, a failed call or a wrong length is null", () => {
  const hex = answer([
    { ok: true, data: w(42) },
    { ok: false, data: w(1) },
    { ok: true, data: w(1) + w(2) },
    { ok: true, data: "" },
  ]);
  const out = decodeAggregate3(hex, [32, 32, 32, 0]);
  assert.equal(uintAt(out[0]!, 0), 42n);
  assert.equal(out[1], null, "success = false");
  assert.equal(out[2], null, "64 bytes where 32 were expected");
  assert.deepEqual(out[3], new Uint8Array(0));
  assert.throws(() => decodeAggregate3(hex, [32, 32]), /different number/);
  assert.throws(() => decodeAggregate3("0x1234", [32]));
  assert.throws(() => decodeAggregate3(hex.slice(0, 200), [32, 32, 32, 0]));
});

test("words as bool and bytes32", () => {
  const b = Uint8Array.from(Buffer.from(w(1) + w(2) + "cd".repeat(32), "hex"));
  assert.equal(boolAt(b, 0), true);
  assert.equal(boolAt(b, 1), null, "2 is not a bool");
  assert.equal(bytes32At(b, 2), `0x${"cd".repeat(32)}`);
});

test("a seat batch decodes event, words and nonces; any failed event view drops the event read", () => {
  const ledger = `0x${"11".repeat(20)}`, id = `0x${"22".repeat(32)}`;
  const batch = seatBatch(ledger, id, { event: true, words: [0, 1], nonceSeats: [300] });
  const ok = (data: string) => ({ ok: true, data });
  const results = [
    ok(w(520_000_000)),
    ok(w(500) + w(12) + w(`0x${"33".repeat(20)}`) + "44".repeat(32)),
    ok(w(1)),
    ok(w(1_800_000_000) + w(0)),
    ok(w(488)),
    ok(w(1_700_000_000)),
    ok(w(5)),
    ok(w(0)),
    ok(w(2)),
  ];
  const read = batch.decode(decodeAggregate3(answer(results), batch.expect));
  assert.equal(read.block, 520_000_000n);
  assert.deepEqual(read.event, {
    totalSupply: 500n, nextSlot: 12n, manifestRef: `0x${"44".repeat(32)}`, seated: true,
    eventEndTs: 1_800_000_000n, cancelled: false, remaining: 488n, blockTs: 1_700_000_000n,
  });
  assert.deepEqual([...read.words], [[0, 5n], [1, 0n]]);
  assert.deepEqual([...read.nonces], [[300, 2n]]);

  const failed = [...results];
  failed[2] = { ok: false, data: "" };
  assert.equal(batch.decode(decodeAggregate3(answer(failed), batch.expect)).event, null);
  const noBlock = [...results];
  noBlock[0] = { ok: false, data: "" };
  assert.equal(batch.decode(decodeAggregate3(answer(noBlock), batch.expect)).block, null);
  assert.equal(seatWordCount(256), 1);
  assert.equal(seatWordCount(257), 2);
});

test("eth_call: the result, or an RpcError that says whether to back off", async () => {
  const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  assert.equal(await ethCall("https://rpc", { target: MULTICALL3_ADDRESS, data: "0x" }, reply(200, { result: "0xabcd" })), "0xabcd");
  await assert.rejects(ethCall("https://rpc", { target: MULTICALL3_ADDRESS, data: "0x" }, reply(429, {})), (e: RpcError) => e.rateLimited);
  await assert.rejects(ethCall("https://rpc", { target: MULTICALL3_ADDRESS, data: "0x" }, reply(200, { error: { code: -32000, message: "x" } })), (e: RpcError) => !e.rateLimited);
  await assert.rejects(ethCall("https://rpc", { target: MULTICALL3_ADDRESS, data: "0x" }, reply(500, {})), RpcError);
  let sent: { to: string; data: string } | null = null;
  const capture = (async (_u: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body)).params[0];
    return new Response(JSON.stringify({ result: answer([{ ok: true, data: w(9) }]) }));
  }) as unknown as typeof fetch;
  const out = await multicall("https://rpc", [{ target: ARBSYS_ADDRESS, data: ARB_BLOCK_NUMBER }], [32], capture);
  assert.equal(uintAt(out[0]!, 0), 9n);
  assert.equal(sent!.to, MULTICALL3_ADDRESS);
});
