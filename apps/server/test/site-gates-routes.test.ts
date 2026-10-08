/**
 * Route-level tests for the site gates (#214, #217). The libraries underneath
 * are tested on their own; these pin the WIRING, which was established only by
 * reading: each ownership decision answers 503 when the config read cannot
 * decide, 403 for a stranger, and lets the caller through when no site exists;
 * the deploy routes refuse a bad id or gateway before anything else; and the
 * head tags baked into a deployed site are escaped.
 *
 * A fake bee answers feed reads per topic (absent / error / a site), so the real
 * reader stack runs: readFeedPageStrict -> resolveSiteConfig -> the route.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { TypedDataEncoder, Wallet } from "ethers";
import { Topic } from "@ethersphere/bee-js";
import { enableFeature } from "./helpers/features.js";

enableFeature("walletLoginAllowed");

const DEAD = "http://127.0.0.1:9";
const HOST = "test.woco.local";
const PUBLIC_BASE = "https://events-api.woco-net.com";

type Mode = "absent" | "error" | { owner: string };
/** Feed topic hex -> what the fake bee answers. Unlisted topics are absent. */
const modes = new Map<string, Mode>();
let encodeJsonFeed: (data: unknown) => Uint8Array;

const bee: Server = createServer((req, res) => {
  const m = /^\/feeds\/[0-9a-fA-F]{40}\/([0-9a-fA-F]{64})/.exec(req.url ?? "");
  if (req.method !== "GET" || !m) {
    res.writeHead(500).end();
    return;
  }
  const mode = modes.get(m[1]!.toLowerCase()) ?? "absent";
  if (mode === "absent") {
    res.writeHead(404, { "Content-Type": "application/json" }).end('{"code":404,"message":"Not Found"}');
    return;
  }
  if (mode === "error") {
    res.writeHead(500).end();
    return;
  }
  const siteId = SITE_BY_TOPIC.get(m[1]!.toLowerCase());
  const body = Buffer.from(encodeJsonFeed({ siteId, ownerAddress: mode.owner, pages: [] }));
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "swarm-feed-index": "0000000000000000",
    "swarm-feed-index-next": "0000000000000001",
  }).end(body);
});
const SITE_BY_TOPIC = new Map<string, string>();

let app: Hono;
let dir: string;
let shared: typeof import("@woco/shared");
let setStripeAccount: typeof import("../src/lib/stripe/accounts.js").setStripeAccount;
let readFeedPageStrict: typeof import("../src/lib/swarm/feeds.js").readFeedPageStrict;
let deployHeadLines: typeof import("../src/routes/sites.js").deployHeadLines;

before(async () => {
  await new Promise<void>((r) => bee.listen(0, "127.0.0.1", r));
  process.env.BEE_URL = `http://127.0.0.1:${(bee.address() as AddressInfo).port}`;
  process.env.PROXY_URL = DEAD;
  process.env.ETHERNA_GATEWAY_URL = DEAD;
  process.env.ETHERNA_TOKEN_ENDPOINT = `${DEAD}/token`;
  process.env.FEED_PRIVATE_KEY = Wallet.createRandom().privateKey;
  process.env.POSTAGE_BATCH_ID = "aa".repeat(32);
  process.env.ALLOWED_HOSTS = HOST;
  process.env.PUBLIC_API_BASE = PUBLIC_BASE;
  process.env.EMAIL_HASH_SECRET = "test-secret-site-gates";
  delete process.env.STRIPE_SECRET_KEY;

  dir = mkdtempSync(join(tmpdir(), "woco-site-gates-"));
  process.chdir(dir);
  mkdirSync(join(dir, ".data"));

  shared = await import("@woco/shared");
  const feeds = await import("../src/lib/swarm/feeds.js");
  ({ encodeJsonFeed, readFeedPageStrict } = feeds);
  feeds.__feedWriteTestHooks.setBaseBackoffMs(0); // the publish-absent write retries against a 500
  ({ setStripeAccount } = await import("../src/lib/stripe/accounts.js"));
  const sites = await import("../src/routes/sites.js");
  deployHeadLines = sites.deployHeadLines;
  const { siteRoute } = await import("../src/routes/site.js");
  app = new Hono();
  app.route("/api/sites", sites.sitesRouter);
  app.route("/api/site", siteRoute);
});

after(async () => {
  await new Promise<void>((r) => bee.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

function topicHex(topic: string): string {
  return Topic.fromString(topic).toHex().replace(/^0x/, "").toLowerCase();
}

/** A fresh siteId whose config feed answers with `mode`. */
function siteWith(mode: Mode): string {
  const siteId = `site-${randomUUID().slice(0, 12)}`;
  const t = topicHex(shared.siteConfigTopic(siteId));
  modes.set(t, mode);
  SITE_BY_TOPIC.set(t, siteId);
  return siteId;
}

const sha256Hex = (text: string) => createHash("sha256").update(text, "utf-8").digest("hex");

/** A Stripe-verified organiser, so the storage gate in front of every write passes. */
async function organiser() {
  const parent = Wallet.createRandom();
  setStripeAccount(parent.address.toLowerCase(), `acct_${randomUUID().slice(0, 8)}`, true);
  return parent;
}

async function call(parent: Wallet, method: "POST" | "DELETE", path: string, payload: unknown = {}) {
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
  const body = method === "DELETE" ? "" : JSON.stringify(payload);
  const ts = String(Date.now());
  const reqNonce = randomUUID();
  const challenge = ["woco-session-v1", method, path, ts, reqNonce, sha256Hex(body)].join("\n");
  const resp = await app.request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Session-Address": session.address,
      "X-Session-Delegation": Buffer.from(JSON.stringify({ message, parentSig })).toString("base64"),
      "X-Session-Sig": await session.signMessage(challenge),
      "X-Session-Nonce": reqNonce,
      "X-Session-Timestamp": ts,
    },
    ...(method === "DELETE" ? {} : { body }),
  });
  return { status: resp.status, json: (await resp.json()) as { ok: boolean; error?: string } };
}

const UNDECIDABLE = /Could not verify site ownership/;

// --- The strict reader under every gate ---------------------------------------

test("readFeedPageStrict: a bee 404 is absent, a 500 is an error, a page is ok", async () => {
  const absent = siteWith("absent");
  const broken = siteWith("error");
  const present = siteWith({ owner: Wallet.createRandom().address.toLowerCase() });
  const read = (id: string) => readFeedPageStrict(Topic.fromString(shared.siteConfigTopic(id)));
  assert.equal((await read(absent)).status, "absent");
  assert.equal((await read(broken)).status, "error", "a fault must never read as absent");
  assert.equal((await read(present)).status, "ok");
});

// --- Every ownership decision: publish, deploy, event add, event remove --------

const DECISIONS: Array<{ name: string; send: (who: Wallet, siteId: string) => ReturnType<typeof call> }> = [
  { name: "publish", send: (who, siteId) => call(who, "POST", "/api/sites", { site: { siteId } }) },
  { name: "deploy", send: (who, siteId) => call(who, "POST", `/api/sites/${siteId}/deploy`, { apiUrl: PUBLIC_BASE }) },
  { name: "event add", send: (who, siteId) => call(who, "POST", `/api/sites/${siteId}/events`, { eventId: randomUUID() }) },
  { name: "event remove", send: (who, siteId) => call(who, "DELETE", `/api/sites/${siteId}/events/${randomUUID()}`) },
];

for (const d of DECISIONS) {
  test(`${d.name}: an undecidable config read is a retryable 503, never a pass`, async () => {
    const { status, json } = await d.send(await organiser(), siteWith("error"));
    assert.equal(status, 503);
    assert.match(String(json.error), UNDECIDABLE);
  });

  test(`${d.name}: a stranger to an existing site is refused (403)`, async () => {
    const owner = Wallet.createRandom().address.toLowerCase();
    const { status, json } = await d.send(await organiser(), siteWith({ owner }));
    assert.equal(status, 403);
    assert.equal(json.error, "Not the site owner");
  });
}

test("publish and deploy pass the gate when no site exists; event add/remove answer 404", async () => {
  const who = await organiser();
  for (const d of DECISIONS) {
    const { status, json } = await d.send(who, siteWith("absent"));
    assert.notEqual(status, 403, d.name);
    assert.doesNotMatch(String(json.error), UNDECIDABLE, d.name);
    if (d.name.startsWith("event")) assert.equal(status, 404, d.name);
  }
});

// --- Deploy input refused before anything uses it -----------------------------

test("site deploy refuses a gateway that is not on the allowlist (400)", async () => {
  const { status } = await call(await organiser(), "POST", `/api/sites/${siteWith("absent")}/deploy`, {
    apiUrl: PUBLIC_BASE,
    gatewayUrl: "https://gateway.example.org",
  });
  assert.equal(status, 400);
});

test("event-page deploy refuses a malformed eventId (400)", async () => {
  const { status, json } = await call(await organiser(), "POST", "/api/site/deploy", { eventId: "../../x" });
  assert.equal(status, 400);
  assert.match(String(json.error), /eventId/);
});

// --- The head tags baked into a deployed site ---------------------------------

test("deployHeadLines escapes every organiser-supplied value", () => {
  const html = deployHeadLines(
    {
      siteId: "site-escape-test",
      theme: {
        brandName: '"><script>alert(1)</script>',
        siteDescription: '<img src=x onerror="alert(2)">',
        logoSwarmRef: 'ab"><b>',
        palette: { accent: '" onload="alert(3)' },
      },
    } as unknown as Parameters<typeof deployHeadLines>[0],
    "https://gateway.woco-net.com",
  );
  assert.doesNotMatch(html, /<script|<img|<b>/);
  assert.doesNotMatch(html, /" onload="/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&quot; onload=&quot;/);
});
