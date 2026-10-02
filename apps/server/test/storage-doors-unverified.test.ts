/**
 * Four ways into platform storage that any signed-in account could use, now
 * closed to an account that has not been verified (owner decision 2026-10-02:
 * nothing an unverified account does may cost the platform money).
 *
 *   - website save, logo upload and go-live need a Stripe-verified organiser,
 *     or the account's own live Etherna batch, on EVERY gateway. Go-live was
 *     checked only on the Etherna fallback; naming the WoCo gateway (or none)
 *     skipped the check and stored a whole site bundle.
 *   - a contact list may only GROW for a verified organiser. Removing contacts
 *     stays open to anyone with a list, so erasure never depends on Stripe.
 *   - raw uploads and issuer statements need the name unlock (no screen uses
 *     either; the refusal is the profile routes' `ticket_required`).
 *
 * Every case stops before storage, so the dead network hosts below are never
 * reached by a refused request; an allowed one fails later, for other reasons,
 * which these cases do not look at.
 *
 * MUTATION: drop any of the checks, or let a list grow without verification,
 * and a case goes red.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { TypedDataEncoder, Wallet } from "ethers";

const DEAD = "http://127.0.0.1:9";
const HOST = "test.woco.local";
const ETHERNA = "https://gateway.etherna.io";

process.env.POSTAGE_BATCH_ID = "aa".repeat(32);
process.env.ETHERNA_GATEWAY_URL = DEAD;
process.env.ETHERNA_TOKEN_ENDPOINT = `${DEAD}/token`;
process.env.BEE_URL = DEAD;
process.env.PROXY_URL = DEAD;
process.env.ALLOWED_HOSTS = HOST;
process.env.EMAIL_HASH_SECRET = "test-secret-storage-doors";
delete process.env.ATTENDEE_GATE_DISABLED;
delete process.env.STRIPE_SECRET_KEY;

/** An account paying for its own Etherna batch. */
const OWN_BATCH = Wallet.createRandom();

let app: Hono;
let setStripeAccount: typeof import("../src/lib/stripe/accounts.js").setStripeAccount;
let putList: typeof import("../src/lib/marketing/list-store.js").putList;
let hashEmail: typeof import("../src/lib/event/claim-service.js").hashEmail;
let SESSION_DOMAIN: typeof import("@woco/shared").SESSION_DOMAIN;
let SESSION_TYPES: typeof import("@woco/shared").SESSION_TYPES;
let SESSION_PURPOSE: typeof import("@woco/shared").SESSION_PURPOSE;
let SESSION_EXPIRY_MS: typeof import("@woco/shared").SESSION_EXPIRY_MS;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "woco-storage-doors-"));
  process.chdir(dir);
  mkdirSync(join(dir, ".data"));
  writeFileSync(join(dir, ".data", "etherna-batches.json"), JSON.stringify({
    [OWN_BATCH.address.toLowerCase()]: {
      batchId: "ee".repeat(32),
      depth: 20,
      ttlDays: 365,
      purchasedAt: "2026-09-01T00:00:00Z",
      expiresAt: "2099-01-01T00:00:00Z",
      paidUntil: "2099-01-01T00:00:00Z",
      gateway: ETHERNA,
    },
  }));
  ({ setStripeAccount } = await import("../src/lib/stripe/accounts.js"));
  ({ putList } = await import("../src/lib/marketing/list-store.js"));
  ({ hashEmail } = await import("../src/lib/event/claim-service.js"));
  ({ SESSION_DOMAIN, SESSION_TYPES, SESSION_PURPOSE, SESSION_EXPIRY_MS } = await import("@woco/shared"));
  const { swarmRoutes } = await import("../src/routes/swarm.js");
  const { sitesRouter } = await import("../src/routes/sites.js");
  const { issuerRouter } = await import("../src/routes/issuer.js");
  const { marketing } = await import("../src/routes/marketing.js");
  app = new Hono();
  app.route("/api/swarm", swarmRoutes);
  app.route("/api/sites", sitesRouter);
  app.route("/api/issuer", issuerRouter);
  app.route("/api/marketing", marketing);
});

const sha256Hex = (text: string) => createHash("sha256").update(text, "utf-8").digest("hex");

async function account(parent: Wallet = Wallet.createRandom()) {
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
  return { address: parent.address.toLowerCase(), session, delegation: { message, parentSig } };
}
type Account = Awaited<ReturnType<typeof account>>;

async function verified(): Promise<Account> {
  const a = await account();
  setStripeAccount(a.address, `acct_${randomUUID().slice(0, 8)}`, true);
  return a;
}

async function post(a: Account, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const text = JSON.stringify(body);
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
  let json: Record<string, unknown> = {};
  try { json = (await resp.json()) as Record<string, unknown>; } catch { /* plain-text 500 */ }
  return { status: resp.status, json };
}

const needsStripe = (r: { status: number; json: Record<string, unknown> }) =>
  r.status === 403 && r.json.code === "STRIPE_VERIFICATION_REQUIRED";
const needsUnlock = (r: { status: number; json: Record<string, unknown> }) =>
  r.status === 403 && r.json.error === "ticket_required";

const SITE = (siteId: string) => ({ site: { siteId, ownerAddress: "0x" + "00".repeat(20) }, events: [] });
const IMAGE = { image: Buffer.from("tiny").toString("base64") };
const BOX = { v: 2, enc: "ab".repeat(1120), ct: "cd".repeat(48) };

// ── Websites ───────────────────────────────────────────────────────────────

test("an unverified account cannot save, upload a logo for, or put live a website", async () => {
  const fresh = await account();
  for (const gatewayUrl of [ETHERNA, "", "https://gateway.woco-net.com"]) {
    assert.ok(needsStripe(await post(fresh, "/api/sites", { ...SITE("doors-site-1"), gatewayUrl })), `save via "${gatewayUrl}"`);
    assert.ok(needsStripe(await post(fresh, "/api/sites/upload-image", { ...IMAGE, gatewayUrl })), `logo via "${gatewayUrl}"`);
    assert.ok(needsStripe(await post(fresh, "/api/sites/doors-site-1/deploy", { gatewayUrl })), `go-live via "${gatewayUrl}"`);
  }
});

test("a verified organiser, or an account with its own batch, gets past the check", async () => {
  for (const a of [await verified(), await account(OWN_BATCH)]) {
    for (const [path, body] of [
      ["/api/sites", { ...SITE("doors-site-2"), gatewayUrl: "" }],
      ["/api/sites/upload-image", { ...IMAGE, gatewayUrl: "" }],
      ["/api/sites/doors-site-2/deploy", { gatewayUrl: "" }],
    ] as const) {
      assert.ok(!needsStripe(await post(a, path, body)), `${path} refused a paying or verified account`);
    }
  }
});

// ── Contact lists ──────────────────────────────────────────────────────────

test("an unverified account cannot start a contact list, not even an empty one", async () => {
  const fresh = await account();
  assert.ok(needsStripe(await post(fresh, "/api/marketing/list", { sealedList: BOX, emails: ["new@example.com"] })));
  assert.ok(needsStripe(await post(fresh, "/api/marketing/list", { sealedList: BOX, emails: [] })));
});

test("removing contacts never needs verification; adding one does", async () => {
  const lapsed = await account();
  putList(lapsed.address, {
    swarmRef: "11".repeat(32),
    count: 2,
    updatedAt: new Date().toISOString(),
    emailHashes: [hashEmail("ada@example.com"), hashEmail("bo@example.com")],
  });
  for (const emails of [["ada@example.com"], [], ["ada@example.com", "bo@example.com"]]) {
    assert.ok(!needsStripe(await post(lapsed, "/api/marketing/list", { sealedList: BOX, emails })), `removal refused: ${emails}`);
  }
  assert.ok(needsStripe(await post(lapsed, "/api/marketing/list", { sealedList: BOX, emails: ["ada@example.com", "cy@example.com"] })));
});

test("a verified organiser can add contacts", async () => {
  const org = await verified();
  assert.ok(!needsStripe(await post(org, "/api/marketing/list", { sealedList: BOX, emails: ["new@example.com"] })));
});

// ── Raw uploads and issuer statements ──────────────────────────────────────

test("raw uploads and issuer statements need the unlock", async () => {
  const fresh = await account();
  assert.ok(needsUnlock(await post(fresh, "/api/swarm/bytes", { dataB64: Buffer.from("x").toString("base64") })));
  assert.ok(needsUnlock(await post(fresh, "/api/issuer/statement", { statement: {} })));
  const org = await verified();
  assert.ok(!needsUnlock(await post(org, "/api/swarm/bytes", { dataB64: Buffer.from("x").toString("base64") })));
  assert.ok(!needsUnlock(await post(org, "/api/issuer/statement", { statement: {} })));
});
