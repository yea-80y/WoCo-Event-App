/**
 * GET /api/events/:id/orders/count (Fable sign-off 2026-10-14): the audience
 * sync's cheap question - "did this event sell anything since?" - so an unchanged
 * event costs one ledger read per series instead of a slot read and a Swarm
 * download per ticket. It must count exactly the slots `/orders` reads, and be
 * as private as `/orders`.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.ALLOWED_HOSTS ??= "test.woco.local";
process.env.EMAIL_HASH_SECRET ??= "test-secret-order-count";

const SRC = readFileSync(new URL("../src/routes/orders.ts", import.meta.url), "utf8");
const COUNT = SRC.slice(SRC.indexOf('orders.get("/:id/orders/count"'), SRC.indexOf('orders.get("/:id/orders",'));
const FULL = SRC.slice(SRC.indexOf('orders.get("/:id/orders",'));

let app: Hono;
before(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "woco-order-count-test-")));
  const { orders } = await import("../src/routes/orders.js");
  app = new Hono();
  app.route("/api/events", orders);
});

test("the count and the order list read the same ledger, through one helper", () => {
  assert.ok(COUNT.length > 0 && FULL.length > 0, "both routes must exist");
  assert.match(COUNT, /count \+= \(await soldSlots\(eventId, series\)\)\?\.slotCount \?\? 0;/);
  assert.match(FULL, /const sold = await soldSlots\(eventId, series\);\s*if \(!sold\) continue;/);
});

test("the count reads no slot, no order and no held order", () => {
  assert.doesNotMatch(COUNT, /getSlotDataAt|downloadFromBytes|getHeldOrder|encryptedOrder/);
});

test("the count is as private as the order list: signed in, and the event's own organiser", async () => {
  assert.match(COUNT, /orders\.get\("\/:id\/orders\/count", requireAuth,/);
  assert.match(COUNT, /const event = await getEventForOwner\(eventId, parentAddress\);/);
  assert.match(COUNT, /if \(event\.creatorAddress\.toLowerCase\(\) !== parentAddress\.toLowerCase\(\)\) \{\s*return c\.json\(\{ ok: false, error: "Only the event organizer can view orders" \}, 403\);/);
  const resp = await app.request("/api/events/some-event/orders/count");
  assert.equal(resp.status, 401);
});
