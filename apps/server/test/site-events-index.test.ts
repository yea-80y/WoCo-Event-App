/**
 * Site events index edits (owner report 2026-10-08: an added event did not show,
 * or took ages). The index is written through the site's batch dest but read
 * from our bee, which lags a write, and the add/remove read was the lenient one.
 * Pinned here against a fake bee that accepts writes but never serves them back
 * (the worst case of that lag):
 *  - a fault reading the index refuses the edit (503) and writes nothing - it
 *    used to write an EMPTY index, wiping every other event on the site;
 *  - two quick adds both land: edits are serialised and build on what this
 *    server just wrote, not on bee's older copy;
 *  - the public list shows the new event straight away, with a short browser cache.
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

/** topic hex -> answer for feed reads. Unlisted topics read as absent. */
const feeds = new Map<string, "error" | { json: Record<string, unknown> }>();
const writes: string[] = [];
let encodeJsonFeed: (data: unknown) => Uint8Array;

const bee: Server = createServer((req, res) => {
  const url = req.url ?? "";
  if (req.method !== "GET") {
    req.resume();
    writes.push(`${req.method} ${url.split("?")[0]}`);
    res.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify({ reference: "ab".repeat(32) }));
    return;
  }
  const m = /^\/feeds\/[0-9a-fA-F]{40}\/([0-9a-fA-F]{64})/.exec(url);
  const answer = m ? feeds.get(m[1]!.toLowerCase()) : undefined;
  if (answer === "error") {
    res.writeHead(500).end();
    return;
  }
  if (answer) {
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "swarm-feed-index": "0000000000000000",
      "swarm-feed-index-next": "0000000000000001",
    }).end(Buffer.from(encodeJsonFeed(answer.json)));
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" }).end('{"code":404,"message":"Not Found"}');
});

let app: Hono;
let dir: string;
let shared: typeof import("@woco/shared");
let setStripeAccount: typeof import("../src/lib/stripe/accounts.js").setStripeAccount;
let topicEvent: typeof import("../src/lib/swarm/topics.js").topicEvent;
let resolveSiteEventSigner: typeof import("../src/lib/site/service.js").resolveSiteEventSigner;

before(async () => {
  await new Promise<void>((r) => bee.listen(0, "127.0.0.1", r));
  process.env.BEE_URL = `http://127.0.0.1:${(bee.address() as AddressInfo).port}`;
  process.env.PROXY_URL = DEAD;
  process.env.ETHERNA_GATEWAY_URL = DEAD;
  process.env.ETHERNA_TOKEN_ENDPOINT = `${DEAD}/token`;
  process.env.FEED_PRIVATE_KEY = Wallet.createRandom().privateKey;
  process.env.POSTAGE_BATCH_ID = "aa".repeat(32);
  process.env.ALLOWED_HOSTS = HOST;
  process.env.EMAIL_HASH_SECRET = "test-secret-site-events-index";
  delete process.env.STRIPE_SECRET_KEY;

  dir = mkdtempSync(join(tmpdir(), "woco-site-events-"));
  process.chdir(dir);
  mkdirSync(join(dir, ".data"));

  shared = await import("@woco/shared");
  const f = await import("../src/lib/swarm/feeds.js");
  encodeJsonFeed = f.encodeJsonFeed;
  f.__feedWriteTestHooks.setBaseBackoffMs(0);
  ({ setStripeAccount } = await import("../src/lib/stripe/accounts.js"));
  ({ topicEvent } = await import("../src/lib/swarm/topics.js"));
  ({ resolveSiteEventSigner } = await import("../src/lib/site/service.js"));
  const sites = await import("../src/routes/sites.js");
  app = new Hono();
  app.route("/api/sites", sites.sitesRouter);
});

after(async () => {
  await new Promise<void>((r) => bee.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

const hex = (topic: string) => Topic.fromString(topic).toHex().replace(/^0x/, "").toLowerCase();
const sha256Hex = (text: string) => createHash("sha256").update(text, "utf-8").digest("hex");

/** A published site owned by `owner`; its events index answers `events`. */
function site(owner: Wallet, events: "absent" | "error"): string {
  const siteId = `site-${randomUUID().slice(0, 12)}`;
  feeds.set(hex(shared.siteConfigTopic(siteId)), { json: { siteId, ownerAddress: owner.address.toLowerCase(), pages: [] } });
  if (events === "error") feeds.set(hex(shared.siteEventsIndexTopic(siteId)), "error");
  return siteId;
}

const signers = new Map<string, string>();

/** An event of `owner`'s that the signer lookup finds on its first read. */
function event(owner: Wallet): string {
  const eventId = randomUUID();
  const signer = Wallet.createRandom().address.toLowerCase();
  signers.set(eventId, signer);
  feeds.set(topicEvent(eventId).toHex().replace(/^0x/, "").toLowerCase(), {
    json: { eventId, creatorAddress: owner.address.toLowerCase(), creatorFeedSigner: signer, title: "t", series: [] },
  });
  return eventId;
}

async function organiser() {
  const w = Wallet.createRandom();
  setStripeAccount(w.address.toLowerCase(), `acct_${randomUUID().slice(0, 8)}`, true);
  return w;
}

async function addEvent(parent: Wallet, siteId: string, eventId: string) {
  return call(parent, "POST", `/api/sites/${siteId}/events`, JSON.stringify({ eventId }));
}

async function removeEvent(parent: Wallet, siteId: string, eventId: string) {
  return call(parent, "DELETE", `/api/sites/${siteId}/events/${eventId}`, "");
}

async function call(parent: Wallet, method: "POST" | "DELETE", path: string, body: string) {
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
  return { status: resp.status, json: (await resp.json()) as { ok: boolean; error?: string; data?: { events: Array<{ eventId: string }> } } };
}

test("an index we cannot read refuses the edit and writes nothing (it used to write an empty index)", async () => {
  const owner = await organiser();
  const siteId = site(owner, "error");
  writes.length = 0;
  const { status, json } = await addEvent(owner, siteId, event(owner));
  assert.equal(status, 503);
  assert.match(String(json.error), /Could not read this site's events/);
  assert.deepEqual(writes, []);
});

test("two quick adds both land, though bee never serves back what was written", async () => {
  const owner = await organiser();
  const siteId = site(owner, "absent");
  const [a, b] = [event(owner), event(owner)];
  const [ra, rb] = await Promise.all([addEvent(owner, siteId, a), addEvent(owner, siteId, b)]);
  assert.equal(ra.status, 200, ra.json.error);
  assert.equal(rb.status, 200, rb.json.error);
  const last = [ra, rb].map((r) => r.json.data!.events.map((e) => e.eventId)).sort((x, y) => y.length - x.length)[0];
  assert.deepEqual(new Set(last), new Set([a, b]), "the later edit built on the earlier one");
});

test("the public list shows an event the moment it is added, with a short browser cache", async () => {
  const owner = await organiser();
  const siteId = site(owner, "absent");
  const eventId = event(owner);
  assert.equal((await addEvent(owner, siteId, eventId)).status, 200);

  const list = await app.request(`/api/sites/${siteId}/events`);
  const listed = (await list.json()) as { data: { events: Array<{ eventId: string }> } };
  assert.ok(listed.data.events.some((e) => e.eventId === eventId));

  const full = await app.request(`/api/sites/${siteId}/events-full`);
  const fullJson = (await full.json()) as { data: { index: { events: Array<{ eventId: string }> } } };
  assert.ok(fullJson.data.index.events.some((e) => e.eventId === eventId));
  assert.equal(full.headers.get("Cache-Control"), "public, max-age=30, stale-while-revalidate=60");
});

test("a checkout straight after an add finds the new event's signer", async () => {
  const owner = await organiser();
  const siteId = site(owner, "absent");
  const eventId = event(owner);
  assert.equal((await addEvent(owner, siteId, eventId)).status, 200);
  // bee never serves the write back, so only the fresh copy can answer
  assert.equal(await resolveSiteEventSigner(siteId, eventId), signers.get(eventId));
});

test("remove builds on what was just written; removing an absent event writes nothing", async () => {
  const owner = await organiser();
  const siteId = site(owner, "absent");
  const [a, b] = [event(owner), event(owner)];
  assert.equal((await addEvent(owner, siteId, a)).status, 200);
  assert.equal((await addEvent(owner, siteId, b)).status, 200);
  const removed = await removeEvent(owner, siteId, a);
  assert.equal(removed.status, 200, removed.json.error);
  assert.deepEqual(removed.json.data!.events.map((e) => e.eventId), [b]);

  writes.length = 0;
  const again = await removeEvent(owner, siteId, a);
  assert.equal(again.status, 200);
  assert.deepEqual(writes, [], "nothing to remove, nothing written");
});
