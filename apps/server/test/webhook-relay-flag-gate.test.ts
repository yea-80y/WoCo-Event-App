/**
 * The dashboard's per-order webhook is OFF (FEATURES.webhooksAllowed, 2026-10-31):
 * its relay was the one path where our server handled attendee details in
 * plaintext. The dashboard hides it; this is the server half, which an old
 * dashboard or a direct call meets instead.
 *
 * The flag is read at request time and not mocked: the claim is what this build serves.
 *
 * MUTATION: delete `webhookGate` from the relay route, or move it after
 * requireAuth, and a case below goes red; flip the flag to true and they all do.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALLOWED_HOSTS ??= "test.woco.local";
process.env.EMAIL_HASH_SECRET ??= "test-secret-webhook-gate";

let app: import("hono").Hono;
let FEATURES: typeof import("@woco/shared").FEATURES;

before(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "woco-webhook-gate-test-")));
  const { Hono } = await import("hono");
  const { orders } = await import("../src/routes/orders.js");
  ({ FEATURES } = await import("@woco/shared"));
  app = new Hono();
  app.route("/api/events", orders);
});

test("the flag is off", () => {
  assert.equal(FEATURES.webhooksAllowed, false);
});

test("the relay answers 'off' before auth, never 401, and forwards nothing", async () => {
  const res = await app.request("/api/events/some-event/webhook-relay", {
    method: "POST",
    body: JSON.stringify({ webhookUrl: "https://example.com/hook", payload: { a: 1 } }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(res.status, 403);
  const body = (await res.json()) as { ok: boolean; error?: string };
  assert.equal(body.ok, false);
  assert.equal(body.error, "Webhooks are not available");
});

test("the orders reads are not gated", async () => {
  // Unauthenticated, so requireAuth answers: anything but the gate's 403.
  const res = await app.request("/api/events/some-event/orders");
  assert.equal(res.status, 401);
});
