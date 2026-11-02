/**
 * The server on WoCoTicketLedger version 2 ("ledger2", #983 step 5).
 *
 * What a successor at a new address can get silently wrong, each pinned
 * against a local JSON-RPC stub so the calldata and the errors are the ones
 * ethers really produces:
 *
 *  - card sales must mint through `batchClaimBearer`. Minted any other way the
 *    tickets work, and no ticket can ever be re-pointed, which only shows up on
 *    the day an email reaches a stranger;
 *  - the one-way `disableBearerMints` must refuse a checkout BEFORE the charge,
 *    and an address that does not answer it (a version-1 ledger configured as
 *    ledger2) is a config error, not a sale that fails after payment;
 *  - holdings must not count a reissued slot, whose `SlotClaimed` log still
 *    names its old owner.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Interface, Wallet, getAddress } from "ethers";

const CHAIN = 31338;
const SPONSOR_KEY = Wallet.createRandom().privateKey;
process.env.WOCO_SPONSOR_PRIVATE_KEY = SPONSOR_KEY;

const {
  batchClaimForOnChain, checkSponsorCanMint, readBearerMintsOn, readTicketMintPolicy, resolveRegisterTx,
  registerEventOnChain, OrganiserKeyRequiredError,
} = await import("../src/lib/chain/sponsor-wallet.js");
const { getOnChainEventAt, EventContractConfigError } = await import("../src/lib/chain/event-contract.js");
const { LEDGER2_ABI } = await import("../src/lib/chain/event-contract-ledger.js");
const { getOnChainHolding } = await import("../src/lib/object/holdings.js");
const { sponsorGateRefusal } = await import("../src/lib/stripe/sponsor-gate.js");

import type { EventContractTarget } from "../src/lib/chain/event-contract.js";
import type { SponsorMintReads } from "../src/lib/chain/sponsor-wallet.js";

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

/** Sets env so the active contract is ledger2 at LEDGER2, for `fn`, then restores it. */
async function onLedger2<T>(fn: () => Promise<T>): Promise<T> {
  const keys = ["WOCO_EVENT_CHAIN_ID", `WOCO_EVENT_VERSION_${CHAIN}`, `WOCO_EVENT_ADDRESS_LEDGER2_${CHAIN}`] as const;
  const saved = keys.map((k) => process.env[k]);
  process.env.WOCO_EVENT_CHAIN_ID = String(CHAIN);
  process.env[`WOCO_EVENT_VERSION_${CHAIN}`] = "ledger2";
  process.env[`WOCO_EVENT_ADDRESS_LEDGER2_${CHAIN}`] = LEDGER2.address;
  try {
    return await fn();
  } finally {
    keys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
  }
}

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

// ---------------------------------------------------------------------------
// The pre-charge gate
// ---------------------------------------------------------------------------

function gateReads(o: { bearerOn?: boolean; calls: string[] }): SponsorMintReads {
  return {
    isSponsorReady: async () => (o.calls.push("isSponsorReady"), true),
    readSponsorMintAllowance: async () => (o.calls.push("readSponsorMintAllowance"), { perHour: 50, mintable: 2, windowResetsAt: 0 }),
    readBearerMintsOn: async () => (o.calls.push("readBearerMintsOn"), o.bearerOn ?? true),
  };
}

test("ledger2 keeps the hourly mint cap: the checkout gate reads it", async () => {
  const calls: string[] = [];
  const v = await checkSponsorCanMint(LEDGER2, 3, gateReads({ calls }));
  assert.deepEqual(calls, ["isSponsorReady", "readBearerMintsOn", "readSponsorMintAllowance"]);
  assert.equal(v.ok, false, "a spent window must refuse before the buyer is charged");
});

test("bearer mints switched off refuse the checkout before the charge, with no retry promise", async () => {
  const calls: string[] = [];
  const v = await checkSponsorCanMint(LEDGER2, 1, gateReads({ calls, bearerOn: false }));
  assert.deepEqual(v, { ok: false, reason: "bearer-mints-off" });
  const r = sponsorGateRefusal(v, 1, Date.now())!;
  assert.equal(r.status, 503);
  assert.equal(r.retryAfterSeconds, undefined);
  assert.doesNotMatch(r.error, /minute|shortly|again/i);
  assert.match(r.log, /disableBearerMints/);
});

test("the version-1 ledger never asks the bearer switch", async () => {
  const calls: string[] = [];
  await checkSponsorCanMint(LEDGER1, 1, gateReads({ calls, bearerOn: false }));
  assert.ok(!calls.includes("readBearerMintsOn"));
});

/** Answers `bearerMintsDisabled()` with `reply`; every other call with an empty result. */
function bearerSwitch(reply: Answer): typeof answer {
  return (m, params) => (m === "eth_call" && callData(params).startsWith(sel("bearerMintsDisabled")) ? reply : { result: null });
}

test("the switch decodes both ways", async () => {
  answer = bearerSwitch({ result: iface.encodeFunctionResult("bearerMintsDisabled", [true]) });
  assert.equal(await readBearerMintsOn(LEDGER2), false);
  answer = bearerSwitch({ result: iface.encodeFunctionResult("bearerMintsDisabled", [false]) });
  // A different address: ethers caches an identical eth_call for 250ms.
  assert.equal(await readBearerMintsOn({ ...LEDGER2, address: "0x" + "3f".repeat(20) }), true);
});

test("an address with no bearerMintsDisabled (a version-1 ledger set as ledger2) is a CONFIG error", async () => {
  // It passes the authorisation and cap reads, which exist on version 1, and
  // would otherwise fail only at the mint, after the buyer is charged.
  answer = bearerSwitch({ result: "0x" });
  await assert.rejects(() => readBearerMintsOn({ ...LEDGER2, address: "0x" + "4f".repeat(20) }), (err) => err instanceof EventContractConfigError);
});

test("an RPC fault on the switch is not a config error, so the route stays free to fail open", async () => {
  answer = () => ({ error: { code: -32603, message: "internal error" } });
  await assert.rejects(
    () => readBearerMintsOn({ ...LEDGER2, address: "0x" + "5f".repeat(20) }),
    (err) => !(err instanceof EventContractConfigError),
  );
});

test("versions without bearer mints read the switch as on, and touch no chain", async () => {
  answer = () => ({ error: { code: -32603, message: "must not be called" } });
  assert.equal(await readBearerMintsOn(LEDGER1), true);
});

test("the health reading reports the switch on ledger2", async () => {
  answer = (m, params) => {
    if (m !== "eth_call") return { result: null };
    const data = callData(params);
    if (data.startsWith(sel("authorisedSponsors"))) return { result: iface.encodeFunctionResult("authorisedSponsors", [true]) };
    if (data.startsWith(sel("sponsorMintAllowance"))) return { result: iface.encodeFunctionResult("sponsorMintAllowance", [50, 50, 0]) };
    if (data.startsWith(sel("bearerMintsDisabled"))) return { result: iface.encodeFunctionResult("bearerMintsDisabled", [true]) };
    return { result: "0x" };
  };
  const policy = await onLedger2(() => readTicketMintPolicy());
  assert.equal(policy.contract.version, "ledger2");
  assert.equal(policy.bearerMints, "off");
});

// ---------------------------------------------------------------------------
// Reads and registration
// ---------------------------------------------------------------------------

test("a ledger2 event reads as on version 1: getEvent alone, nextSlot is the seats sold", async () => {
  const calls: string[] = [];
  answer = (m, params) => {
    if (m !== "eth_call") return { result: null };
    calls.push(callData(params).slice(0, 10));
    return { result: iface.encodeFunctionResult("getEvent", [10, 7, ORGANISER, MANIFEST]) };
  };
  const e = await getOnChainEventAt(LEDGER2, "0x" + "c1".repeat(32));
  assert.deepEqual(e, { totalSupply: 10n, nextSlot: 7n, organiser: ORGANISER, manifestRef: MANIFEST });
  assert.deepEqual(calls, [sel("getEvent")]);
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
  assert.deepEqual(await onLedger2(() => resolveRegisterTx(txHash, 0)), { status: "registered", onChainEventId: eventId, txHash });
});

// ---------------------------------------------------------------------------
// Holdings skip reissued slots
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Registration names the organiser key on ledger2, and only there
// ---------------------------------------------------------------------------

const ORG_KEY = "0x" + "0e".repeat(20);
const REGISTER = { organiser: ORGANISER, eventEndTs: 4_000_000_000, priceBaseUnits: 0n, payoutRecipient: ORGANISER, dropGate: "0x" + "00".repeat(20) };

/** As `onLedger2`, for version 1 of the ledger at LEDGER1. */
async function onLedger1<T>(fn: () => Promise<T>): Promise<T> {
  const keys = ["WOCO_EVENT_CHAIN_ID", `WOCO_EVENT_VERSION_${CHAIN}`, `WOCO_EVENT_ADDRESS_LEDGER_${CHAIN}`] as const;
  const saved = keys.map((k) => process.env[k]);
  process.env.WOCO_EVENT_CHAIN_ID = String(CHAIN);
  process.env[`WOCO_EVENT_VERSION_${CHAIN}`] = "ledger";
  process.env[`WOCO_EVENT_ADDRESS_LEDGER_${CHAIN}`] = LEDGER1.address;
  try {
    return await fn();
  } finally {
    keys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
  }
}

test("on ledger2 registerEvent carries the organiser key beside the organiser", async () => {
  const sent: string[] = [];
  answer = recordMint(sent, iface.encodeErrorResult("InvalidEventEnd", []));
  await assert.rejects(() => onLedger2(() => registerEventOnChain(7, MANIFEST, { ...REGISTER, organiserKey: ORG_KEY })));
  assert.equal(sent.length, 1);
  const decoded = iface.decodeFunctionData("registerEvent", sent[0]!);
  assert.equal(decoded[0].toLowerCase(), ORGANISER);
  assert.equal(decoded[1].toLowerCase(), ORG_KEY, "the key is not the second argument");
  assert.equal(decoded[2], 7n);
  assert.equal(sent[0]!.slice(0, 10), iface.getFunction("registerEvent")!.selector);
});

test("on ledger2 a registration without the organiser key is refused before anything is sent", async () => {
  const sent: string[] = [];
  answer = recordMint(sent, iface.encodeErrorResult("InvalidEventEnd", []));
  await assert.rejects(
    () => onLedger2(() => registerEventOnChain(7, MANIFEST, REGISTER)),
    (e: unknown) => e instanceof OrganiserKeyRequiredError,
  );
  assert.equal(sent.length, 0, "a ledger2 registration without a key reached the chain");
});

test("on ledger version 1 registerEvent keeps its four arguments, whatever key is passed", async () => {
  const v1 = new Interface([
    "function registerEvent(address organiser, uint64 supply, bytes32 manifestRef, uint64 eventEndTs) returns (bytes32 eventId)",
  ]);
  const sent: string[] = [];
  answer = recordMint(sent, iface.encodeErrorResult("InvalidEventEnd", []));
  await assert.rejects(() => onLedger1(() => registerEventOnChain(7, MANIFEST, { ...REGISTER, organiserKey: ORG_KEY })));
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.slice(0, 10), v1.getFunction("registerEvent")!.selector);
  assert.notEqual(v1.getFunction("registerEvent")!.selector, iface.getFunction("registerEvent")!.selector);
  const decoded = v1.decodeFunctionData("registerEvent", sent[0]!);
  assert.equal(decoded[0].toLowerCase(), ORGANISER);
});

test("ledger2 holdings drop a slot whose claim log names the holder but which was reissued away", async () => {
  // Lettered, and asked for checksummed: the owner compare must not depend on case.
  const holder = "0x" + "ab".repeat(20);
  const fresh = "0x" + "cd".repeat(20);
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
    // Slot 0 was reissued to a fresh key. Slot 3 is still held.
    const owner = Number(slot) === 0 ? fresh : holder;
    return { result: iface.encodeFunctionResult("getSlotData", [owner, holder, ORDER_REF]) };
  };
  const h = await onLedger2(() =>
    getOnChainHolding({ holder: getAddress(holder) as `0x${string}`, onChainEventId: eventId, chainId: CHAIN, manifestRef: MANIFEST.slice(2) as never }),
  );
  assert.deepEqual(h.slots, [3]);
  assert.equal(h.count, 1);
});
