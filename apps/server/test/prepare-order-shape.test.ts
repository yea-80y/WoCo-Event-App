/**
 * `POST /api/stripe/prepare-order` stores only a v2 sealed box, bounded (#642).
 *
 * The route is unauthenticated and stamps onto the platform batch. Before #642 it
 * uploaded ANY object, of any size up to the global body limit, with no limiter.
 * Pinned here:
 *  - exactly a v2 box: the retired X25519 shape, a box with anything beside it,
 *    and a box over 16 KB of JSON are all refused before anything is spent;
 *  - a refusal does not spend the caller's budget; a well-formed call does, and
 *    the 31st in a minute is refused.
 *
 * No postage batch is configured, so a well-formed box reaches `uploadToBytes`
 * and fails there at once (500) — which is how the test tells "passed validation"
 * from "refused" without any network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.chdir(mkdtempSync(join(tmpdir(), "woco-prepare-order-")));
process.env.BEE_URL = "http://127.0.0.1:1";
process.env.EMAIL_HASH_SECRET ??= "0".repeat(64);
process.env.FEED_PRIVATE_KEY ??= "11".repeat(32);
delete process.env.POSTAGE_BATCH_ID;
delete process.env.STRIPE_SECRET_KEY;

const { stripeRoutes } = await import("../src/routes/stripe.js");
const { __setBeeForTests } = await import("../src/config/swarm.js");
const { readyAttendeeStore } = await import("./helpers/attendee-store.js");
const app = new Hono();
app.route("/api/stripe", stripeRoutes);
// A bee that refuses every chunk, fast and non-retryable: the spend happens,
// the store fails, and the route answers 500.
__setBeeForTests({
  uploadChunk: async () => {
    throw Object.assign(new Error("fake bee refuses"), { status: 400 });
  },
} as never);

const BOX = { v: 2, enc: "ab".repeat(1120), ct: "cd".repeat(64) };

async function post(body: unknown, ip: string): Promise<number> {
  const resp = await app.request("/api/stripe/prepare-order", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip, "cf-connecting-ip": ip },
    body: JSON.stringify(body),
  });
  return resp.status;
}

test("anything but exactly a v2 box within 16 KB is refused", async () => {
  for (const encryptedOrder of [
    { ephemeralPublicKey: "ab".repeat(32), iv: "00".repeat(12), ciphertext: "00".repeat(32) },
    { ...BOX, email: "ada@example.com" },
    { ...BOX, v: 3 },
    { ...BOX, ct: "cd".repeat(9000) },
    "a string",
    undefined,
  ]) {
    assert.equal(await post({ encryptedOrder }, "203.0.113.7"), 400);
  }
});

test("with nowhere erasable to store it, a well-formed box is refused 503 and spends nothing (#546)", async () => {
  const ip = "203.0.113.9";
  for (let i = 0; i < 40; i++) assert.equal(await post({ encryptedOrder: BOX }, ip), 503);
  await readyAttendeeStore();
  for (let i = 0; i < 30; i++) assert.equal(await post({ encryptedOrder: BOX }, ip), 500);
  assert.equal(await post({ encryptedOrder: BOX }, ip), 429);
});

test("a well-formed box passes validation, and refusals never spent the budget", async () => {
  const ip = "203.0.113.8";
  for (let i = 0; i < 40; i++) assert.equal(await post({ encryptedOrder: { v: 1 } }, ip), 400);
  // 30 spends allowed per minute — none of the 40 refusals above counted.
  for (let i = 0; i < 30; i++) assert.equal(await post({ encryptedOrder: BOX }, ip), 500);
  assert.equal(await post({ encryptedOrder: BOX }, ip), 429);
});
