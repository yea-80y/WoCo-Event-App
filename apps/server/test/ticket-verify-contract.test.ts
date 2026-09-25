/**
 * #563 — a ticket verifies against the contract its registration lives on.
 *
 * After a cutover, env selects the successor contract, where an older series'
 * id does not exist: its slots read as unclaimed there, and an unclaimed slot
 * is an INVALID ticket — a genuine buyer turned away as a forger. The /t page
 * and the attendee gate verify through `verifyTicketSig`, so this drives it
 * end to end against a local JSON-RPC stub that answers only for the contract
 * the registration record names.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Interface, Wallet, ZeroAddress, ZeroHash } from "ethers";
import { buildTicketCanonicalMessage, type EventFeed } from "@woco/shared";

const CHAIN = 31337;
const V2_ADDR = "0x" + "2a".repeat(20);
const LEDGER_ADDR = "0x" + "1a".repeat(20);
const EVENT_ID = "e0000000-0000-4000-8000-00000000563a";
const SERIES_ID = "s0000000-0000-4000-8000-00000000563a";
const ON_CHAIN_ID = "0x" + "5c".repeat(32);

const originalCwd = process.cwd();
const dir = mkdtempSync(join(tmpdir(), "woco-563-verify-"));
process.chdir(dir);
process.env.BEE_URL = "http://127.0.0.1:1";
process.env.EMAIL_HASH_SECRET ??= "0".repeat(64);
process.env.FEED_PRIVATE_KEY ??= "11".repeat(32);
process.env.WOCO_EVENT_CHAIN_ID = String(CHAIN);
// The cutover has happened: env now selects the ledger.
process.env[`WOCO_EVENT_VERSION_${CHAIN}`] = "ledger";
process.env[`WOCO_EVENT_ADDRESS_LEDGER_${CHAIN}`] = LEDGER_ADDR;

const v2 = new Interface([
  "function getSlotData(bytes32 eventId, uint256 slot) view returns (address owner, address claimer, bytes32 orderRef, bool escrowed, bool refunded)",
]);
const ledger = new Interface([
  "function getSlotData(bytes32 eventId, uint256 slot) view returns (address holder, address claimer, bytes32 orderRef)",
]);

const burner = Wallet.createRandom();
let server: Server;
let registry: typeof import("../src/lib/event/onchain-registry.js");
let verifyTicketSig: typeof import("../src/lib/ticket/verify-sig.js").verifyTicketSig;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const one = (m: { id: number; method: string; params: Array<{ to?: string }> }) => {
        if (m.method === "eth_chainId") return { jsonrpc: "2.0", id: m.id, result: "0x" + CHAIN.toString(16) };
        const to = m.params[0]?.to?.toLowerCase();
        // Only the V2 contract holds the ticket; the ledger has never seen the id.
        const result =
          to === V2_ADDR
            ? v2.encodeFunctionResult("getSlotData", [burner.address, ZeroAddress, ZeroHash, false, false])
            : ledger.encodeFunctionResult("getSlotData", [ZeroAddress, ZeroAddress, ZeroHash]);
        return { jsonrpc: "2.0", id: m.id, result };
      };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed)));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env[`RPC_URL_${CHAIN}`] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  registry = await import("../src/lib/event/onchain-registry.js");
  const service = await import("../src/lib/event/service.js");
  ({ verifyTicketSig } = await import("../src/lib/ticket/verify-sig.js"));

  // Registered on V2 before the cutover, and recorded with its contract.
  registry.recordOnChainEventId(EVENT_ID, SERIES_ID, ON_CHAIN_ID, { chainId: CHAIN, address: V2_ADDR, version: "v2" });
  service.primeEventCache(EVENT_ID, {
    v: 1,
    eventId: EVENT_ID,
    title: "Before the cutover",
    description: "",
    imageHash: "00".repeat(32),
    startDate: "2099-01-01T00:00:00.000Z",
    location: "Somewhere",
    creatorAddress: "0x" + "11".repeat(20),
    createdAt: "2026-01-01T00:00:00.000Z",
    series: [{ seriesId: SERIES_ID, name: "GA", description: "", totalSupply: 10, price: 1, onChainEventId: ON_CHAIN_ID }],
  } as unknown as EventFeed);
});

after(() => {
  server?.close();
  server?.closeAllConnections?.();
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

test("a ticket on the pre-cutover contract still verifies after env moves to the ledger", async () => {
  const sig = await burner.signMessage(
    buildTicketCanonicalMessage({ onChainEventId: ON_CHAIN_ID, seriesId: SERIES_ID, edition: 1 }),
  );
  assert.equal(await verifyTicketSig({ eventId: EVENT_ID, seriesId: SERIES_ID, edition: 1, sig }), "valid");
});

test("a signature by anyone else is still invalid on that contract", async () => {
  const sig = await Wallet.createRandom().signMessage(
    buildTicketCanonicalMessage({ onChainEventId: ON_CHAIN_ID, seriesId: SERIES_ID, edition: 1 }),
  );
  assert.equal(await verifyTicketSig({ eventId: EVENT_ID, seriesId: SERIES_ID, edition: 1, sig }), "invalid");
});
