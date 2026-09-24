/**
 * #563 — a live charge mints only on the ACTIVE chain, and a hold is only
 * granted for one it can become.
 *
 * Since #563 a registration record names its chain, so after
 * `WOCO_EVENT_CHAIN_ID` moves (421614 -> 42161), a record from the old chain
 * still resolves, and the old chain's RPC is still configured. Without a guard,
 * create-checkout would validate against the previous (test) chain, stamp it
 * into a LIVE Stripe session, and fulfilment would mint there.
 *
 * The reserve step (the 10-minute seat hold) applies the same rule: a hold
 * granted against the old chain's supply is one create-checkout then refuses,
 * and it still spends the network's seat cap.
 *
 * Driven through the real routes. The old chain's RPC is a local stub that
 * COUNTS requests, so "refused before reading the other chain" is observed,
 * not inferred; the positive control proves the stub is the chain the route
 * would otherwise have read.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { Bee } from "@ethersphere/bee-js";
import type { EventFeed } from "@woco/shared";

const OLD_CHAIN = 421614;
const NEW_CHAIN = 42161;
const V2_ADDR = "0x351070aff6deca449506a6ea6dc6cb84d13caedf";
const EVENT_ID = "e0000000-0000-4000-8000-00000000c4a1";
const SERIES_ID = "s0000000-0000-4000-8000-00000000c4a1";
const ON_CHAIN_ID = "0x" + "c4".repeat(32);

const originalCwd = process.cwd();
const dir = mkdtempSync(join(tmpdir(), "woco-563-chain-guard-"));
process.chdir(dir);
process.env.BEE_URL = "http://127.0.0.1:1";
process.env.EMAIL_HASH_SECRET ??= "0".repeat(64);
process.env.FEED_PRIVATE_KEY ??= "11".repeat(32);
delete process.env.STRIPE_SECRET_KEY;

let rpcRequests = 0;
let server: Server;
let app: Hono;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      rpcRequests++;
      const parsed = JSON.parse(body);
      const one = (m: { id: number; method: string }) =>
        m.method === "eth_chainId"
          ? { jsonrpc: "2.0", id: m.id, result: "0x" + OLD_CHAIN.toString(16) }
          : { jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "stub: no chain here" } };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed)));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env[`RPC_URL_${OLD_CHAIN}`] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const { __setBeeForTests } = await import("../src/config/swarm.js");
  // The manifest read after the chain reads must fail fast, not retry.
  __setBeeForTests({
    downloadData: async () => {
      throw Object.assign(new Error("not found"), { status: 404 });
    },
  } as unknown as Bee);

  const registry = await import("../src/lib/event/onchain-registry.js");
  const service = await import("../src/lib/event/service.js");
  const { stripeRoutes } = await import("../src/routes/stripe.js");
  const { reservations } = await import("../src/routes/reservations.js");
  app = new Hono();
  app.route("/api/stripe", stripeRoutes);
  app.route("/api/events", reservations);

  // Registered — and recorded — while the platform ran on the old chain.
  registry.recordOnChainEventId(EVENT_ID, SERIES_ID, ON_CHAIN_ID, { chainId: OLD_CHAIN, address: V2_ADDR, version: "v2" });
  service.primeEventCache(EVENT_ID, {
    v: 1,
    eventId: EVENT_ID,
    title: "Sold on the test chain",
    description: "",
    imageHash: "00".repeat(32),
    startDate: "2099-01-01T00:00:00.000Z",
    endDate: "2099-01-02T00:00:00.000Z",
    location: "Somewhere",
    creatorAddress: "0x" + "11".repeat(20),
    createdAt: "2026-01-01T00:00:00.000Z",
    series: [{
      seriesId: SERIES_ID,
      name: "GA",
      description: "",
      totalSupply: 10,
      price: 20,
      onChainEventId: ON_CHAIN_ID,
      swarmManifestRef: "ab".repeat(32),
      manifestRef: "0x" + "cd".repeat(32),
      payment: { stripeEnabled: true, price: "20.00", currency: "GBP" },
    }],
  } as unknown as EventFeed);
});

after(() => {
  server?.close();
  server?.closeAllConnections?.();
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

function checkout(ip: string): Promise<Response> {
  return app.request("/api/stripe/create-checkout", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify({ eventId: EVENT_ID, seriesId: SERIES_ID, claimerEmail: "buyer@example.com" }),
  });
}

test("after a chain flip, a registration on the old chain is refused before its chain is read", async () => {
  process.env.WOCO_EVENT_CHAIN_ID = String(NEW_CHAIN);
  rpcRequests = 0;
  const res = await checkout("203.0.113.40");
  assert.equal(res.status, 409);
  const body = (await res.json()) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.match(body.error, /not currently on sale/);
  assert.equal(rpcRequests, 0, "the old chain was read for a charge on the new one");
});

test("control: on its own chain the same registration IS read on that chain", async () => {
  process.env.WOCO_EVENT_CHAIN_ID = String(OLD_CHAIN);
  rpcRequests = 0;
  await checkout("203.0.113.41");
  assert.ok(rpcRequests > 0, "the stub is not the chain the route reads — the test above proves nothing");
});

function reserve(ip: string): Promise<Response> {
  return app.request(`/api/events/${EVENT_ID}/series/${SERIES_ID}/reserve`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify({ quantity: 1 }),
  });
}

test("after a chain flip, no seat hold is granted for a registration on the old chain", async () => {
  process.env.WOCO_EVENT_CHAIN_ID = String(NEW_CHAIN);
  rpcRequests = 0;
  const res = await reserve("203.0.113.42");
  assert.equal(res.status, 409);
  const body = (await res.json()) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.match(body.error, /not currently on sale/);
  assert.equal(rpcRequests, 0, "the old chain's supply was read for a hold on the new one");
});

test("control: on its own chain the hold counts seats on that chain", async () => {
  process.env.WOCO_EVENT_CHAIN_ID = String(OLD_CHAIN);
  rpcRequests = 0;
  await reserve("203.0.113.43");
  assert.ok(rpcRequests > 0, "the stub is not the chain the reserve step reads — the test above proves nothing");
});
