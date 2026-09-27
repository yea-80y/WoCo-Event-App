/**
 * The SOC relay stamps a family where the shared table says it is paid for (#689).
 *
 * WHAT THESE TESTS ARE FOR. Every Etherna-routed client write used to go to the
 * signed-in account's own Etherna batch whenever it had a live one. That is right
 * for a profile or a like, and wrong for recovery material: a lapsed hosting plan
 * would take the escrow with it, and the guardian index - written by EVERY account
 * one backup protects - would spread its versions over several batches, where one
 * lapse leaves a gap that ends every scan. Those rows say `stamp: "platform"`.
 *
 * Driven through the REAL route with a parent that HAS a live batch of its own,
 * and the stamp read off the upload request itself (`Swarm-Postage-Batch-Id`), so
 * a mutation anywhere between the request body and the upload has to show.
 */
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { TypedDataEncoder, Wallet } from "ethers";
import { PrivateKey } from "@ethersphere/bee-js";
import { calculateCacAddress, encodeSpan } from "@woco/shared";

const BEE = "http://bee.test";
const ETHERNA_BASE = "http://etherna-fetch.test";
const SSO = "http://sso.test/token";
// Requests ROUTE by the canonical host; ETHERNA_GATEWAY_URL only moves where the
// server's own Etherna calls go (#657).
const ETHERNA = "https://gateway.etherna.io";
const WOCO = "https://gateway.woco-net.com";
const HOST = "test.woco.local";
const WOCO_BATCH = "aa".repeat(32);
const PLATFORM = "6a4b028d5df8" + "c".repeat(52);
const USER_BATCH = "ee".repeat(32);
const PARENT = new Wallet("0x" + "55".repeat(32));

process.env.BEE_URL = BEE;
process.env.PROXY_URL = "http://proxy.test";
process.env.UPLOAD_SECRET = "s";
process.env.ETHERNA_ENABLED = "true";
process.env.ETHERNA_API_KEY = "id.secret";
process.env.ETHERNA_GATEWAY_URL = ETHERNA_BASE;
process.env.ETHERNA_TOKEN_ENDPOINT = SSO;
process.env.POSTAGE_BATCH_ID = WOCO_BATCH;
process.env.ETHERNA_PLATFORM_BATCH = PLATFORM;
process.env.ALLOWED_HOSTS = HOST;
process.env.EMAIL_HASH_SECRET = "test-secret-689";

let probes: typeof import("../src/lib/health/probes.js");
let shared: typeof import("@woco/shared");
let app: Hono;

// ---------------------------------------------------------------------------
// The fake network: every upload is recorded with the batch that paid for it
// ---------------------------------------------------------------------------

interface Upload { store: "bee" | "etherna"; batch: string | null }
const uploads: Upload[] = [];
const realFetch = globalThis.fetch;

function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.href === SSO) return Promise.resolve(Response.json({ access_token: "tok", expires_in: 3600 }));
  if (url.pathname.startsWith("/soc/") && (url.origin === BEE || url.origin === ETHERNA_BASE)) {
    const batch = new Headers(init?.headers).get("swarm-postage-batch-id");
    uploads.push({ store: url.origin === BEE ? "bee" : "etherna", batch });
    return Promise.resolve(Response.json({ reference: "00".repeat(32) }, { status: 201 }));
  }
  // Proxy whitelist, Etherna offer registration.
  return Promise.resolve(new Response("{}", { status: 200 }));
}

before(async () => {
  // The batch registry and every store pin DATA_DIR from cwd at import.
  const dir = mkdtempSync(join(tmpdir(), "woco-689-relay-family-"));
  process.chdir(dir);
  mkdirSync(join(dir, ".data"));
  writeFileSync(join(dir, ".data", "etherna-batches.json"), JSON.stringify({
    [PARENT.address.toLowerCase()]: {
      batchId: USER_BATCH,
      depth: 20,
      ttlDays: 365,
      purchasedAt: "2026-09-01T00:00:00Z",
      expiresAt: "2099-01-01T00:00:00Z",
      paidUntil: "2099-01-01T00:00:00Z",
      gateway: ETHERNA,
    },
  }));
  globalThis.fetch = fakeFetch as typeof fetch;
  probes = await import("../src/lib/health/probes.js");
  shared = await import("@woco/shared");
  const { swarmRoutes } = await import("../src/routes/swarm.js");
  app = new Hono();
  app.route("/api/swarm", swarmRoutes);
});

after(() => {
  globalThis.fetch = realFetch;
});

const LIVE_STAMP = { depth: 19, bucketDepth: 16, utilization: 4, batchTTL: 337_269, usable: true, immutableFlag: false };

async function platformBatch(state: "live" | "gone"): Promise<void> {
  await probes.refreshPostage({
    deposit: async () => 10n ** 18n,
    beeStamp: async () => ({ ...LIVE_STAMP }),
    chainstate: async () => ({ block: 100, chainTip: 100 }),
    ethernaStamp: async () => {
      if (state === "gone") throw Object.assign(new Error("GET /stamps/x → 404: not found"), { status: 404 });
      return { ...LIVE_STAMP };
    },
  } as unknown as Parameters<typeof probes.refreshPostage>[0], () => {});
}

beforeEach(async () => {
  uploads.length = 0;
  await platformBatch("live");
});

// ---------------------------------------------------------------------------
// A genuinely signed SOC, posted by a session of PARENT
// ---------------------------------------------------------------------------

const SIGNER = new PrivateKey("0x" + "66".repeat(32));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function signedSoc(): Record<string, string> {
  const identifier = createHash("sha256").update(randomUUID()).digest();
  const payload = new TextEncoder().encode(JSON.stringify({ v: 1 }));
  const span = encodeSpan(payload.length);
  const sig = (SIGNER.sign(new Uint8Array([...identifier, ...calculateCacAddress(span, payload)])) as unknown as {
    toUint8Array(): Uint8Array;
  }).toUint8Array();
  return {
    owner: SIGNER.publicKey().address().toHex().replace(/^0x/, "").toLowerCase(),
    identifier: hex(identifier),
    signature: hex(sig),
    span: hex(span),
    payload: hex(payload),
  };
}

const sha256Hex = (text: string) => createHash("sha256").update(text, "utf-8").digest("hex");

async function post(extra: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const session = Wallet.createRandom();
  const nonce = randomUUID();
  const message = {
    host: HOST,
    parent: PARENT.address,
    session: session.address,
    purpose: shared.SESSION_PURPOSE,
    nonce,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + shared.SESSION_EXPIRY_MS).toISOString(),
    sessionProof: await session.signMessage(`${HOST}:${nonce}`),
    clientCodeHash: "0x" + "00".repeat(32),
    statement: `Authorize ${session.address} as session key for ${HOST}`,
  };
  const parentSig = await PARENT.signTypedData(
    shared.SESSION_DOMAIN,
    shared.SESSION_TYPES as unknown as Parameters<typeof TypedDataEncoder.hash>[1],
    message,
  );
  const path = "/api/swarm/soc";
  const text = JSON.stringify({ ...signedSoc(), ...extra });
  const timestamp = String(Date.now());
  const reqNonce = randomUUID();
  const challenge = ["woco-session-v1", "POST", path, timestamp, reqNonce, sha256Hex(text)].join("\n");
  const resp = await app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Address": session.address,
      "X-Session-Delegation": Buffer.from(JSON.stringify({ message, parentSig }), "utf-8").toString("base64"),
      "X-Session-Sig": await session.signMessage(challenge),
      "X-Session-Nonce": reqNonce,
      "X-Session-Timestamp": timestamp,
    },
    body: text,
  });
  return { status: resp.status, json: (await resp.json()) as Record<string, unknown> };
}

async function stampedOn(extra: Record<string, unknown>): Promise<Upload> {
  const res = await post(extra);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(uploads.length, 1, "exactly one upload");
  return uploads[0]!;
}

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

test("every recovery family on Etherna is stamped on the platform batch, never the account's own", async () => {
  for (const family of ["recoveryPortability", "recoveryEnvelope", "guardianIndex"]) {
    uploads.length = 0;
    assert.deepEqual(await stampedOn({ gatewayUrl: ETHERNA, family }), { store: "etherna", batch: PLATFORM }, family);
  }
});

test("an `owner` family still rides the account's live batch", async () => {
  assert.deepEqual(await stampedOn({ gatewayUrl: ETHERNA, family: "profile" }), { store: "etherna", batch: USER_BATCH });
});

test("a write that names no family is routed as it always was", async () => {
  assert.deepEqual(await stampedOn({ gatewayUrl: ETHERNA }), { store: "etherna", batch: USER_BATCH });
});

test("a name that is not a family is routed as it always was", async () => {
  for (const family of ["nonsense", "__proto__", "constructor", "etherna", "woco"]) {
    uploads.length = 0;
    assert.deepEqual(await stampedOn({ gatewayUrl: ETHERNA, family }), { store: "etherna", batch: USER_BATCH }, family);
  }
});

test("the STORE still follows the client's gateway: a recovery write sent to WoCo lands on WoCo", async () => {
  // A build that still routes the family to WoCo reads it there, so its write must land there.
  assert.deepEqual(await stampedOn({ gatewayUrl: WOCO, family: "recoveryEnvelope" }), { store: "bee", batch: WOCO_BATCH });
  uploads.length = 0;
  assert.deepEqual(await stampedOn({ family: "recoveryEnvelope" }), { store: "bee", batch: WOCO_BATCH });
});

test("a dead platform batch refuses a recovery write - it never falls back to the account's batch", async () => {
  await platformBatch("gone");
  const res = await post({ gatewayUrl: ETHERNA, family: "recoveryEnvelope" });
  assert.equal(res.status, 503, JSON.stringify(res.json));
  assert.equal(res.json.code, "STORAGE_UNAVAILABLE");
  assert.deepEqual(uploads, []);
  // ...while an `owner` family is unaffected: it never touches the platform batch.
  assert.deepEqual(await stampedOn({ gatewayUrl: ETHERNA, family: "profile" }), { store: "etherna", batch: USER_BATCH });
});

test("a malformed family is refused before anything is stamped", async () => {
  for (const family of [7, null, { a: 1 }, "x".repeat(65)]) {
    const res = await post({ gatewayUrl: ETHERNA, family });
    assert.equal(res.status, 400, `${JSON.stringify(family)}: ${JSON.stringify(res.json)}`);
    assert.equal(res.json.error, "Invalid family");
  }
  assert.deepEqual(uploads, []);
});
