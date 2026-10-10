/**
 * The webhook's refund cases (#645 part C), end to end through Hono.
 *
 * What the route itself owns, beyond `reconcileRefundEvent` (sale-refunds.test.ts):
 *   - only a charge on a CONNECTED account is looked at, and a platform-level one
 *     reaches no Stripe read at all;
 *   - a refund that could not be applied answers 500, and is NOT remembered as
 *     applied — Stripe's redelivery must run it again, not be skipped.
 *
 * Unsigned events are accepted outside production (no webhook secret set), and
 * every outbound HTTPS request is counted and refused, so a Stripe read fails
 * the way a network outage does — which is exactly the retry path.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";
import { Hono } from "hono";

process.chdir(mkdtempSync(join(tmpdir(), "woco-refund-webhook-")));
process.env.EMAIL_HASH_SECRET ??= "0".repeat(64);
process.env.FEED_PRIVATE_KEY ??= "11".repeat(32);
process.env.STRIPE_SECRET_KEY = "sk_test_route_suite_no_network";
delete process.env.STRIPE_WEBHOOK_SECRET;
delete process.env.STRIPE_WEBHOOK_SECRET_PLATFORM;
if (process.env.NODE_ENV === "production") delete process.env.NODE_ENV;

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
const app = new Hono();
app.route("/api/stripe", stripeRoutes);

/** A Stripe event. Its payload sits under `data`'s one key, set by name (the repo's naming rule). */
function stripeEvent(fields: Record<string, unknown>, payload: Record<string, unknown>): Record<string, unknown> {
  return { ...fields, data: Object.fromEntries([["object", payload]]) };
}

function deliver(event: Record<string, unknown>): Promise<Response> {
  return app.request("/api/stripe/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });
}

test("a refund on the platform's own account (no connected account) is ignored without a read", async () => {
  outbound = 0;
  const res = await deliver(
    stripeEvent({ id: "evt_platform_1", type: "charge.refunded", created: 1 }, { id: "ch_1", payment_intent: "pi_platform" }),
  );
  assert.equal(res.status, 200);
  assert.equal(outbound, 0);
});

test("a refund that cannot be applied answers 500, and its redelivery is applied again — not skipped", async () => {
  const event = stripeEvent(
    { id: "evt_refund_retry_1", type: "charge.refunded", created: 1, account: "acct_1" },
    { id: "ch_1", payment_intent: "pi_1" },
  );
  outbound = 0;
  const first = await deliver(event);
  assert.equal(first.status, 500, "Stripe unreachable: ask for a redelivery");
  const afterFirst = outbound;
  assert.ok(afterFirst > 0, "the route did try to read Stripe");

  const second = await deliver(event);
  assert.equal(second.status, 500);
  assert.ok(outbound > afterFirst, "the redelivery read Stripe again rather than being skipped as applied");
});

for (const type of [
  "refund.failed",
  "refund.updated",
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.funds_reinstated",
]) {
  test(`${type} takes the same path`, async () => {
    outbound = 0;
    const res = await deliver(
      stripeEvent(
        { id: `evt_${type}_1`, type, created: 1, account: "acct_1" },
        { id: "re_1", charge: "ch_1", payment_intent: "pi_1" },
      ),
    );
    assert.equal(res.status, 500);
    assert.ok(outbound > 0);
  });
}
