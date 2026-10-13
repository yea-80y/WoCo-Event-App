/**
 * Organising needs a passkey account (#746 step 5, Fable consult 8 Q5). The server
 * can tell a plain wallet from a smart account by how the delegation verified -
 * a wallet signs for itself - but not a passkey smart account from an email one,
 * so the server half is: a wallet account never starts Stripe onboarding. The
 * email half is the app's (`organiser-account.ts`).
 *
 * MUTATION: drop the Stripe connect refusal, or mark a wallet delegation as a
 * smart account, and a case goes red.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { Wallet, TypedDataEncoder } from "ethers";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_DOMAIN, SESSION_TYPES, SESSION_PURPOSE, SESSION_EXPIRY_MS } from "@woco/shared";
import { enableFeature } from "./helpers/features.js";

enableFeature("walletLoginAllowed");

const HOST = "test.woco.local";
process.env.ALLOWED_HOSTS = HOST;
delete process.env.STRIPE_SECRET_KEY;
process.chdir(mkdtempSync(join(tmpdir(), "woco-organiser-gate-")));

const { requireAuth } = await import("../src/middleware/auth.js");
const { stripeRoutes } = await import("../src/routes/stripe.js");

const app = new Hono();
app.post("/api/probe", requireAuth, (c) => c.json({ ok: true, data: { parentKind: c.get("parentKind") } }));
app.route("/api/stripe", stripeRoutes);

const sha256Hex = (text: string) => createHash("sha256").update(text, "utf-8").digest("hex");

/** A plain wallet account's delegation: the wallet signs for itself. */
async function walletSession() {
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

async function post(path: string, s: Awaited<ReturnType<typeof walletSession>>, body = "{}") {
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const challenge = ["woco-session-v1", "POST", path, timestamp, nonce, sha256Hex(body)].join("\n");
  const resp = await app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Address": s.session.address,
      "X-Session-Delegation": Buffer.from(JSON.stringify(s.delegation), "utf-8").toString("base64"),
      "X-Session-Sig": await s.session.signMessage(challenge),
      "X-Session-Nonce": nonce,
      "X-Session-Timestamp": timestamp,
    },
    body,
  });
  return { status: resp.status, json: (await resp.json()) as Record<string, any> };
}

test("a wallet's own delegation is a wallet account", async () => {
  const res = await post("/api/probe", await walletSession());
  assert.equal(res.status, 200);
  assert.equal(res.json.data.parentKind, "eoa");
});

test("a wallet account cannot start or finish Stripe onboarding: organising needs a passkey account", async () => {
  for (const path of ["/api/stripe/connect", "/api/stripe/onboarding-link", "/api/stripe/account-session"]) {
    const res = await post(path, await walletSession());
    assert.equal(res.status, 403, path);
    assert.equal(res.json.code, "PASSKEY_ACCOUNT_REQUIRED", path);
    assert.match(res.json.error, /Organising uses a passkey account/);
  }
});

test("a success path that does not classify the parent leaves it unset - never the permissive default", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/lib/auth/verify-delegation.ts", import.meta.url)), "utf8");
  assert.match(src, /let parentKind: VerifyDelegationResult\["parentKind"\];/);
  assert.equal((src.match(/parentKind = "kernel";/g) ?? []).length, 3, "the device, co-owner and owner branches, explicitly");
});
