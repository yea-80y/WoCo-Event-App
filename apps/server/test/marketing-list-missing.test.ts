/**
 * A marketing list on record whose stored copy can't be found. 2026-11-01: every
 * pre-launch list was stamped on a batch that expired at launch, and the Audience
 * screen dead-ended on "Etherna /bytes 404" - the load failed and so did every
 * save, which re-reads the list first. Now the read says "not found" only when
 * every source answered 404, and says whether the batch the list was stamped on is
 * still on chain; the write records that batch.
 *
 * Bee and Etherna are one local HTTP server, so bee-js and the raw Etherna fetch
 * are exercised for real.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { TypedDataEncoder, Wallet } from "ethers";
import { enableFeature } from "./helpers/features.js";

enableFeature("walletLoginAllowed");

const CORE = "c0".repeat(32);
const LIVE_BATCH = "11".repeat(32);
const DEAD_BATCH = "dd".repeat(32);
const REF_OK = "aa".repeat(32);
const REF_GONE = "ab".repeat(32);
const REF_ETHERNA_ONLY = "ac".repeat(32);
const REF_ETHERNA_REFUSES = "ad".repeat(32);
const BLOB = JSON.stringify({ v: 2, sealed: "box" });

const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const server: Server = createServer((req, res) => {
  const url = req.url ?? "";
  if (url === "/token") return json(res, 200, { access_token: "tok", expires_in: 3600 });
  if (url === "/chainstate") return json(res, 200, { block: 1000, chainTip: 1000 + chainLag });
  if (url.startsWith("/batches/")) {
    const id = url.slice("/batches/".length);
    const listed = id === LIVE_BATCH || (id === CORE && coreListed);
    return listed ? json(res, 200, { batchID: id, batchTTL: 1000 }) : json(res, 404, { code: 404, message: "batch not found" });
  }
  if (url.startsWith("/etherna/bytes/")) {
    const ref = url.slice("/etherna/bytes/".length);
    if (ref === REF_ETHERNA_ONLY) return res.writeHead(200).end(BLOB);
    if (ref === REF_ETHERNA_REFUSES) return json(res, 400, { message: "bad request" });
    return json(res, 404, { message: "Not Found" });
  }
  if (url.startsWith("/bytes/")) {
    const ref = url.slice("/bytes/".length);
    if (ref === REF_OK) return res.writeHead(200, { "content-type": "application/octet-stream" }).end(BLOB);
    return json(res, 404, { code: 404, message: "Not Found" });
  }
  json(res, 500, { message: `unexpected ${url}` });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

/** Steady state measured on our bee, 2026-11-01. */
const NORMAL_LAG = 7;
let chainLag = NORMAL_LAG;
let coreListed = true;

const HOST = "test.woco.local";
process.env.ALLOWED_HOSTS = HOST;
process.env.EMAIL_HASH_SECRET = "test-secret-list-missing";
process.env.BEE_URL = base;
process.env.POSTAGE_BATCH_ID = CORE;
process.env.ETHERNA_GATEWAY_URL = `${base}/etherna`;
process.env.ETHERNA_TOKEN_ENDPOINT = `${base}/token`;
process.env.ETHERNA_API_KEY = "id.secret";
process.env.ETHERNA_ENABLED = "true";
// The stores write .data/ relative to cwd - never touch the real one.
process.chdir(mkdtempSync(join(tmpdir(), "woco-list-missing-test-")));

const { downloadFromBytes, SwarmNotFoundError } = await import("../src/lib/swarm/bytes.js");
const { batchOnChain } = await import("../src/lib/health/probes.js");
const { putList } = await import("../src/lib/marketing/list-store.js");
const { SESSION_DOMAIN, SESSION_TYPES, SESSION_PURPOSE, SESSION_EXPIRY_MS } = await import("@woco/shared");

let app: Hono;
before(async () => {
  const { marketing } = await import("../src/routes/marketing.js");
  app = new Hono();
  app.route("/api/marketing", marketing);
});
after(() => server.close());

// ── The read ────────────────────────────────────────────────────────────────

test("every source answering 404 is 'not found'", async () => {
  await assert.rejects(downloadFromBytes(REF_GONE), (e) => e instanceof SwarmNotFoundError && e.status === 404);
});

test("a source that answered anything else is not 'not found'", async () => {
  await assert.rejects(downloadFromBytes(REF_ETHERNA_REFUSES), (e) => !(e instanceof SwarmNotFoundError));
});

test("one source holding it is enough", async () => {
  assert.equal(await downloadFromBytes(REF_ETHERNA_ONLY), BLOB);
  assert.equal(await downloadFromBytes(REF_OK), BLOB);
});

test("with Etherna off, our bee's 404 alone is 'not found'", async () => {
  process.env.ETHERNA_ENABLED = "false";
  try {
    await assert.rejects(downloadFromBytes(REF_GONE), (e) => e instanceof SwarmNotFoundError);
  } finally {
    process.env.ETHERNA_ENABLED = "true";
  }
});

// ── Is the batch still on chain? ────────────────────────────────────────────

test("a batch our bee lists is on chain; one it does not, with our own batch listed and the chain caught up, is gone", async () => {
  assert.equal(await batchOnChain(LIVE_BATCH), "listed");
  assert.equal(await batchOnChain(DEAD_BATCH), "gone");
});

test("'gone' needs our bee caught up and our own batch in its store; otherwise it cannot tell", async () => {
  try {
    chainLag = 30;
    assert.equal(await batchOnChain(DEAD_BATCH), "gone", "within ~2.5 min of the tip");
    chainLag = 31;
    assert.equal(
      await batchOnChain(DEAD_BATCH),
      "unknown",
      "further behind, a batch bought since may not be in the store yet - the hour the alarm allows is far too loose",
    );
  } finally {
    chainLag = NORMAL_LAG;
  }
  coreListed = false;
  try {
    assert.equal(await batchOnChain(DEAD_BATCH), "unknown", "a wiped or refilling store answers 404 for everything");
    assert.equal(await batchOnChain(CORE), "unknown", "our own batch missing is never self-evidence");
  } finally {
    coreListed = true;
  }
});

test("a store that fails to answer is 'unknown', never 'gone'", async () => {
  const fail = Object.assign(new Error("bee batch → HTTP 503"), { status: 503 });
  // Only the asked batch fails: our own is listed and the chain is caught up, so nothing else says "unknown".
  const readers = {
    beeBatch: async (id: string) => {
      if (id === DEAD_BATCH) throw fail;
      return { batchID: id };
    },
    chainstate: async () => ({ block: 1, chainTip: 1 }),
  };
  assert.equal(await batchOnChain(DEAD_BATCH, readers), "unknown");
});

// ── GET /api/marketing/list ─────────────────────────────────────────────────

const sha256Hex = (text: string) => createHash("sha256").update(text, "utf-8").digest("hex");

async function mintDelegation() {
  const parent = Wallet.createRandom();
  const session = Wallet.createRandom();
  const nonce = randomUUID();
  const message = {
    host: HOST,
    parent: parent.address,
    session: session.address,
    purpose: SESSION_PURPOSE,
    nonce,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_EXPIRY_MS).toISOString(),
    sessionProof: await session.signMessage(`${HOST}:${nonce}`),
    clientCodeHash: "0x" + "00".repeat(32),
    statement: `Authorize ${session.address} as session key for ${HOST}`,
  };
  const parentSig = await parent.signTypedData(
    SESSION_DOMAIN,
    SESSION_TYPES as unknown as Parameters<typeof TypedDataEncoder.hash>[1],
    message,
  );
  return { parent, session, delegation: { message, parentSig } };
}

async function getList(swarmRef: string, batchId?: string) {
  const d = await mintDelegation();
  const updatedAt = "2026-10-23T15:48:17.604Z";
  putList(d.parent.address.toLowerCase(), { swarmRef, count: 3, updatedAt, emailHashes: [], ...(batchId ? { batchId } : {}) });
  const path = "/api/marketing/list";
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const challenge = ["woco-session-v1", "GET", path, timestamp, nonce, sha256Hex("")].join("\n");
  const resp = await app.request(path, {
    method: "GET",
    headers: {
      "X-Session-Address": d.session.address,
      "X-Session-Delegation": Buffer.from(JSON.stringify(d.delegation), "utf-8").toString("base64"),
      "X-Session-Sig": await d.session.signMessage(challenge),
      "X-Session-Nonce": nonce,
      "X-Session-Timestamp": timestamp,
    },
  });
  return { status: resp.status, json: (await resp.json()) as Record<string, any>, meta: { count: 3, updatedAt, swarmRef } };
}

test("a list that can't be found is answered as on record, with no content and why", async () => {
  const expired = await getList(REF_GONE, DEAD_BATCH);
  assert.equal(expired.status, 200);
  assert.deepEqual(expired.json, { ok: true, data: { meta: expired.meta, sealedList: null, storage: "expired" } });

  assert.equal((await getList(REF_GONE, LIVE_BATCH)).json.data.storage, "live");
  assert.equal((await getList(REF_GONE)).json.data.storage, "unknown", "saved before the batch was recorded");
});

test("a list that reads is returned whole; a read that failed any other way is still an error", async () => {
  const ok = await getList(REF_OK, CORE);
  assert.deepEqual(ok.json, { ok: true, data: { meta: ok.meta, sealedList: JSON.parse(BLOB) } });

  const failed = await getList(REF_ETHERNA_REFUSES, CORE);
  assert.equal(failed.status, 500);
  assert.equal(failed.json.ok, false);
});

// ── POST /api/marketing/list records the batch ──────────────────────────────

test("a list write records the batch it stamped with - the same value it uploads under", () => {
  const src = readFileSync(new URL("../src/routes/marketing.ts", import.meta.url), "utf-8");
  const start = src.indexOf('marketing.post("/list"');
  const handler = src.slice(start, src.indexOf("\n});", start));
  assert.match(handler, /const batchId = requirePostageBatch\(\);/);
  assert.match(handler, /uploadToBytes\(JSON\.stringify\(sealedList\), \{ batchId, target: "wocoBee" \}/);
  assert.match(handler, /putList\(org, \{ swarmRef, count, updatedAt, emailHashes, batchId \}\);/);
});
