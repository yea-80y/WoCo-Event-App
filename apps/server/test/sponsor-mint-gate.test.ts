/**
 * The pre-charge sponsor gate and the ledger's hourly mint cap (#662).
 *
 * Before this, `isSponsorReady` read only `authorisedSponsors` and cached a
 * positive for ten minutes, so a sponsor the owner had capped to 0 — or whose
 * window was spent — passed the checkout gate: the buyer was charged, the mint
 * reverted `MintCapExceeded`, and the webhook refunded. Pinned here:
 *
 *  - the cap is read on EVERY checkout (never cached) and refuses `quantity`
 *    it cannot mint;
 *  - a refusal that waiting cannot lift (cap 0, or an order bigger than the
 *    whole cap) never names a retry time or sends `Retry-After`;
 *  - an address that does not speak the cap ABI is a CONFIG error (the route
 *    fails closed on it), while a transport failure stays a plain error (the
 *    route fails open on it, as it always has).
 *
 * The last two are driven through a local JSON-RPC stub, so they exercise the
 * errors ethers really throws rather than hand-built shapes.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Interface, Wallet } from "ethers";

const CHAIN = 31337;
const SPONSOR_KEY = Wallet.createRandom().privateKey;
process.env.WOCO_SPONSOR_PRIVATE_KEY = SPONSOR_KEY;
const SPONSOR = new Wallet(SPONSOR_KEY).address.toLowerCase();

const {
  checkSponsorCanMint,
  evaluateSponsorMint,
  readSponsorMintAllowance,
  readTicketMintPolicy,
} = await import("../src/lib/chain/sponsor-wallet.js");
const { EventContractConfigError } = await import("../src/lib/chain/event-contract.js");
const { LEDGER_ABI, LEDGER_UNLIMITED_MINTS, MintCapExceededError, batchClaimForLedger } =
  await import("../src/lib/chain/event-contract-ledger.js");
const { sponsorGateRefusal } = await import("../src/lib/stripe/sponsor-gate.js");

import type { EventContractTarget } from "../src/lib/chain/event-contract.js";
import type { SponsorMintReads } from "../src/lib/chain/sponsor-wallet.js";

const LEDGER: EventContractTarget = { chainId: CHAIN, address: "0x" + "1e".repeat(20), version: "ledger" };
const V2: EventContractTarget = { chainId: CHAIN, address: "0x" + "2e".repeat(20), version: "v2" };
const NOW_S = 1_790_000_000;

function reads(o: {
  authorised?: boolean;
  allowance?: { perHour: number; mintable: number; windowResetsAt: number };
  calls?: string[];
}): SponsorMintReads {
  return {
    isSponsorReady: async () => {
      o.calls?.push("isSponsorReady");
      return o.authorised ?? true;
    },
    readSponsorMintAllowance: async () => {
      o.calls?.push("readSponsorMintAllowance");
      return o.allowance ?? { perHour: 100, mintable: 100, windowResetsAt: NOW_S + 3600 };
    },
  };
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

test("an authorised sponsor with room in its window may mint", () => {
  assert.deepEqual(evaluateSponsorMint(true, { perHour: 100, mintable: 10, windowResetsAt: NOW_S }, 10), { ok: true });
});

test("fewer mintable than the order is refused, and says when the window resets", () => {
  const v = evaluateSponsorMint(true, { perHour: 100, mintable: 9, windowResetsAt: NOW_S }, 10);
  assert.deepEqual(v, { ok: false, reason: "mint-cap", perHour: 100, mintable: 9, retryAt: NOW_S });
});

test("cap 0 (the owner's stop) is refused with NO retry time — a reset lifts nothing", () => {
  const v = evaluateSponsorMint(true, { perHour: 0, mintable: 0, windowResetsAt: NOW_S }, 1);
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason === "mint-cap" ? v.retryAt : "wrong", null);
});

test("an order bigger than a whole window's cap is refused with no retry time — it never fits", () => {
  const v = evaluateSponsorMint(true, { perHour: 5, mintable: 5, windowResetsAt: NOW_S }, 6);
  assert.equal(v.ok === false && v.reason === "mint-cap" ? v.retryAt : "wrong", null);
});

test("UNLIMITED_MINTS is never refused", () => {
  const unlimited = { perHour: LEDGER_UNLIMITED_MINTS, mintable: LEDGER_UNLIMITED_MINTS, windowResetsAt: 0 };
  assert.deepEqual(evaluateSponsorMint(true, unlimited, 10), { ok: true });
});

test("an unauthorised sponsor is refused whatever its cap says", () => {
  assert.deepEqual(evaluateSponsorMint(false, null, 1), { ok: false, reason: "not-authorised" });
});

test("the ledger's cap is read on EVERY check — never served from a cache", async () => {
  const calls: string[] = [];
  const r = reads({ calls });
  await checkSponsorCanMint(LEDGER, 1, r);
  await checkSponsorCanMint(LEDGER, 1, r);
  assert.equal(calls.filter((c) => c === "readSponsorMintAllowance").length, 2);
});

test("a spent window refuses the checkout end to end", async () => {
  const v = await checkSponsorCanMint(LEDGER, 3, reads({ allowance: { perHour: 50, mintable: 2, windowResetsAt: NOW_S } }));
  assert.equal(v.ok, false);
});

test("V2 has no cap: only authorisation is consulted", async () => {
  const calls: string[] = [];
  assert.deepEqual(await checkSponsorCanMint(V2, 10, reads({ calls, allowance: { perHour: 0, mintable: 0, windowResetsAt: 0 } })), { ok: true });
  assert.deepEqual(calls, ["isSponsorReady"]);
});

test("an unauthorised sponsor is not asked about its cap", async () => {
  const calls: string[] = [];
  const v = await checkSponsorCanMint(LEDGER, 1, reads({ calls, authorised: false }));
  assert.deepEqual(v, { ok: false, reason: "not-authorised" });
  assert.deepEqual(calls, ["isSponsorReady"]);
});

// ---------------------------------------------------------------------------
// What the buyer is told
// ---------------------------------------------------------------------------

test("a spent window sends Retry-After and names the wait in minutes", () => {
  const r = sponsorGateRefusal(
    { ok: false, reason: "mint-cap", perHour: 50, mintable: 0, retryAt: NOW_S + 125 },
    1,
    NOW_S * 1000,
  )!;
  assert.equal(r.status, 503);
  assert.equal(r.retryAfterSeconds, 125);
  assert.match(r.error, /3 minutes/);
});

test("a stopped sponsor gets no Retry-After and no promise of a time", () => {
  const r = sponsorGateRefusal(
    { ok: false, reason: "mint-cap", perHour: 0, mintable: 0, retryAt: null },
    1,
    NOW_S * 1000,
  )!;
  assert.equal(r.retryAfterSeconds, undefined);
  assert.doesNotMatch(r.error, /minute|shortly|again/i);
  assert.equal(r.error, "Ticketing is temporarily unavailable.");
  assert.match(r.log, /stopped/);
});

test("an order too big for the cap asks for fewer tickets, not for patience", () => {
  const r = sponsorGateRefusal(
    { ok: false, reason: "mint-cap", perHour: 5, mintable: 5, retryAt: null },
    6,
    NOW_S * 1000,
  )!;
  assert.equal(r.retryAfterSeconds, undefined);
  assert.match(r.error, /fewer tickets/);
});

test("a config error refuses; a clear verdict proceeds", () => {
  assert.equal(sponsorGateRefusal("config-error", 1, 0)?.status, 503);
  assert.equal(sponsorGateRefusal({ ok: true }, 1, 0), null);
  assert.equal(sponsorGateRefusal({ ok: false, reason: "not-authorised" }, 1, 0)?.status, 503);
});

// ---------------------------------------------------------------------------
// Against a JSON-RPC stub: the errors ethers really throws
// ---------------------------------------------------------------------------

const iface = new Interface(LEDGER_ABI as unknown as string[]);
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

test("an address that answers the cap view with nothing is a CONFIG error, not a blip", async () => {
  answer = (m) => (m === "eth_call" ? { result: "0x" } : { result: null });
  await assert.rejects(() => readSponsorMintAllowance(LEDGER), (err) => err instanceof EventContractConfigError);
});

test("a contract that reverts the cap view with no data is a CONFIG error", async () => {
  answer = (m) => (m === "eth_call" ? { error: { code: 3, message: "execution reverted", data: "0x" } } : { result: null });
  await assert.rejects(() => readSponsorMintAllowance(LEDGER), (err) => err instanceof EventContractConfigError);
});

test("an address with NO CODE fails the AUTHORISATION read as a config error, not a blip", async () => {
  // The likeliest flip-day mistake: a typo'd or not-yet-deployed ledger address.
  // `authorisedSponsors` answers 0x, and read as transient that charged every
  // buyer for a mint that lands on an EOA and refunds. Distinct contract
  // address per case: the positive-authorisation cache is keyed per contract.
  answer = (m) => (m === "eth_call" ? { result: "0x" } : { result: null });
  const ledgerNoCode = { ...LEDGER, address: "0x" + "3e".repeat(20) };
  const v2NoCode = { ...V2, address: "0x" + "4e".repeat(20) };
  await assert.rejects(() => checkSponsorCanMint(ledgerNoCode, 1), (err) => err instanceof EventContractConfigError);
  await assert.rejects(() => checkSponsorCanMint(v2NoCode, 1), (err) => err instanceof EventContractConfigError);
});

test("the health probe classifies a no-code AUTHORISATION answer the same way", async () => {
  // Only `authorisedSponsors` answers empty, so the cap read cannot be what trips it.
  const authorisedSponsors = iface.getFunction("authorisedSponsors")!.selector;
  answer = (m, params) => {
    if (m !== "eth_call") return { result: null };
    const data = String((params[0] as { data?: string })?.data ?? "");
    return data.startsWith(authorisedSponsors)
      ? { result: "0x" }
      : { result: iface.encodeFunctionResult("sponsorMintAllowance", [50, 50, NOW_S]) };
  };
  const saved = {
    chain: process.env.WOCO_EVENT_CHAIN_ID,
    version: process.env[`WOCO_EVENT_VERSION_${CHAIN}`],
    address: process.env[`WOCO_EVENT_ADDRESS_LEDGER_${CHAIN}`],
  };
  process.env.WOCO_EVENT_CHAIN_ID = String(CHAIN);
  process.env[`WOCO_EVENT_VERSION_${CHAIN}`] = "ledger";
  process.env[`WOCO_EVENT_ADDRESS_LEDGER_${CHAIN}`] = "0x" + "5e".repeat(20);
  try {
    await assert.rejects(() => readTicketMintPolicy(), (err) => err instanceof EventContractConfigError);
  } finally {
    for (const [k, v] of [
      ["WOCO_EVENT_CHAIN_ID", saved.chain],
      [`WOCO_EVENT_VERSION_${CHAIN}`, saved.version],
      [`WOCO_EVENT_ADDRESS_LEDGER_${CHAIN}`, saved.address],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("an RPC fault on the AUTHORISATION read is not a config error either", async () => {
  answer = () => ({ error: { code: -32603, message: "internal error" } });
  await assert.rejects(
    () => checkSponsorCanMint({ ...LEDGER, address: "0x" + "6e".repeat(20) }, 1),
    (err) => !(err instanceof EventContractConfigError),
  );
});

test("an RPC fault is NOT a config error — the route must be free to fail open on it", async () => {
  // ethers reports this as a data-less CALL_EXCEPTION, the same code a missing
  // function gets — only the node's message tells them apart.
  answer = () => ({ error: { code: -32603, message: "internal error" } });
  await assert.rejects(
    () => readSponsorMintAllowance(LEDGER),
    (err) => !(err instanceof EventContractConfigError),
  );
});

test("the cap view decodes perHour, mintable and windowResetsAt", async () => {
  answer = (m) =>
    m === "eth_call"
      ? { result: iface.encodeFunctionResult("sponsorMintAllowance", [40, 7, NOW_S]) }
      : { result: null };
  assert.deepEqual(await readSponsorMintAllowance(LEDGER), { perHour: 40, mintable: 7, windowResetsAt: NOW_S });
});

/** Answers every call a sponsor mint makes, with the mint itself reverting `revertData`. */
function mintReverting(revertData: string, perHour: number): typeof answer {
  return (m) => {
    switch (m) {
      case "eth_getTransactionCount": return { result: "0x0" };
      case "eth_estimateGas": return { error: { code: 3, message: "execution reverted", data: revertData } };
      case "eth_call": return { result: iface.encodeFunctionResult("sponsorMintAllowance", [perHour, 0, NOW_S]) };
      case "eth_gasPrice": return { result: "0x1" };
      case "eth_maxPriorityFeePerGas": return { result: "0x1" };
      case "eth_getBlockByNumber": return { result: null };
      default: return { result: null };
    }
  };
}

// Distinct event ids per test: ethers caches an identical request for 250ms, so
// a repeated estimateGas would answer with the previous test's revert.
test("a mint refused by a STOPPED sponsor is explained with no retry time", async () => {
  answer = mintReverting(iface.encodeErrorResult("MintCapExceeded", [SPONSOR, NOW_S]), 0);
  await assert.rejects(
    () => batchClaimForLedger("0x" + "a1".repeat(32), ["0x" + "22".repeat(20)], "0x" + "33".repeat(32), LEDGER.address, SPONSOR_KEY, CHAIN),
    (err) => {
      assert.ok(err instanceof MintCapExceededError, `got ${String(err)}`);
      assert.equal(err.stopped, true);
      assert.equal(err.retryAt, null);
      assert.doesNotMatch(err.message, /resets at/);
      return true;
    },
  );
});

test("a mint refused by a spent window is explained with its reset time", async () => {
  answer = mintReverting(iface.encodeErrorResult("MintCapExceeded", [SPONSOR, NOW_S]), 25);
  await assert.rejects(
    () => batchClaimForLedger("0x" + "a2".repeat(32), ["0x" + "22".repeat(20)], "0x" + "33".repeat(32), LEDGER.address, SPONSOR_KEY, CHAIN),
    (err) => {
      assert.ok(err instanceof MintCapExceededError);
      assert.equal(err.retryAt, NOW_S);
      assert.match(err.message, /25\/h/);
      return true;
    },
  );
});

test("a batch bigger than the whole cap is explained with no retry time", async () => {
  answer = mintReverting(iface.encodeErrorResult("MintCapExceeded", [SPONSOR, NOW_S]), 1);
  const two = ["0x" + "22".repeat(20), "0x" + "23".repeat(20)];
  await assert.rejects(
    () => batchClaimForLedger("0x" + "a5".repeat(32), two, "0x" + "33".repeat(32), LEDGER.address, SPONSOR_KEY, CHAIN),
    (err) => {
      assert.ok(err instanceof MintCapExceededError);
      assert.equal(err.retryAt, null);
      assert.match(err.message, /mint of 2 is larger/);
      return true;
    },
  );
});

test("any other mint revert is named, not read as the cap — ethers alone says 'unknown custom error'", async () => {
  answer = mintReverting(iface.encodeErrorResult("SalesClosed", []), 25);
  await assert.rejects(
    () => batchClaimForLedger("0x" + "a3".repeat(32), ["0x" + "22".repeat(20)], "0x" + "33".repeat(32), LEDGER.address, SPONSOR_KEY, CHAIN),
    (err) => {
      assert.ok(!(err instanceof MintCapExceededError));
      assert.equal((err as Error).message, "events contract refused the mint: SalesClosed");
      return true;
    },
  );
});

test("a mint failure that is not a contract revert is re-thrown as it came", async () => {
  answer = (m) => (m === "eth_getTransactionCount" ? { result: "0x0" } : { error: { code: -32603, message: "internal error" } });
  await assert.rejects(
    () => batchClaimForLedger("0x" + "a4".repeat(32), ["0x" + "22".repeat(20)], "0x" + "33".repeat(32), LEDGER.address, SPONSOR_KEY, CHAIN),
    (err) => !(err instanceof MintCapExceededError) && !/refused the mint/.test((err as Error).message),
  );
});
