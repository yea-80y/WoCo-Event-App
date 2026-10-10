/**
 * Likes and follows need the same unlock as a name, a profile or a photo: a
 * ticket in the account, Stripe verification, or a confirmed invite
 * (lib/gate/check.ts). Each one stamps platform storage, and a free account
 * must not be able to spend it (owner decision 2026-10-01).
 *
 * The relay is the only write path for them, so the rule lives there: a SOC
 * whose payload names a like/follow format is refused with the same
 * `ticket_required` the profile routes send, which the client turns into its
 * unlock flow. Everything else the relay carries is untouched.
 *
 * MUTATION: drop the check in routes/swarm.ts, drop a format from
 * SOCIAL_FORMATS, or let the gate's answer through unread, and a case goes red.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { TypedDataEncoder, Wallet } from "ethers";
import { enableFeature } from "./helpers/features.js";

enableFeature("walletLoginAllowed");

// Every network host is a closed local port, so the gate's Swarm reads (an
// organiser's events, the referral index) fail fast and answer "not unlocked".
const DEAD = "http://127.0.0.1:9";
const HOST = "test.woco.local";

process.env.POSTAGE_BATCH_ID = "aa".repeat(32);
process.env.ETHERNA_GATEWAY_URL = DEAD;
process.env.ETHERNA_TOKEN_ENDPOINT = `${DEAD}/token`;
process.env.BEE_URL = DEAD;
process.env.PROXY_URL = DEAD;
process.env.ALLOWED_HOSTS = HOST;
process.env.EMAIL_HASH_SECRET = "test-secret-social-unlock";
delete process.env.ATTENDEE_GATE_DISABLED;

let app: Hono;
let setStripeAccount: typeof import("../src/lib/stripe/accounts.js").setStripeAccount;
let isSocialPayload: typeof import("../src/lib/swarm/soc-relay-limits.js").isSocialPayload;
let classifyRelayPayload: typeof import("../src/lib/swarm/soc-relay-limits.js").classifyRelayPayload;
let SESSION_DOMAIN: typeof import("@woco/shared").SESSION_DOMAIN;
let SESSION_TYPES: typeof import("@woco/shared").SESSION_TYPES;
let SESSION_PURPOSE: typeof import("@woco/shared").SESSION_PURPOSE;
let SESSION_EXPIRY_MS: typeof import("@woco/shared").SESSION_EXPIRY_MS;

before(async () => {
  // The stores pin DATA_DIR from cwd at import: never touch the real one.
  const dir = mkdtempSync(join(tmpdir(), "woco-social-unlock-"));
  process.chdir(dir);
  mkdirSync(join(dir, ".data"));
  ({ setStripeAccount } = await import("../src/lib/stripe/accounts.js"));
  ({ isSocialPayload, classifyRelayPayload } = await import("../src/lib/swarm/soc-relay-limits.js"));
  ({ SESSION_DOMAIN, SESSION_TYPES, SESSION_PURPOSE, SESSION_EXPIRY_MS } = await import("@woco/shared"));
  const { swarmRoutes } = await import("../src/routes/swarm.js");
  app = new Hono();
  app.route("/api/swarm", swarmRoutes);
});

const hexJson = (value: unknown) => Buffer.from(JSON.stringify(value), "utf-8").toString("hex");
const SUBJECT = "0x" + "ab".repeat(20);
const FOLLOW = hexJson({ format: "woco.follow.v1", subject: SUBJECT, value: true });
const LIKE = hexJson({ format: "woco.like.v1", subject: SUBJECT, value: true });
const FOLLOW_INDEX = hexJson({ format: "woco.follow-index.v1", subjects: [SUBJECT] });
const LIKE_INDEX = hexJson({ format: "woco.like-index.v1", subjects: [SUBJECT] });
const CREDIT = hexJson({ format: "woco.credit.v1" });
const SEALED = hexJson({ v: 2, ct: "00" });

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

type Account = Awaited<ReturnType<typeof mintDelegation>>;

async function relay(d: Account, payload: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const path = "/api/swarm/soc";
  const text = JSON.stringify({
    owner: "11".repeat(20),
    identifier: "22".repeat(32),
    signature: "33".repeat(65),
    span: "0400000000000000",
    payload,
  });
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

const refusedForUnlock = (r: { status: number; json: Record<string, unknown> }) =>
  r.status === 403 && r.json.error === "ticket_required";

// ── Which payloads are likes and follows ──────────────────────────────────

test("like and follow statements and their indexes are social; nothing else is", () => {
  for (const p of [FOLLOW, LIKE, FOLLOW_INDEX, LIKE_INDEX]) assert.equal(isSocialPayload(p), true);
  assert.equal(isSocialPayload("0x" + FOLLOW), true, "a 0x prefix is still the same payload");
  for (const p of [CREDIT, SEALED, "44".repeat(32), "zz", "", hexJson("woco.follow.v1")]) {
    assert.equal(isSocialPayload(p), false, `not social: ${p.slice(0, 24)}`);
  }
});

test("the rate classifier still counts credits as statements", () => {
  assert.equal(classifyRelayPayload(CREDIT), "statement");
  assert.equal(classifyRelayPayload(FOLLOW), "statement");
  assert.equal(classifyRelayPayload(SEALED), "other");
});

// ── The relay ─────────────────────────────────────────────────────────────

test("a fresh account cannot like or follow: same refusal as a profile save", async () => {
  const fresh = await mintDelegation();
  for (const [label, payload] of [["follow", FOLLOW], ["like", LIKE], ["follow index", FOLLOW_INDEX], ["like index", LIKE_INDEX]]) {
    const r = await relay(fresh, payload);
    assert.ok(refusedForUnlock(r), `${label}: ${r.status} ${JSON.stringify(r.json)}`);
  }
});

test("everything else a fresh account writes is not refused for the unlock", async () => {
  const fresh = await mintDelegation();
  for (const [label, payload] of [["sealed envelope", SEALED], ["credit", CREDIT], ["opaque", "44".repeat(32)]]) {
    const r = await relay(fresh, payload);
    assert.ok(!refusedForUnlock(r), `${label} was refused for the unlock`);
  }
});

test("a Stripe-verified account gets past the unlock", async () => {
  const verified = await mintDelegation();
  setStripeAccount(verified.parent.address.toLowerCase(), "acct_social_unlock", true);
  for (const payload of [FOLLOW, LIKE, FOLLOW_INDEX, LIKE_INDEX]) {
    const r = await relay(verified, payload);
    assert.ok(!refusedForUnlock(r), `verified account refused: ${JSON.stringify(r.json)}`);
  }
});

test("a Stripe account that has not finished verifying is still locked", async () => {
  const pending = await mintDelegation();
  setStripeAccount(pending.parent.address.toLowerCase(), "acct_social_pending", false);
  assert.ok(refusedForUnlock(await relay(pending, FOLLOW)));
});
