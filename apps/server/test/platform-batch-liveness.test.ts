/**
 * #610: the shared Etherna platform batch is checked before it is stamped onto.
 *
 * WHAT THESE TESTS ARE FOR. Stamping onto a dead batch is silent: the upload
 * answers 200 and Etherna serves the bytes from its own storage for a while, so
 * the write looks saved and is lost. The owner's rule (2026-09-25): REFUSE only
 * when the batch cannot take the write - gone, unusable, or a full bucket - and
 * leave "nearly empty" to the alarm, because a top-up before it dies saves
 * everything already on it. An unknown reading writes.
 *
 * Every refusal is driven through the REAL probe (`refreshPostage` with a fake
 * stamp reader) into the REAL router, so a mutation anywhere on that path - the
 * snapshot, the rule, the call site, a route's 503 - has to turn a test red.
 *
 * The healthy stamp is what production Etherna reported on 2026-09-25: 4 of 8
 * bucket slots used, 3.9 days left - i.e. the TTL alarm was already firing.
 */

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { TypedDataEncoder, Wallet } from "ethers";

// Every network host is a closed local port: a mutated run that gets past the
// guard fails fast on ECONNREFUSED instead of reaching a real service.
const DEAD = "http://127.0.0.1:9";
const HOST = "test.woco.local";
const WOCO_BATCH = "aa".repeat(32);
const PLATFORM = "6a4b028d5df8" + "c".repeat(52);
const OTHER_PLATFORM = "dd".repeat(32);
const USER_WITH_BATCH = "0x" + "22".repeat(20);
const USER_BATCH = "ee".repeat(32);
const OWNER = "0x" + "11".repeat(20);

process.env.POSTAGE_BATCH_ID = WOCO_BATCH;
process.env.ETHERNA_GATEWAY_URL = DEAD;
process.env.ETHERNA_TOKEN_ENDPOINT = `${DEAD}/token`;
process.env.BEE_URL = DEAD;
process.env.PROXY_URL = DEAD;
process.env.ALLOWED_HOSTS = HOST;
process.env.EMAIL_HASH_SECRET = "test-secret-610";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../src");

let probes: typeof import("../src/lib/health/probes.js");
let router: typeof import("../src/lib/etherna/batch-router.js");
let createEventV2: typeof import("../src/lib/event/service.js").createEventV2;
let SESSION_DOMAIN: typeof import("@woco/shared").SESSION_DOMAIN;
let SESSION_TYPES: typeof import("@woco/shared").SESSION_TYPES;
let SESSION_PURPOSE: typeof import("@woco/shared").SESSION_PURPOSE;
let SESSION_EXPIRY_MS: typeof import("@woco/shared").SESSION_EXPIRY_MS;
let app: Hono;

before(async () => {
  // The batch registry and every store pin DATA_DIR from cwd at import.
  const dir = mkdtempSync(join(tmpdir(), "woco-610-liveness-"));
  process.chdir(dir);
  mkdirSync(join(dir, ".data"));
  writeFileSync(join(dir, ".data", "etherna-batches.json"), JSON.stringify({
    [USER_WITH_BATCH]: {
      batchId: USER_BATCH,
      depth: 20,
      ttlDays: 365,
      purchasedAt: "2026-09-01T00:00:00Z",
      expiresAt: "2099-01-01T00:00:00Z",
      paidUntil: "2099-01-01T00:00:00Z",
      gateway: DEAD,
    },
  }));

  probes = await import("../src/lib/health/probes.js");
  router = await import("../src/lib/etherna/batch-router.js");
  ({ createEventV2 } = await import("../src/lib/event/service.js"));
  ({ SESSION_DOMAIN, SESSION_TYPES, SESSION_PURPOSE, SESSION_EXPIRY_MS } = await import("@woco/shared"));

  const { swarmRoutes } = await import("../src/routes/swarm.js");
  const { sitesRouter } = await import("../src/routes/sites.js");
  app = new Hono();
  app.route("/api/swarm", swarmRoutes);
  app.route("/api/sites", sitesRouter);
});

/** LIVE, production Etherna platform batch, 2026-09-25. */
const LIVE_STAMP = {
  depth: 19,
  bucketDepth: 16,
  utilization: 4,
  batchTTL: 337_269,
  usable: true,
  immutableFlag: false,
};

const notFound = () => { throw Object.assign(new Error("GET /stamps/x → 404: not found"), { status: 404 }); };
const refused = () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); };

function readers(ethernaStamp: () => Promise<Record<string, unknown>>) {
  return {
    deposit: async () => 10n ** 18n,
    beeStamp: async () => ({ ...LIVE_STAMP }),
    chainstate: async () => ({ block: 100, chainTip: 100 }),
    ethernaStamp,
  } as unknown as Parameters<typeof probes.refreshPostage>[0];
}

async function readEtherna(ethernaStamp: () => Promise<Record<string, unknown>>): Promise<void> {
  await probes.refreshPostage(readers(ethernaStamp), () => {});
}

const stamp = (over: Record<string, unknown> = {}) => async () => ({ ...LIVE_STAMP, ...over });

function route(gatewayUrl = DEAD, ownerAddress = OWNER) {
  return router.batchForDeploy({ ownerAddress, gatewayUrl, deployType: "event" });
}

function assertRefused(fn: () => unknown, reason: RegExp): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof router.PlatformBatchUnavailable, `expected PlatformBatchUnavailable, got ${String(err)}`);
    assert.equal(err.status, 503);
    assert.equal(err.code, "STORAGE_UNAVAILABLE");
    assert.match(err.reason, reason);
    return true;
  });
}

beforeEach(() => {
  probes.__resetHealthProbes();
  process.env.ETHERNA_PLATFORM_BATCH = PLATFORM;
  process.env.ETHERNA_API_KEY = "id.secret";
  process.env.ETHERNA_ENABLED = "true";
});

after(() => probes.__resetHealthProbes());

// ---------------------------------------------------------------------------
// The rule, through the real probe
// ---------------------------------------------------------------------------

test("a healthy platform batch is written to", async () => {
  await readEtherna(stamp());
  assert.deepEqual(route(), { batchId: PLATFORM, target: "etherna" });
});

test("a batch Etherna says does not exist refuses", async () => {
  await readEtherna(async () => notFound());
  assertRefused(() => route(), /not found/);
});

test("a batch Etherna reports unusable refuses", async () => {
  await readEtherna(stamp({ usable: false }));
  assertRefused(() => route(), /unusable/);
});

test("a full bucket refuses: the next chunk would overwrite stored content", async () => {
  await readEtherna(stamp({ utilization: 8 }));
  assertRefused(() => route(), /bucket is full \(8\/8\)/);
  // Larger buckets too - the cap is 2^(depth - bucketDepth), not a constant.
  await readEtherna(stamp({ depth: 20, utilization: 16 }));
  assertRefused(() => route(), /16\/16/);
  await readEtherna(stamp({ depth: 20, utilization: 15 }));
  assert.equal(route().batchId, PLATFORM);
});

test("nearly full still writes - and the alarm fires", async () => {
  await readEtherna(stamp({ utilization: 7 }));
  assert.equal(route().batchId, PLATFORM);
  assert.equal(probes.postageHealth().etherna.checks.utilization.ok, false);
});

test("running low on time still writes - and the alarm fires", async () => {
  // The live reading: 3.9 days left, under the 7-day alarm.
  await readEtherna(stamp());
  assert.equal(route().batchId, PLATFORM);
  assert.equal(probes.postageHealth().etherna.checks.ttl.ok, false);
});

test("a TTL at or below zero is not death: bee reports that for an invalid price", async () => {
  for (const batchTTL of [0, -1]) {
    await readEtherna(stamp({ batchTTL }));
    assert.equal(route().batchId, PLATFORM, `batchTTL ${batchTTL}`);
    assert.equal(probes.postageHealth().etherna.checks.ttl.ok, false, `alarm for batchTTL ${batchTTL}`);
  }
});

// ---------------------------------------------------------------------------
// Unknown writes
// ---------------------------------------------------------------------------

test("before the first reading, writes go through", () => {
  assert.equal(route().batchId, PLATFORM);
});

test("a failed or incomplete reading is unknown, not dead", async () => {
  await readEtherna(async () => refused());
  assert.equal(route().batchId, PLATFORM);
  await readEtherna(async () => { throw Object.assign(new Error("x"), { status: 503 }); });
  assert.equal(route().batchId, PLATFORM);
  await readEtherna(stamp({ usable: undefined }));
  assert.equal(route().batchId, PLATFORM);
});

test("a reading goes stale exactly when /api/health calls it stale", async () => {
  await readEtherna(async () => notFound());
  const snap = probes.ethernaPlatformBatchSnapshot();
  assert.ok(snap.at !== null);
  const staleAt = snap.at + 3 * probes.ETHERNA_PROBE_INTERVAL_MS;
  assert.match(router.platformBatchRefusal(PLATFORM, snap, staleAt - 1) ?? "", /not found/);
  assert.equal(router.platformBatchRefusal(PLATFORM, snap, staleAt), null);
  assert.equal(probes.postageHealth(staleAt - 1).etherna.stale, false);
  assert.equal(probes.postageHealth(staleAt).etherna.stale, true);
});

test("a reading never vouches for a different batch", async () => {
  await readEtherna(async () => notFound());
  process.env.ETHERNA_PLATFORM_BATCH = OTHER_PLATFORM;
  assert.equal(route().batchId, OTHER_PLATFORM);
});

// ---------------------------------------------------------------------------
// Only the platform batch is guarded
// ---------------------------------------------------------------------------

test("the WoCo gateway never consults the Etherna reading", async () => {
  await readEtherna(async () => notFound());
  assert.deepEqual(route("https://gateway.woco-net.com"), { batchId: WOCO_BATCH, target: "wocoBee" });
});

test("an owner with a live batch of their own is routed to it, dead platform batch or not", async () => {
  await readEtherna(async () => notFound());
  assert.deepEqual(route(DEAD, USER_WITH_BATCH), { batchId: USER_BATCH, target: "etherna" });
});

test("a website deploy on the free-hosting fallback refuses too", async () => {
  await readEtherna(async () => notFound());
  assertRefused(
    () => router.batchForDeploy({ ownerAddress: OWNER, gatewayUrl: DEAD, deployType: "website", freeHostingEligible: true }),
    /not found/,
  );
});

// ---------------------------------------------------------------------------
// No silent detour to WoCo
// ---------------------------------------------------------------------------

test("user content refuses on a dead platform batch instead of landing on WoCo", async () => {
  await readEtherna(async () => notFound());
  assertRefused(() => router.batchForUserContent(OWNER), /not found/);
});

test("user content still falls back to WoCo when Etherna is simply not configured", () => {
  delete process.env.ETHERNA_PLATFORM_BATCH;
  assert.deepEqual(router.batchForUserContent(OWNER), { batchId: WOCO_BATCH, target: "wocoBee" });
});

test("never refuses without the alarm: every refusing reading is an alarm on /api/health", async () => {
  const cases: Array<[string, () => Promise<Record<string, unknown>>]> = [
    ["gone", async () => notFound()],
    ["unusable", stamp({ usable: false })],
    ["full", stamp({ utilization: 8 })],
  ];
  for (const [name, reader] of cases) {
    probes.__resetHealthProbes();
    await readEtherna(reader);
    assert.throws(() => route(), router.PlatformBatchUnavailable, name);
    assert.equal(probes.postageHealth().etherna.ok, false, name);
  }
});

// ---------------------------------------------------------------------------
// What callers answer
// ---------------------------------------------------------------------------

test("event create refuses before touching storage", async () => {
  await readEtherna(async () => notFound());
  await assert.rejects(
    createEventV2({
      eventId: "e1",
      title: "T",
      startDate: "2026-10-01T18:00:00Z",
      creatorAddress: OWNER,
      imageData: "",
      series: [],
    } as unknown as Parameters<typeof createEventV2>[0]),
    router.PlatformBatchUnavailable,
  );
});

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
  return { session, delegation: { message, parentSig } };
}

async function postAs(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const d = await mintDelegation();
  const text = JSON.stringify(body);
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const challenge = ["woco-session-v1", "POST", path, timestamp, nonce, sha256Hex(text)].join("\n");
  const resp = await app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Address": d.session.address,
      "X-Session-Delegation": Buffer.from(JSON.stringify(d.delegation), "utf-8").toString("base64"),
      "X-Session-Sig": await d.session.signMessage(challenge),
      "X-Session-Nonce": nonce,
      "X-Session-Timestamp": timestamp,
    },
    body: text,
  });
  return { status: resp.status, json: (await resp.json()) as Record<string, unknown> };
}

function assertStorageUnavailable(res: { status: number; json: Record<string, unknown> }, label: string): void {
  assert.equal(res.status, 503, `${label}: ${JSON.stringify(res.json)}`);
  assert.equal(res.json.code, "STORAGE_UNAVAILABLE", label);
  assert.match(String(res.json.error), /nothing was saved/, label);
}

test("the /bytes relay answers 503 STORAGE_UNAVAILABLE", async () => {
  await readEtherna(async () => notFound());
  const res = await postAs("/api/swarm/bytes", { dataB64: Buffer.from("hello").toString("base64"), gatewayUrl: DEAD });
  assertStorageUnavailable(res, "/bytes");
});

test("the /soc relay answers 503 STORAGE_UNAVAILABLE", async () => {
  await readEtherna(async () => notFound());
  const res = await postAs("/api/swarm/soc", {
    owner: "11".repeat(20),
    identifier: "22".repeat(32),
    signature: "33".repeat(65),
    span: "0400000000000000",
    payload: "44".repeat(32),
    gatewayUrl: DEAD,
  });
  assertStorageUnavailable(res, "/soc");
});

test("site publish refuses rather than detour its feed pages to WoCo", async () => {
  await readEtherna(async () => notFound());
  const res = await postAs("/api/sites", { site: { siteId: "site-610-liveness" }, gatewayUrl: DEAD });
  assertStorageUnavailable(res, "POST /api/sites");
});

test("the refusal copy uses a spaced hyphen, never an em dash", () => {
  assert.doesNotMatch(new router.PlatformBatchUnavailable("x").message, /—/);
});

// ---------------------------------------------------------------------------
// Ratchet: a new router caller must decide what a refusal means for it
// ---------------------------------------------------------------------------

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}

/** Callers that do not catch at all, so the refusal reaches the named route. */
const PROPAGATES_TO: Record<string, string> = {
  "lib/profile/service.ts": "routes/profiles.ts",
};

test("every module that routes a write also handles PlatformBatchUnavailable", () => {
  const read = (rel: string) => readFileSync(join(SRC, rel), "utf-8");
  const callers = sourceFiles(SRC)
    .map((p) => p.slice(SRC.length + 1))
    .filter((rel) => !rel.endsWith("batch-router.ts") && /\bbatchFor(Deploy|UserContent)\(/.test(read(rel)));
  assert.ok(callers.length >= 6, `found only ${callers.length} callers - did the scan break?`);
  const missing = callers.filter((rel) => !read(PROPAGATES_TO[rel] ?? rel).includes("PlatformBatchUnavailable"));
  assert.deepEqual(missing, []);
});

/**
 * The catch sites no test above can reach offline (they read a site or an event
 * from Swarm first): site add/remove-event, site-image upload, both deploys, the
 * event image edit, the event-create stream, the avatar route, and the legacy
 * event feed. Each one is a refusal that would otherwise become a 500 - or, in
 * the two feed helpers, a silent detour to WoCo. Pinned by count so deleting any
 * single one turns this red; adding one means updating the number on purpose.
 */
const REFUSAL_HANDLERS: Record<string, number> = {
  "routes/swarm.ts": 2, // /soc, /bytes
  "routes/events.ts": 2, // update-meta image, create stream error code
  "routes/site.ts": 1, // legacy single-site deploy
  "routes/sites.ts": 7, // siteFeedDest, siteFeedDestFromDirectory, upload-image, publish, add-event, remove-event, deploy
  "routes/profiles.ts": 1, // avatar
  "lib/event/service.ts": 1, // legacyEventFeedDest
  "lib/etherna/batch-router.ts": 1, // batchForUserContent
};

test("each refusal handler is still in place", () => {
  for (const [rel, expected] of Object.entries(REFUSAL_HANDLERS)) {
    const found = readFileSync(join(SRC, rel), "utf-8").match(/instanceof PlatformBatchUnavailable/g)?.length ?? 0;
    assert.equal(found, expected, rel);
  }
});
