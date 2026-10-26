/**
 * The server on WoCoTicketLedger version 2 ("ledger2", #983 step 5).
 *
 * Three things a successor at a new address can get silently wrong, each pinned
 * against a local JSON-RPC stub so the calldata and the errors are the ones
 * ethers really produces:
 *
 *  - card sales must mint through `batchClaimBearer`. Minted any other way the
 *    tickets work, and no ticket can ever be replaced, which only shows up on
 *    the day an email reaches a stranger;
 *  - "sold" and "available" must count seats in use (`getEventAdmin.live`), not
 *    slots ever minted (`nextSlot`): each reissue would otherwise lose one seat
 *    for good, and a full event would sell out early;
 *  - holdings must not count a revoked slot, whose `SlotClaimed` log still names
 *    its old owner.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Interface, Wallet, ZeroAddress, id } from "ethers";

const CHAIN = 31338;
const SPONSOR_KEY = Wallet.createRandom().privateKey;
process.env.WOCO_SPONSOR_PRIVATE_KEY = SPONSOR_KEY;

const { batchClaimForOnChain, checkSponsorCanMint, resolveRegisterTx } = await import("../src/lib/chain/sponsor-wallet.js");
const { getOnChainEventAt, seatsLeft } = await import("../src/lib/chain/event-contract.js");
const { LEDGER2_ABI } = await import("../src/lib/chain/event-contract-ledger.js");
const { getOnChainHolding } = await import("../src/lib/object/holdings.js");

import type { EventContractTarget } from "../src/lib/chain/event-contract.js";

const iface = new Interface(LEDGER2_ABI as unknown as string[]);
const sel = (name: string) => iface.getFunction(name)!.selector;

const LEDGER2: EventContractTarget = { chainId: CHAIN, address: "0x" + "2f".repeat(20), version: "ledger2" };
const LEDGER1: EventContractTarget = { chainId: CHAIN, address: "0x" + "1f".repeat(20), version: "ledger" };
const ORGANISER = "0x" + "0a".repeat(20);
const MANIFEST = "0x" + "4d".repeat(32);
const ORDER_REF = "0x" + "33".repeat(32);
const BURNERS = ["0x" + "22".repeat(20), "0x" + "23".repeat(20)];

type Answer = { result: unknown } | { error: { code: number; message: string; data?: string } };
let answer: (method: string, params: unknown[]) => Answer = () => ({ result: null });
let server: Server;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body) as { id: number; method: string; params: unknown[] } | Array<{ id: number; method: string; params: unknown[] }>;
      const one = (m: { id: number; method: string; params: unknown[] }) => {
        const base = m.method === "eth_chainId" ? { result: "0x" + CHAIN.toString(16) } : answer(m.method, m.params);
        return { jsonrpc: "2.0", id: m.id, ...base };
      };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed)));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env[`RPC_URL_${CHAIN}`] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server?.close();
  server?.closeAllConnections?.();
});

const callData = (params: unknown[]) => String((params[0] as { data?: string })?.data ?? "");

// ---------------------------------------------------------------------------
// Card sales mint bearer
// ---------------------------------------------------------------------------

/** Records the mint's calldata, then reverts it with `revertData` so no tx is sent. */
function recordMint(sent: string[], revertData: string): typeof answer {
  return (m, params) => {
    switch (m) {
      case "eth_getTransactionCount": return { result: "0x0" };
      case "eth_estimateGas":
        sent.push(callData(params));
        return { error: { code: 3, message: "execution reverted", data: revertData } };
      case "eth_gasPrice": return { result: "0x1" };
      case "eth_maxPriorityFeePerGas": return { result: "0x1" };
      default: return { result: null };
    }
  };
}

// Distinct event ids per test: ethers caches an identical request for 250ms.
test("on ledger2 a card sale mints through batchClaimBearer, never batchClaimFor", async () => {
  const sent: string[] = [];
  answer = recordMint(sent, iface.encodeErrorResult("SalesClosed", []));
  await assert.rejects(() => batchClaimForOnChain("0x" + "b1".repeat(32), BURNERS, ORDER_REF, LEDGER2));
  assert.deepEqual(sent.map((d) => d.slice(0, 10)), [sel("batchClaimBearer")]);
  assert.notEqual(sel("batchClaimBearer"), sel("batchClaimFor"));
});

test("on the version-1 ledger the same sale still mints through batchClaimFor", async () => {
  const sent: string[] = [];
  answer = recordMint(sent, iface.encodeErrorResult("SalesClosed", []));
  await assert.rejects(() => batchClaimForOnChain("0x" + "b2".repeat(32), BURNERS, ORDER_REF, LEDGER1));
  assert.deepEqual(sent.map((d) => d.slice(0, 10)), [sel("batchClaimFor")]);
});

test("the bearer mint sends every burner and the order ref, in order", async () => {
  const sent: string[] = [];
  answer = recordMint(sent, iface.encodeErrorResult("SalesClosed", []));
  const eventId = "0x" + "b3".repeat(32);
  await assert.rejects(() => batchClaimForOnChain(eventId, BURNERS, ORDER_REF, LEDGER2));
  const args = iface.decodeFunctionData("batchClaimBearer", sent[0]!);
  assert.equal(args[0], eventId);
  assert.deepEqual((args[1] as string[]).map((a) => a.toLowerCase()), BURNERS);
  assert.equal(args[2], ORDER_REF);
});

test("a ledger2 refusal is named in the refund reason, not 'unknown custom error'", async () => {
  answer = recordMint([], iface.encodeErrorResult("BearerMintsOff", []));
  await assert.rejects(
    () => batchClaimForOnChain("0x" + "b4".repeat(32), BURNERS, ORDER_REF, LEDGER2),
    (err) => (err as Error).message === "events contract refused the mint: BearerMintsOff",
  );
});

test("ledger2 keeps the hourly mint cap: the checkout gate reads it", async () => {
  const calls: string[] = [];
  const v = await checkSponsorCanMint(LEDGER2, 3, {
    isSponsorReady: async () => (calls.push("isSponsorReady"), true),
    readSponsorMintAllowance: async () => (calls.push("readSponsorMintAllowance"), { perHour: 50, mintable: 2, windowResetsAt: 0 }),
  });
  assert.deepEqual(calls, ["isSponsorReady", "readSponsorMintAllowance"]);
  assert.equal(v.ok, false, "a spent window must refuse before the buyer is charged");
});

test("the #318 resolver finds a ledger2 Registered log — absent would re-broadcast a duplicate", async () => {
  const eventId = "0x" + "e1".repeat(32);
  const txHash = "0x" + "f1".repeat(32);
  const enc = iface.encodeEventLog(iface.getEvent("Registered")!, [eventId, ORGANISER, ORGANISER, 10, MANIFEST, 9_999_999_999]);
  const receipt = {
    transactionHash: txHash, blockHash: "0x" + "ab".repeat(32), blockNumber: "0x1", transactionIndex: "0x0",
    from: new Wallet(SPONSOR_KEY).address, to: LEDGER2.address, contractAddress: null, status: "0x1", type: "0x2",
    gasUsed: "0x1", cumulativeGasUsed: "0x1", effectiveGasPrice: "0x1", logsBloom: "0x" + "00".repeat(256),
    logs: [{
      address: LEDGER2.address, topics: enc.topics, data: enc.data, blockNumber: "0x1", blockHash: "0x" + "ab".repeat(32),
      transactionHash: txHash, transactionIndex: "0x0", logIndex: "0x0", removed: false,
    }],
  };
  answer = (m) => (m === "eth_getTransactionReceipt" ? { result: receipt } : m === "eth_blockNumber" ? { result: "0x2" } : { result: null });
  const keys = ["WOCO_EVENT_CHAIN_ID", `WOCO_EVENT_VERSION_${CHAIN}`, `WOCO_EVENT_ADDRESS_LEDGER2_${CHAIN}`] as const;
  const saved = keys.map((k) => process.env[k]);
  process.env.WOCO_EVENT_CHAIN_ID = String(CHAIN);
  process.env[`WOCO_EVENT_VERSION_${CHAIN}`] = "ledger2";
  process.env[`WOCO_EVENT_ADDRESS_LEDGER2_${CHAIN}`] = LEDGER2.address;
  try {
    assert.deepEqual(await resolveRegisterTx(txHash, 0), { status: "registered", onChainEventId: eventId, txHash });
  } finally {
    keys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
  }
});

// ---------------------------------------------------------------------------
// Seats in use
// ---------------------------------------------------------------------------

/** getEvent says 10 supply and 7 ever minted; getEventAdmin says 5 in use (two revoked). */
function eventReads(calls: string[], admin: Answer | null = null): typeof answer {
  return (m, params) => {
    if (m !== "eth_call") return { result: null };
    const data = callData(params);
    if (data.startsWith(sel("getEvent"))) {
      calls.push("getEvent");
      return { result: iface.encodeFunctionResult("getEvent", [10, 7, ORGANISER, MANIFEST]) };
    }
    if (data.startsWith(sel("getEventAdmin"))) {
      calls.push("getEventAdmin");
      return admin ?? { result: iface.encodeFunctionResult("getEventAdmin", [ORGANISER, 5, 2]) };
    }
    return { result: "0x" };
  };
}

test("ledger2 reports seats in use from getEventAdmin, beside the slot range", async () => {
  const calls: string[] = [];
  answer = eventReads(calls);
  const e = await getOnChainEventAt(LEDGER2, "0x" + "c1".repeat(32));
  assert.ok(e);
  assert.equal(e.totalSupply, 10n);
  assert.equal(e.nextSlot, 7n, "nextSlot stays the slot range: door and order reads walk it");
  assert.equal(e.inUse, 5n, "seats in use exclude revoked slots");
  assert.deepEqual(calls.sort(), ["getEvent", "getEventAdmin"]);
});

test("seats left count seats in use, so a reissued slot never costs a seat", async () => {
  answer = eventReads([]);
  const e = (await getOnChainEventAt(LEDGER2, "0x" + "c5".repeat(32)))!;
  // 10 supply, 7 slots minted, 2 of them revoked: 5 seats left, not 3.
  assert.equal(seatsLeft(e), 5);
  assert.equal(seatsLeft({ ...e, inUse: 12n }), 0, "never negative");
});

test("the version-1 ledger has no revocation: seats in use are nextSlot, and getEventAdmin is never asked", async () => {
  const calls: string[] = [];
  answer = eventReads(calls);
  const e = await getOnChainEventAt(LEDGER1, "0x" + "c2".repeat(32));
  assert.equal(e?.inUse, 7n);
  assert.deepEqual(calls, ["getEvent"]);
});

test("an unknown ledger2 event reads as absent, exactly as on version 1", async () => {
  const notFound = { error: { code: 3, message: "execution reverted", data: id("EventNotFound()").slice(0, 10) } };
  answer = (m) => (m === "eth_call" ? notFound : { result: null });
  assert.equal(await getOnChainEventAt(LEDGER2, "0x" + "c3".repeat(32)), null);
});

test("a failed seats-in-use read fails the whole read — never a count of zero", async () => {
  // A zero here would read as every seat free and sell past supply.
  answer = eventReads([], { error: { code: -32603, message: "internal error" } });
  await assert.rejects(() => getOnChainEventAt(LEDGER2, "0x" + "c4".repeat(32)));
});

// ---------------------------------------------------------------------------
// Holdings skip revoked slots
// ---------------------------------------------------------------------------

test("ledger2 holdings drop a slot whose claim log names the holder but which was revoked", async () => {
  const holder = "0x" + "77".repeat(20);
  const eventId = "0x" + "d1".repeat(32);
  const ev = iface.getEvent("SlotClaimed")!;
  const log = (slot: number, i: number) => {
    const enc = iface.encodeEventLog(ev, [eventId, slot, holder, holder, ORDER_REF]);
    return {
      address: LEDGER2.address, topics: enc.topics, data: enc.data,
      blockNumber: "0x1", blockHash: "0x" + "ab".repeat(32), transactionHash: "0x" + (i + 1).toString(16).padStart(64, "0"),
      transactionIndex: "0x0", logIndex: "0x" + i.toString(16), removed: false,
    };
  };
  answer = (m, params) => {
    if (m === "eth_blockNumber") return { result: "0x10" };
    if (m === "eth_getLogs") return { result: [log(0, 0), log(3, 1)] };
    if (m !== "eth_call") return { result: null };
    const [, slot] = iface.decodeFunctionData("getSlotData", callData(params));
    // Slot 0 was reissued away: holder reads 0. Slot 3 is still held.
    const owner = Number(slot) === 0 ? ZeroAddress : holder;
    return { result: iface.encodeFunctionResult("getSlotData", [owner, holder, ORDER_REF]) };
  };
  const saved = {
    v: process.env[`WOCO_EVENT_VERSION_${CHAIN}`],
    a: process.env[`WOCO_EVENT_ADDRESS_LEDGER2_${CHAIN}`],
  };
  process.env[`WOCO_EVENT_VERSION_${CHAIN}`] = "ledger2";
  process.env[`WOCO_EVENT_ADDRESS_LEDGER2_${CHAIN}`] = LEDGER2.address;
  try {
    const h = await getOnChainHolding({ holder: holder as `0x${string}`, onChainEventId: eventId, chainId: CHAIN, manifestRef: MANIFEST.slice(2) as never });
    assert.deepEqual(h.slots, [3]);
    assert.equal(h.count, 1);
  } finally {
    for (const [k, v] of [[`WOCO_EVENT_VERSION_${CHAIN}`, saved.v], [`WOCO_EVENT_ADDRESS_LEDGER2_${CHAIN}`, saved.a]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
