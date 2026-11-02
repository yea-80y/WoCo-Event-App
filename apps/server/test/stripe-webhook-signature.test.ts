/**
 * Who the Stripe webhook believes, end to end through Hono.
 *
 *   - Once a signing secret is configured, an event without a signature is
 *     refused whatever NODE_ENV says: the unsigned dev branch must not be one
 *     lost env var away from a server holding live secrets.
 *   - Either of the two endpoint secrets verifies (connected + platform).
 *   - The replay window is the SDK's 5 minutes: Stripe signs every delivery
 *     attempt afresh, so an older signature is a captured request, not a retry.
 *   - With no secret at all, production still refuses everything.
 *
 * Events here are of a type the route ignores, so 200 means "verified and
 * accepted" and nothing else; every outbound request is refused and counted,
 * so the suite provably never touches the network.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";
import { inspect } from "node:util";
import { Hono } from "hono";

process.chdir(mkdtempSync(join(tmpdir(), "woco-webhook-sig-")));
process.env.EMAIL_HASH_SECRET ??= "0".repeat(64);
process.env.FEED_PRIVATE_KEY ??= "11".repeat(32);
process.env.STRIPE_SECRET_KEY = "sk_test_signature_suite_no_network";

let outbound = 0;
function refuse(what: string) {
  return () => {
    outbound++;
    throw new Error(`no network in this suite (${what})`);
  };
}
globalThis.fetch = refuse("fetch") as unknown as typeof fetch;
(http as unknown as Record<string, unknown>)["request"] = refuse("http.request");
(https as unknown as Record<string, unknown>)["request"] = refuse("https.request");

const { stripeRoutes } = await import("../src/routes/stripe.js");
const { getStripe } = await import("../src/lib/stripe/client.js");
const app = new Hono();
app.route("/api/stripe", stripeRoutes);

const CONNECTED_SECRET = "whsec_connected_signature_suite";
const PLATFORM_SECRET = "whsec_platform_signature_suite";

/** The route reads both per request, so each test sets its own. */
function configure(env: { secrets: boolean; production: boolean }): void {
  if (env.secrets) {
    process.env.STRIPE_WEBHOOK_SECRET = CONNECTED_SECRET;
    process.env.STRIPE_WEBHOOK_SECRET_PLATFORM = PLATFORM_SECRET;
  } else {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET_PLATFORM;
  }
  if (env.production) process.env.NODE_ENV = "production";
  else delete process.env.NODE_ENV;
}

const BODY = JSON.stringify({ id: "evt_sig_1", type: "woco.test.ignored", created: 1 });

function signed(secret: string, ageSeconds = 0): string {
  return getStripe().webhooks.generateTestHeaderString({
    payload: BODY,
    secret,
    timestamp: Math.floor(Date.now() / 1000) - ageSeconds,
  });
}

function deliver(signature?: string): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== undefined) headers["stripe-signature"] = signature;
  return app.request("/api/stripe/webhook", { method: "POST", headers, body: BODY });
}

test("a configured secret refuses an unsigned event even outside production", async () => {
  configure({ secrets: true, production: false });
  outbound = 0;
  const res = await deliver();
  assert.equal(res.status, 400);
  assert.equal(await res.text(), "Webhook signature required");
  assert.equal(outbound, 0);
});

test("an empty signature header counts as no signature", async () => {
  configure({ secrets: true, production: false });
  const res = await deliver("");
  assert.equal(res.status, 400);
  assert.equal(await res.text(), "Webhook signature required");
});

test("an event signed with the connected-accounts secret is accepted", async () => {
  configure({ secrets: true, production: true });
  const res = await deliver(signed(CONNECTED_SECRET));
  assert.equal(res.status, 200);
});

test("an event signed with the platform secret is accepted", async () => {
  configure({ secrets: true, production: true });
  const res = await deliver(signed(PLATFORM_SECRET));
  assert.equal(res.status, 200);
});

test("an event signed with any other secret is refused", async () => {
  configure({ secrets: true, production: true });
  const res = await deliver(signed("whsec_someone_else"));
  assert.equal(res.status, 400);
  assert.equal(await res.text(), "Webhook signature verification failed");
});

test("a signature four minutes old is still inside the window", async () => {
  configure({ secrets: true, production: true });
  const res = await deliver(signed(CONNECTED_SECRET, 4 * 60));
  assert.equal(res.status, 200);
});

test("a signature ten minutes old is refused as a replay", async () => {
  configure({ secrets: true, production: true });
  const res = await deliver(signed(CONNECTED_SECRET, 10 * 60));
  assert.equal(res.status, 400);
  assert.equal(await res.text(), "Webhook signature verification failed");
});

test("a refused event's body never reaches the log", async () => {
  configure({ secrets: true, production: true });
  const marker = `woco-log-marker-${"x".repeat(64)}`;
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map((a) => (typeof a === "string" ? a : inspect(a))).join(" "));
  };
  try {
    const res = await app.request("/api/stripe/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signed("whsec_someone_else") },
      body: JSON.stringify({ id: "evt_log_1", type: marker }),
    });
    assert.equal(res.status, 400);
  } finally {
    console.error = original;
  }
  assert.ok(logged.length > 0, "the refusal is still logged");
  assert.ok(!logged.some((line) => line.includes(marker)));
});

test("production with no secret refuses every event, signed or not", async () => {
  configure({ secrets: false, production: true });
  outbound = 0;
  assert.equal((await deliver()).status, 400);
  assert.equal((await deliver(signed(CONNECTED_SECRET))).status, 400);
  assert.equal(outbound, 0);
});
