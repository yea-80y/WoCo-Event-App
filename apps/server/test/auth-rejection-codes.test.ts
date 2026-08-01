/**
 * Auth rejections — telling the four failures apart.
 *
 * `requireAuth` can refuse a request for reasons that need materially different
 * responses from the client, and for a long time it returned all of them as an
 * opaque 401/403 with a human-readable string and no log line. A user hit one on
 * mobile ("signature invalid"), fixed it by signing out and back in, and there
 * was no way afterwards to tell WHICH of the four had fired.
 *
 * What matters now, and what these tests pin:
 *
 *  - A delegation the server won't accept is SESSION_INVALID. The client's cure
 *    is to mint a new one, so this is the only code it retries on.
 *  - A wrong device clock is SESSION_CLOCK_SKEW, NOT SESSION_INVALID. Re-signing
 *    reproduces the same out-of-window timestamp, so a retry would burn a wallet
 *    prompt and fail identically. Conflating the two is the original bug.
 *  - A replayed nonce is SESSION_REPLAY. The delegation is fine; there is
 *    nothing to re-establish.
 *  - A good request still passes, and carries no code at all.
 *
 * The parent here is a plain EOA, so verification stays on the local-ecrecover
 * path — no RPC, no chain state, deterministic in CI.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { Wallet, TypedDataEncoder } from "ethers";
import { createHash, randomUUID } from "node:crypto";
import {
  SESSION_DOMAIN,
  SESSION_TYPES,
  SESSION_PURPOSE,
  SESSION_EXPIRY_MS,
  AuthErrorCode,
} from "@woco/shared";

const HOST = "test.woco.local";
process.env.ALLOWED_HOSTS = HOST;

const { requireAuth } = await import("../src/middleware/auth.js");

const app = new Hono();
app.post("/api/test", requireAuth, (c) =>
  c.json({ ok: true, data: { parent: c.get("parentAddress") } }),
);

const sha256Hex = (text: string) => createHash("sha256").update(text, "utf-8").digest("hex");

/** Mint a delegation exactly as the browser does (session-delegation.ts). */
async function mintDelegation(opts: { host?: string; issuedAtOffsetMs?: number } = {}) {
  const parent = Wallet.createRandom();
  const session = Wallet.createRandom();
  const host = opts.host ?? HOST;
  const nonce = randomUUID();

  const message = {
    host,
    parent: parent.address,
    session: session.address,
    purpose: SESSION_PURPOSE,
    nonce,
    issuedAt: new Date(Date.now() + (opts.issuedAtOffsetMs ?? 0)).toISOString(),
    expiresAt: new Date(Date.now() + SESSION_EXPIRY_MS).toISOString(),
    sessionProof: await session.signMessage(`${host}:${nonce}`),
    clientCodeHash: "0x" + "00".repeat(32),
    statement: `Authorize ${session.address} as session key for ${host}`,
  };

  const parentSig = await parent.signTypedData(
    SESSION_DOMAIN,
    SESSION_TYPES as unknown as Parameters<typeof TypedDataEncoder.hash>[1],
    message,
  );

  return { parent, session, delegation: { message, parentSig } };
}

/** Build the headers for one signed request. */
async function signRequest(
  d: Awaited<ReturnType<typeof mintDelegation>>,
  bodyText: string,
  overrides: { timestamp?: number; nonce?: string; path?: string } = {},
) {
  const path = overrides.path ?? "/api/test";
  const timestamp = String(overrides.timestamp ?? Date.now());
  const nonce = overrides.nonce ?? randomUUID();
  const challenge = ["woco-session-v1", "POST", path, timestamp, nonce, sha256Hex(bodyText)].join("\n");

  return {
    "Content-Type": "application/json",
    "X-Session-Address": d.session.address,
    "X-Session-Delegation": Buffer.from(JSON.stringify(d.delegation), "utf-8").toString("base64"),
    "X-Session-Sig": await d.session.signMessage(challenge),
    "X-Session-Nonce": nonce,
    "X-Session-Timestamp": timestamp,
  };
}

async function callWith(headers: Record<string, string>, bodyText: string) {
  const resp = await app.request("/api/test", { method: "POST", headers, body: bodyText });
  return { status: resp.status, json: (await resp.json()) as Record<string, unknown> };
}

test("a correctly signed request passes and carries no error code", async () => {
  const d = await mintDelegation();
  const body = JSON.stringify({ hello: "world" });
  const { status, json } = await callWith(await signRequest(d, body), body);

  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.code, undefined);
  // The handler sees the VERIFIED parent, never anything from the body.
  assert.equal(
    (json.data as { parent: string }).parent.toLowerCase(),
    d.parent.address.toLowerCase(),
  );
});

test("a body altered after signing is SESSION_INVALID — the challenge commits to the exact bytes", async () => {
  const d = await mintDelegation();
  const signedBody = JSON.stringify({ amount: 10 });
  const headers = await signRequest(d, signedBody);

  const { status, json } = await callWith(headers, JSON.stringify({ amount: 10000 }));

  assert.equal(status, 403);
  assert.equal(json.ok, false);
  assert.equal(json.code, AuthErrorCode.SESSION_INVALID);
});

test("a session key that did not sign the challenge is SESSION_INVALID", async () => {
  const d = await mintDelegation();
  const body = JSON.stringify({});
  const headers = await signRequest(d, body);
  // Swap in a signature from an unrelated key.
  const impostor = Wallet.createRandom();
  headers["X-Session-Sig"] = await impostor.signMessage("woco-session-v1\nPOST\n/api/test\n0\n0\n0");

  const { status, json } = await callWith(headers, body);

  assert.equal(status, 403);
  assert.equal(json.code, AuthErrorCode.SESSION_INVALID);
});

test("a host outside ALLOWED_HOSTS is SESSION_INVALID — host binding is the guard, there is no chainId", async () => {
  const d = await mintDelegation({ host: "evil.example.com" });
  const body = JSON.stringify({});
  const { status, json } = await callWith(await signRequest(d, body), body);

  assert.equal(status, 403);
  assert.equal(json.code, AuthErrorCode.SESSION_INVALID);
});

test("a missing delegation header is SESSION_INVALID", async () => {
  const d = await mintDelegation();
  const body = JSON.stringify({});
  const headers = await signRequest(d, body);
  delete (headers as Record<string, string>)["X-Session-Delegation"];

  const { status, json } = await callWith(headers, body);

  assert.equal(status, 401);
  assert.equal(json.code, AuthErrorCode.SESSION_INVALID);
});

test("a stale clock is SESSION_CLOCK_SKEW, never SESSION_INVALID — retrying it would fail identically", async () => {
  const d = await mintDelegation();
  const body = JSON.stringify({});
  const headers = await signRequest(d, body, { timestamp: Date.now() - 10 * 60 * 1000 });

  const { status, json } = await callWith(headers, body);

  assert.equal(status, 401);
  assert.equal(json.code, AuthErrorCode.SESSION_CLOCK_SKEW);
  assert.notEqual(json.code, AuthErrorCode.SESSION_INVALID);
  // The measured drift is the whole diagnosis — it must reach the operator.
  assert.match(String(json.error), /device clock is \d+s from server time/);
});

test("a clock skewed into the FUTURE is caught too — the window is absolute", async () => {
  const d = await mintDelegation();
  const body = JSON.stringify({});
  const headers = await signRequest(d, body, { timestamp: Date.now() + 10 * 60 * 1000 });

  const { json } = await callWith(headers, body);
  assert.equal(json.code, AuthErrorCode.SESSION_CLOCK_SKEW);
});

test("a clock 2min fast passes the request window but fails issuedAt — and is skew, not SESSION_INVALID", async () => {
  // The nastiest case: 61s-300s fast slips through the +-5min request-timestamp
  // check, so it reaches verifyDelegation, where every FRESHLY MINTED delegation
  // is future-dated past the 60s tolerance. If this were SESSION_INVALID the
  // client would reset and re-mint on every action — and each new delegation
  // would be future-dated too, so the user would face an endless signing prompt.
  const d = await mintDelegation({ issuedAtOffsetMs: 2 * 60 * 1000 });
  const body = JSON.stringify({});

  // Timestamp itself is inside the window — this is NOT caught by the skew check.
  const { status, json } = await callWith(await signRequest(d, body), body);

  assert.equal(status, 403);
  assert.equal(json.code, AuthErrorCode.SESSION_CLOCK_SKEW);
  assert.notEqual(json.code, AuthErrorCode.SESSION_INVALID);
  assert.match(String(json.error), /in the future/);
});

test("issuedAt inside the 60s tolerance still passes — ordinary jitter is not a failure", async () => {
  const d = await mintDelegation({ issuedAtOffsetMs: 30 * 1000 });
  const body = JSON.stringify({});
  const { status } = await callWith(await signRequest(d, body), body);
  assert.equal(status, 200);
});

test("an unparseable issuedAt is rejected outright", async () => {
  const d = await mintDelegation();
  (d.delegation.message as { issuedAt: string }).issuedAt = "not-a-date";
  const body = JSON.stringify({});
  const { status, json } = await callWith(await signRequest(d, body), body);
  assert.equal(status, 403);
  assert.equal(json.ok, false);
});

test("replaying a captured request is SESSION_REPLAY — distinct from a bad delegation", async () => {
  const d = await mintDelegation();
  const body = JSON.stringify({ once: true });
  const headers = await signRequest(d, body);

  const first = await callWith(headers, body);
  assert.equal(first.status, 200, "the first use must succeed");

  const second = await callWith(headers, body);
  assert.equal(second.status, 403);
  assert.equal(second.json.code, AuthErrorCode.SESSION_REPLAY);
  assert.notEqual(second.json.code, AuthErrorCode.SESSION_INVALID);
});

test("a rejected request never reaches the handler", async () => {
  let handlerRan = false;
  const guarded = new Hono();
  guarded.post("/api/test", requireAuth, (c) => {
    handlerRan = true;
    return c.json({ ok: true });
  });

  const d = await mintDelegation();
  const body = JSON.stringify({});
  const headers = await signRequest(d, body, { timestamp: 0 });
  await guarded.request("/api/test", { method: "POST", headers, body });

  assert.equal(handlerRan, false);
});

test("the three codes are distinct — the client branches on them and must not collide", () => {
  const codes = [
    AuthErrorCode.SESSION_INVALID,
    AuthErrorCode.SESSION_CLOCK_SKEW,
    AuthErrorCode.SESSION_REPLAY,
  ];
  assert.equal(new Set(codes).size, 3);
});
