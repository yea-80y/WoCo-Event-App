/**
 * The sale gates for a cancelled event (#644), end to end through Hono.
 *
 * `/create-checkout` and `/reserve` must refuse a cancelled event before doing
 * any work for it, and refuse EVERY event while the cancellation record cannot
 * be read — selling a ticket to an event that may be cancelled is worse than a
 * short outage. Outbound HTTP is a tripwire: a refusal reaches no network.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";
import { Hono } from "hono";

const dir = mkdtempSync(join(tmpdir(), "woco-cancel-gates-"));
process.chdir(dir);
mkdirSync(join(dir, ".data"), { recursive: true });
const STORE = join(dir, ".data", "event-cancellations.json");
writeFileSync(
  STORE,
  JSON.stringify({
    ev_cx: { eventId: "ev_cx", cancelledAt: "2026-09-26T00:00:00.000Z", by: "ops:test", feeReturned: false, refunds: {} },
  }),
);
process.env.BEE_URL = "http://127.0.0.1:1";
process.env.EMAIL_HASH_SECRET ??= "0".repeat(64);
process.env.FEED_PRIVATE_KEY ??= "11".repeat(32);
delete process.env.STRIPE_SECRET_KEY;

let outbound = 0;
const refuse = () => {
  outbound++;
  throw new Error("no network in this suite");
};
globalThis.fetch = refuse as unknown as typeof fetch;
(http as unknown as Record<string, unknown>)["request"] = refuse;
(https as unknown as Record<string, unknown>)["request"] = refuse;

const { stripeRoutes } = await import("../src/routes/stripe.js");
const { reservations } = await import("../src/routes/reservations.js");
const cancellations = await import("../src/lib/event/cancellations.js");

const app = new Hono();
app.route("/api/stripe", stripeRoutes);
app.route("/api/events", reservations);

const checkout = (eventId: string) =>
  app.request("/api/stripe/create-checkout", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.50" },
    body: JSON.stringify({ eventId, seriesId: "ser-1", claimerEmail: "buyer@example.com" }),
  });
const reserve = (eventId: string) =>
  app.request(`/api/events/${eventId}/series/ser-1/reserve`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.51" },
    body: JSON.stringify({ quantity: 1 }),
  });

test("a cancelled event: checkout and seat holds refuse with 409, before any read", async () => {
  outbound = 0;
  const c = await checkout("ev_cx");
  assert.equal(c.status, 409);
  assert.match(((await c.json()) as { error: string }).error, /cancelled/);
  const r = await reserve("ev_cx");
  assert.equal(r.status, 409);
  assert.equal(outbound, 0);
});

test("an event that is not cancelled is not refused by the gate", async () => {
  const c = await checkout("ev_open");
  assert.notEqual(c.status, 409);
  const r = await reserve("ev_open");
  assert.notEqual(r.status, 409);
});

test("an unreadable cancellation record refuses EVERY sale with 503 (fail closed)", async () => {
  writeFileSync(STORE, "null");
  cancellations.__resetForTests();
  outbound = 0;
  for (const id of ["ev_cx", "ev_open"]) {
    assert.equal((await checkout(id)).status, 503, id);
    assert.equal((await reserve(id)).status, 503, id);
  }
  assert.equal(outbound, 0);
});
