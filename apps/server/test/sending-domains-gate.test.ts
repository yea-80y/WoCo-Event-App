/**
 * Custom sending domains are OFF for launch (#81).
 *
 * Hiding the panel is not the same as disabling the feature: an older cached
 * client, or a direct call, still reaches the endpoints. Every one of them
 * either 401s against the send-only production Resend key or burns a slot on
 * the Pro domain cap that the SES migration would have to undo
 * (PRICING_AND_EMAIL.md §6). So the gate is asserted here at the HTTP layer,
 * and it must sit BEFORE requireAuth — an unauthenticated probe should learn
 * "off", not "unauthorised".
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EMAIL_HASH_SECRET = "test-secret-domains-gate";

let app: import("hono").Hono;
let FEATURES: typeof import("@woco/shared").FEATURES;

before(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "woco-domains-gate-test-")));
  const { Hono } = await import("hono");
  const { marketing } = await import("../src/routes/marketing.js");
  ({ FEATURES } = await import("@woco/shared"));
  app = new Hono();
  app.route("/api/marketing", marketing);
});

test("the flag is off for launch", () => {
  assert.equal(FEATURES.organiserSendingDomains, false);
});

const ROUTES: Array<[string, string]> = [
  ["GET", "/api/marketing/domain"],
  ["POST", "/api/marketing/domain"],
  ["POST", "/api/marketing/domain/verify"],
  ["DELETE", "/api/marketing/domain"],
];

for (const [method, path] of ROUTES) {
  test(`${method} ${path} is closed while the flag is off`, async () => {
    const res = await app.request(path, {
      method,
      ...(method === "POST"
        ? { body: JSON.stringify({ domain: "mail.example.com" }), headers: { "Content-Type": "application/json" } }
        : {}),
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { ok: boolean; code?: string };
    assert.equal(body.ok, false);
    assert.equal(body.code, "FEATURE_OFF", "the client distinguishes this from an auth failure");
  });
}

/** The gate must not leak onto the endpoints the organiser still needs. */
test("the rest of the marketing API is untouched by the gate", async () => {
  const res = await app.request("/api/marketing/list");
  assert.notEqual(res.status, 403, "list access must not answer FEATURE_OFF");
});
