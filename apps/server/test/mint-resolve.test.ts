/**
 * #994 — a card-sale mint whose send failed after broadcast began is read from
 * the chain, never assumed rolled back; slots map by owner, never by log order.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Interface, Wallet, isError, makeError, zeroPadValue } from "ethers";
import {
  broadcastMint,
  MintUnresolvedError,
  resolveMint,
  slotsByOwner,
  type MintLog,
  type MintLogFilter,
  type MintReceipt,
  type MintResolveIo,
} from "../src/lib/chain/mint-resolve.js";
import { isNonceError } from "../src/lib/chain/sponsor-nonce.js";

const IFACE = new Interface([
  "event SlotClaimed(bytes32 indexed eventId, uint256 indexed slot, address indexed owner, address claimer, bytes32 orderRef)",
]);
const CONTRACT = "0xEa6Eb3E153164c451A3CCdc41e1D93Cc76Ba65A2";
const OTHER_CONTRACT = "0x00d0054Ca80d97014947CE97d58402EbED0946EE";
const EVENT = "0x" + "ab".repeat(32);
const OTHER_EVENT = "0x" + "cd".repeat(32);
const ORDER = "0x" + "11".repeat(32);
const SPONSOR = "0x22faf0000000000000000000000000000000beef";
const HASH = "0x" + "77".repeat(32);
const owners = [Wallet.createRandom().address, Wallet.createRandom().address, Wallet.createRandom().address];

function slotLog(owner: string, slot: number, opts: { contract?: string; eventId?: string } = {}): MintLog {
  const { data, topics } = IFACE.encodeEventLog("SlotClaimed", [opts.eventId ?? EVENT, slot, owner, SPONSOR, ORDER]);
  return { address: opts.contract ?? CONTRACT, topics, data };
}

/** Fake chain reads with a virtual clock; each poll consumes the next scripted answer (the last repeats). */
function fakeIo(script: {
  receipts?: Array<MintReceipt | null | Error>;
  logs?: Array<MintLog[] | Error>;
}) {
  let clock = 0;
  const calls = { receipt: 0, logs: 0, sleeps: 0, filters: [] as MintLogFilter[] };
  const pick = <T>(arr: T[] | undefined, i: number, dflt: T): T => (arr && arr.length ? arr[Math.min(i, arr.length - 1)]! : dflt);
  const io: MintResolveIo = {
    async getReceipt() {
      const r = pick(script.receipts, calls.receipt++, null as MintReceipt | null | Error);
      if (r instanceof Error) throw r;
      return r;
    },
    async getLogs(filter) {
      calls.filters.push(filter);
      const r = pick(script.logs, calls.logs++, [] as MintLog[] | Error);
      if (r instanceof Error) throw r;
      return r;
    },
    async sleep(ms) {
      calls.sleeps++;
      clock += ms;
    },
    now: () => clock,
  };
  return { io, calls };
}

const attempt = { hash: HASH, contract: CONTRACT, eventId: EVENT, owners, fromBlock: 1234 };

test("slots map by owner, not by log order or by foreign logs", () => {
  const logs = [slotLog(owners[2]!, 12), slotLog(owners[1]!, 11), slotLog(owners[0]!, 10), slotLog(owners[0]!, 99, { contract: OTHER_CONTRACT })];
  assert.deepEqual(slotsByOwner(logs, CONTRACT, EVENT, owners), [10, 11, 12]);
  // Another event's log for the same owner is not this sale's slot.
  assert.equal(slotsByOwner([slotLog(owners[0]!, 5, { eventId: OTHER_EVENT })], CONTRACT, EVENT, [owners[0]!]), null);
  // A batch is all-or-nothing on chain: a partial set is not an answer.
  assert.equal(slotsByOwner([slotLog(owners[0]!, 10)], CONTRACT, EVENT, owners), null);
});

test("an executed receipt resolves at once, slots in owner order", async () => {
  const { io, calls } = fakeIo({ receipts: [{ status: 1, logs: [slotLog(owners[1]!, 8), slotLog(owners[0]!, 7), slotLog(owners[2]!, 9)] }] });
  assert.deepEqual(await resolveMint(attempt, io), { kind: "minted", slots: [7, 8, 9] });
  assert.equal(calls.logs, 0, "no log query when the receipt answered");
});

test("a send that failed after broadcast but landed is minted, not refunded", async () => {
  const minted = { status: 1, logs: owners.map((o, i) => slotLog(o, 20 + i)) };
  const { io, calls } = fakeIo({ receipts: [null, null, minted] });
  assert.deepEqual(await resolveMint(attempt, io), { kind: "minted", slots: [20, 21, 22] });
  assert.equal(calls.sleeps, 2);
});

test("with no receipt for our hash (replaced, replica lag), the owners' logs are the authority", async () => {
  const { io } = fakeIo({ receipts: [null], logs: [[], owners.map((o, i) => slotLog(o, 30 + i))] });
  assert.deepEqual(await resolveMint(attempt, io), { kind: "minted", slots: [30, 31, 32] });
});

test("a reverted receipt is definitively not minted", async () => {
  const { io } = fakeIo({ receipts: [{ status: 0, logs: [] }] });
  assert.deepEqual(await resolveMint(attempt, io), { kind: "not-minted", why: `transaction ${HASH} reverted` });
});

test("an executed receipt missing a log falls through to the log query", async () => {
  const { io } = fakeIo({
    receipts: [{ status: 1, logs: [slotLog(owners[0]!, 40)] }],
    logs: [owners.map((o, i) => slotLog(o, 40 + i))],
  });
  assert.deepEqual(await resolveMint(attempt, io), { kind: "minted", slots: [40, 41, 42] });
});

test("RPC failures while polling are not answers", async () => {
  const boom = new Error("502 Bad Gateway");
  const { io } = fakeIo({
    receipts: [boom, boom, { status: 1, logs: owners.map((o, i) => slotLog(o, 50 + i)) }],
    logs: [boom],
  });
  assert.deepEqual(await resolveMint(attempt, io), { kind: "minted", slots: [50, 51, 52] });
});

test("nothing by the bound throws MintUnresolvedError, after querying from the pre-send block by owner", async () => {
  const { io, calls } = fakeIo({});
  await assert.rejects(resolveMint(attempt, io, { boundMs: 10_000, pollMs: 2_000 }), (err: unknown) => {
    assert.ok(err instanceof MintUnresolvedError);
    assert.equal(err.hash, HASH);
    assert.deepEqual(err.owners, owners);
    return true;
  });
  assert.ok(calls.receipt >= 5, "kept polling to the bound");
  const f = calls.filters[0]!;
  assert.equal(f.fromBlock, 1234);
  assert.equal(f.address, CONTRACT);
  assert.equal(f.topics[1], EVENT);
  assert.deepEqual(f.topics[3], owners.map((o) => zeroPadValue(o.toLowerCase(), 32)));
});

// broadcastMint: the phase a failure came from decides whether the chain is read.

/** The sponsor queue's behaviour: one re-run of the send after a nonce refusal. */
const queueLikeSponsor = async (send: (o: { nonce: number }) => Promise<string>) => {
  try {
    return await send({ nonce: 7 });
  } catch (err) {
    if (!isNonceError(err)) throw err;
    return await send({ nonce: 8 });
  }
};
const prepared = (n: number) => ({ signed: `0xsigned${n}`, hash: `0x${String(n).repeat(64)}`, fromBlock: 100 + n });
const isRefusal = (err: unknown) => isNonceError(err) || isError(err, "INSUFFICIENT_FUNDS");

test("a failure before the raw send is a refusal, and nothing is sent", async () => {
  let sends = 0;
  const revert = new Error("execution reverted: InsufficientSupply()");
  const out = await broadcastMint({
    queue: queueLikeSponsor,
    prepare: async () => { throw revert; },
    sendRaw: async () => { sends++; },
    isRefusal,
  });
  assert.deepEqual(out, { kind: "refused", err: revert });
  assert.equal(sends, 0);
});

test("a transport failure on the raw send is ambiguous and carries the hash", async () => {
  const timeout = makeError("request timeout", "TIMEOUT");
  const out = await broadcastMint({ queue: queueLikeSponsor, prepare: async (o) => prepared(o.nonce), sendRaw: async () => { throw timeout; }, isRefusal });
  assert.equal(out.kind, "ambiguous");
  assert.equal(out.kind === "ambiguous" && out.hash, prepared(7).hash);
  assert.equal(out.kind === "ambiguous" && out.fromBlock, 107);
});

test("'already known' is ambiguous: the node has the transaction", async () => {
  const known = new Error("already known");
  const out = await broadcastMint({ queue: queueLikeSponsor, prepare: async (o) => prepared(o.nonce), sendRaw: async () => { throw known; }, isRefusal });
  assert.equal(out.kind, "ambiguous");
});

test("a node refusal of the raw send (insufficient funds) is a refusal", async () => {
  const broke = makeError("insufficient funds for intrinsic transaction cost", "INSUFFICIENT_FUNDS", {} as never);
  const out = await broadcastMint({ queue: queueLikeSponsor, prepare: async (o) => prepared(o.nonce), sendRaw: async () => { throw broke; }, isRefusal });
  assert.equal(out.kind, "refused");
});

test("a retry after a nonce refusal starts unbroadcast: its failure before sending is a refusal", async () => {
  let tries = 0;
  const out = await broadcastMint({
    queue: queueLikeSponsor,
    prepare: async (o) => {
      if (++tries === 2) throw new Error("execution reverted: SalesClosed()");
      return prepared(o.nonce);
    },
    sendRaw: async () => { throw makeError("nonce has already been used", "NONCE_EXPIRED", {} as never); },
    isRefusal,
  });
  assert.equal(out.kind, "refused");
});

test("a send the node takes reports the hash and the pre-send block", async () => {
  const out = await broadcastMint({ queue: queueLikeSponsor, prepare: async (o) => prepared(o.nonce), sendRaw: async () => "0xok", isRefusal });
  assert.deepEqual(out, { kind: "sent", hash: prepared(7).hash, fromBlock: 107 });
});
