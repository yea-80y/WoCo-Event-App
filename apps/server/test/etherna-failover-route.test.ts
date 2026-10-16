/**
 * The Etherna failover through the real relay route (#912): a signed session, a
 * client-signed SOC, `POST /api/swarm/soc` - what wiring a source regex cannot see.
 * Bee, Etherna and the proxy are a stubbed `fetch`.
 */
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { TypedDataEncoder, Wallet } from "ethers";
import { PrivateKey } from "@ethersphere/bee-js";
import { ETHERNA_GATEWAY_URL, calculateCacAddress, calculateSocAddress, encodeSpan } from "@woco/shared";
import { enableFeature } from "./helpers/features.js";

enableFeature("walletLoginAllowed");

const HOST = "test.woco.local";
const BEE = "http://bee.test";
const ETH = "http://etherna.test";
const PROXY = "http://proxy.test";
const PLATFORM = "cd".repeat(32);

process.env.POSTAGE_BATCH_ID = "ab".repeat(32);
process.env.ETHERNA_PLATFORM_BATCH = PLATFORM;
process.env.ETHERNA_GATEWAY_URL = ETH;
process.env.ETHERNA_TOKEN_ENDPOINT = `${ETH}/token`;
process.env.ETHERNA_ENABLED = "true";
process.env.ETHERNA_API_KEY = "id.secret";
process.env.BEE_URL = BEE;
process.env.PROXY_URL = PROXY;
process.env.UPLOAD_SECRET = "s";
process.env.ALLOWED_HOSTS = HOST;
process.env.EMAIL_HASH_SECRET = "test-secret-etherna-failover-route";
delete process.env.ETHERNA_FAILOVER;

const calls: Array<{ url: string; method: string }> = [];
let ethernaSocStatus = 201;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  calls.push({ url, method });
  if (url === `${ETH}/token`) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
  if (url === `${PROXY}/admin/whitelist`) return new Response("{}", { status: 200 });
  if (url.startsWith(`${ETH}/soc/`)) return new Response("no", { status: ethernaSocStatus });
  if (url.startsWith(`${ETH}/api/v0.3/resources/`)) return new Response(null, { status: 200 });
  if (url.startsWith(`${BEE}/soc/`)) return new Response(null, { status: 201 });
  throw new Error(`unexpected fetch ${method} ${url}`);
}) as typeof fetch;

let app: Hono;
let ledger: typeof import("../src/lib/etherna/relay-ledger.js");
let probes: typeof import("../src/lib/health/probes.js");
let breaker: typeof import("../src/lib/etherna/breaker.js");
let shared: typeof import("@woco/shared");
let originalCwd: string;

before(async () => {
  originalCwd = process.cwd();
  process.chdir(mkdtempSync(join(tmpdir(), "woco-etherna-failover-route-")));
  ledger = await import("../src/lib/etherna/relay-ledger.js");
  probes = await import("../src/lib/health/probes.js");
  breaker = await import("../src/lib/etherna/breaker.js");
  shared = await import("@woco/shared");
  const { swarmRoutes } = await import("../src/routes/swarm.js");
  app = new Hono();
  app.route("/api/swarm", swarmRoutes);
});

after(() => {
  process.chdir(originalCwd);
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  calls.length = 0;
  ethernaSocStatus = 201;
  delete process.env.ETHERNA_FAILOVER;
  breaker.__resetEthernaBreaker();
  probes.__resetHealthProbes();
  process.chdir(mkdtempSync(join(tmpdir(), "woco-etherna-failover-route-")));
  ledger.__resetRelayLedgerForTest();
});

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const sha256Hex = (text: string) => createHash("sha256").update(text, "utf-8").digest("hex");

let seed = 0;
function signedSoc() {
  seed++;
  const signer = new PrivateKey("0x" + seed.toString(16).padStart(2, "0").repeat(32));
  const payload = new TextEncoder().encode(`{"hello":${seed}}`);
  const span = encodeSpan(payload.length);
  const identifier = new Uint8Array(32).fill(seed);
  const sig = (signer.sign(new Uint8Array([...identifier, ...calculateCacAddress(span, payload)])) as unknown as {
    toUint8Array(): Uint8Array;
  }).toUint8Array();
  const owner = signer.publicKey().address().toHex().replace(/^0x/, "").toLowerCase();
  return {
    body: { owner, identifier: hex(identifier), signature: hex(sig), span: hex(span), payload: hex(payload) },
    address: hex(calculateSocAddress(identifier, new Uint8Array(Buffer.from(owner, "hex")))),
  };
}

async function account() {
  const parent = Wallet.createRandom();
  const session = Wallet.createRandom();
  const nonce = randomUUID();
  const message = {
    host: HOST,
    parent: parent.address,
    session: session.address,
    purpose: shared.SESSION_PURPOSE,
    nonce,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + shared.SESSION_EXPIRY_MS).toISOString(),
    sessionProof: await session.signMessage(`${HOST}:${nonce}`),
    clientCodeHash: "0x" + "00".repeat(32),
    statement: `Authorize ${session.address} as session key for ${HOST}`,
  };
  const parentSig = await parent.signTypedData(
    shared.SESSION_DOMAIN,
    shared.SESSION_TYPES as unknown as Parameters<typeof TypedDataEncoder.hash>[1],
    message,
  );
  return { parent, session, delegation: { message, parentSig } };
}

async function relay(body: Record<string, string>) {
  const a = await account();
  const path = "/api/swarm/soc";
  const text = JSON.stringify({ ...body, gatewayUrl: ETHERNA_GATEWAY_URL });
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const challenge = ["woco-session-v1", "POST", path, timestamp, nonce, sha256Hex(text)].join("\n");
  const resp = await app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Address": a.session.address,
      "X-Session-Delegation": Buffer.from(JSON.stringify(a.delegation), "utf-8").toString("base64"),
      "X-Session-Sig": await a.session.signMessage(challenge),
      "X-Session-Nonce": nonce,
      "X-Session-Timestamp": timestamp,
    },
    body: text,
  });
  return { status: resp.status, json: (await resp.json()) as Record<string, unknown>, parent: a.parent.address.toLowerCase() };
}

const posts = (base: string) => calls.filter((c) => c.method === "POST" && c.url.startsWith(`${base}/soc/`));

/** The health probe saw Etherna answer 404 for the platform batch: the router refuses it (#610). */
async function platformBatchGone(): Promise<void> {
  const notFound = () => {
    throw Object.assign(new Error("GET /stamps/x → 404: not found"), { status: 404 });
  };
  await probes.refreshPostage(
    {
      deposit: async () => 10n ** 18n,
      beeStamp: async () => ({ depth: 19, bucketDepth: 16, utilization: 1, batchTTL: 100_000, usable: true, immutableFlag: false }),
      chainstate: async () => ({ block: 100, chainTip: 100 }),
      ethernaStamp: notFound,
    } as unknown as Parameters<typeof probes.refreshPostage>[0],
    () => {},
  );
}

test("route, auto: Etherna failing is a saved write - on WoCo, listed under the saving account", async () => {
  process.env.ETHERNA_FAILOVER = "auto";
  ethernaSocStatus = 503;
  const s = signedSoc();
  const r = await relay(s.body);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((r.json.data as { address: string }).address, s.address);
  assert.equal(posts(ETH).length, 2);
  assert.equal(posts(BEE).length, 1);
  const e = ledger.getRelayEntry(s.address);
  assert.equal(e?.status, "failover");
  assert.equal(e?.parent, r.parent, "the verified session's account, for the batch it moves back to");
});

test("route, off: Etherna failing fails the save, exactly as before", async () => {
  ethernaSocStatus = 400;
  const s = signedSoc();
  const r = await relay(s.body);
  assert.equal(r.status, 502);
  assert.equal(posts(BEE).length, 0);
});

test("route: a platform batch the router refuses is 503 with the rail off, and a WoCo save with it on", async () => {
  await platformBatchGone();
  const off = await relay(signedSoc().body);
  assert.equal(off.status, 503);
  assert.equal(off.json.code, "STORAGE_UNAVAILABLE");
  assert.equal(calls.filter((c) => c.method === "POST").length, 0, "refused before anything is sent");

  process.env.ETHERNA_FAILOVER = "auto";
  calls.length = 0;
  const s = signedSoc();
  const on = await relay(s.body);
  assert.equal(on.status, 200, JSON.stringify(on.json));
  assert.equal(posts(ETH).length, 0, "the router already said Etherna's batch cannot take it");
  assert.equal(posts(BEE).length, 1);
  assert.equal(ledger.getRelayEntry(s.address)?.status, "failover");
});

test("route, auto: a platform batch the chain no longer has detours to WoCo while Etherna still says it is fine", async () => {
  process.env.ETHERNA_FAILOVER = "auto";
  const readers = (tip: number) =>
    ({
      deposit: async () => 10n ** 18n,
      beeStamp: async () => ({ depth: 19, bucketDepth: 16, utilization: 1, batchTTL: 100_000, usable: true, immutableFlag: false }),
      chainstate: async () => ({ block: 100, chainTip: tip }),
      ethernaStamp: async () => ({ depth: 19, bucketDepth: 16, utilization: 1, batchTTL: 100_000, usable: true, immutableFlag: false }),
      beeBatch: async (id: string) => {
        if (id === PLATFORM) throw Object.assign(new Error("batch not found"), { status: 404 });
        return { batchID: id, batchTTL: 1_000 };
      },
    }) as unknown as Parameters<typeof probes.refreshPostage>[0];
  await probes.refreshPostage(readers(100), () => {});
  await probes.refreshPostage(readers(110), () => {});
  const s = signedSoc();
  const r = await relay(s.body);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(posts(ETH).length, 0, "Etherna would have said 2xx: it is never asked");
  assert.equal(posts(BEE).length, 1);
  assert.equal(ledger.getRelayEntry(s.address)?.status, "failover");
});
