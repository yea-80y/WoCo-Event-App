/**
 * `/api/events/:id/list`, `/unlist` and `/discover` fetch from a caller-supplied
 * server (#186). Two rules, pinned here:
 *  - an event created here is listed or unlisted only by the creator recorded at
 *    create (#670) - a stranger is refused before any remote server is asked,
 *    and an unreadable record file refuses everyone (503) rather than fall back;
 *  - only a public https source is fetched, never a private or plain-http one,
 *    and no redirect is followed.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { TypedDataEncoder, Wallet } from "ethers";

const DEAD = "http://127.0.0.1:9";
const HOST = "test.woco.local";
const PUBLIC_BASE = "https://api.test.example";
const ELSEWHERE = "https://elsewhere.test.example";

process.env.BEE_URL = DEAD;
process.env.PROXY_URL = DEAD;
process.env.ALLOWED_HOSTS = HOST;
process.env.PUBLIC_API_BASE = PUBLIC_BASE;
process.env.EMAIL_HASH_SECRET = "test-secret-events-list-source";

/** Every fetch to a test host, with its options. Anything else falls through to DEAD addresses. */
const calls: Array<{ url: string; redirect?: RequestRedirect }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith(PUBLIC_BASE) || url.startsWith(ELSEWHERE)) {
    calls.push({ url, redirect: init?.redirect });
    return new Response(JSON.stringify({ ok: false, error: "stub" }), { status: 404 });
  }
  return realFetch(input, init);
}) as typeof fetch;

const OWNER = Wallet.createRandom();
const RECORDED_EVENT = randomUUID();

let app: Hono;
let dir: string;
let shared: typeof import("@woco/shared");

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "woco-events-list-"));
  process.chdir(dir);
  mkdirSync(join(dir, ".data"));
  shared = await import("@woco/shared");
  const { recordEventFeedSigner } = await import("../src/lib/event/feed-signer-record.js");
  recordEventFeedSigner(RECORDED_EVENT, Wallet.createRandom().address, OWNER.address);
  const { events } = await import("../src/routes/events.js");
  app = new Hono();
  app.route("/api/events", events);
});

after(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

const sha256Hex = (text: string) => createHash("sha256").update(text, "utf-8").digest("hex");

async function post(parent: Wallet, path: string, payload: Record<string, unknown>) {
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
  const body = JSON.stringify(payload);
  const ts = String(Date.now());
  const reqNonce = randomUUID();
  const challenge = ["woco-session-v1", "POST", path, ts, reqNonce, sha256Hex(body)].join("\n");
  const resp = await app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Address": session.address,
      "X-Session-Delegation": Buffer.from(JSON.stringify({ message, parentSig })).toString("base64"),
      "X-Session-Sig": await session.signMessage(challenge),
      "X-Session-Nonce": reqNonce,
      "X-Session-Timestamp": ts,
    },
    body,
  });
  return { status: resp.status, json: (await resp.json()) as { ok: boolean; error?: string } };
}

test("a stranger cannot list an event created here, and no remote server is asked", async () => {
  calls.length = 0;
  const { status, json } = await post(Wallet.createRandom(), `/api/events/${RECORDED_EVENT}/list`, {
    sourceApiUrl: ELSEWHERE,
  });
  assert.equal(status, 403);
  assert.match(String(json.error), /not the creator/);
  assert.deepEqual(calls, [], "refused before any fetch");
});

test("/list never fetches a private or plain-http source: it asks this server's public API, without redirects", async () => {
  calls.length = 0;
  const eventId = randomUUID();
  await post(Wallet.createRandom(), `/api/events/${eventId}/list`, { sourceApiUrl: "http://127.0.0.1:1633" });
  assert.deepEqual(calls, [{ url: `${PUBLIC_BASE}/api/events/${eventId}`, redirect: "error" }]);
});

test("/list fetches a public https source only without following redirects", async () => {
  calls.length = 0;
  const eventId = randomUUID();
  await post(Wallet.createRandom(), `/api/events/${eventId}/list`, { sourceApiUrl: ELSEWHERE });
  assert.deepEqual(calls, [{ url: `${ELSEWHERE}/api/events/${eventId}`, redirect: "error" }]);
});

test("/discover never fetches a private or plain-http source, and follows no redirect", async () => {
  calls.length = 0;
  await post(Wallet.createRandom(), "/api/events/discover", { sourceApiUrl: "http://bee-node:1633" });
  assert.deepEqual(calls, [{ url: `${PUBLIC_BASE}/api/events`, redirect: "error" }]);
});

test("/unlist: a stranger is refused before any fetch, and a private source becomes the public base", async () => {
  calls.length = 0;
  const refused = await post(Wallet.createRandom(), `/api/events/${RECORDED_EVENT}/unlist`, { sourceApiUrl: ELSEWHERE });
  assert.equal(refused.status, 403);
  assert.deepEqual(calls, []);

  const eventId = randomUUID();
  await post(Wallet.createRandom(), `/api/events/${eventId}/unlist`, { sourceApiUrl: "http://127.0.0.1:1633" });
  assert.deepEqual(calls, [{ url: `${PUBLIC_BASE}/api/events/${eventId}`, redirect: "error" }]);
});

test("an unreadable record file refuses /list and /unlist (503) instead of asking a remote server", async () => {
  const rec = await import("../src/lib/event/feed-signer-record.js");
  const file = join(dir, ".data", "event-feed-signers.json");
  const good = readFileSync(file, "utf-8");
  writeFileSync(file, "{ truncated");
  rec.__resetFeedSignerRecordForTest();
  try {
    calls.length = 0;
    for (const action of ["list", "unlist"]) {
      const { status } = await post(Wallet.createRandom(), `/api/events/${randomUUID()}/${action}`, { sourceApiUrl: ELSEWHERE });
      assert.equal(status, 503, action);
    }
    assert.deepEqual(calls, []);
  } finally {
    writeFileSync(file, good);
    rec.__resetFeedSignerRecordForTest();
  }
});
