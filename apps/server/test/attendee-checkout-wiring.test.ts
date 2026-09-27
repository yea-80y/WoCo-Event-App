/**
 * The checkout routes and the attendee order store (#546). Order data may only
 * be written where it can be erased, and when that is not possible the sale is
 * refused BEFORE anything is spent or charged: fulfilment's fallback seal goes
 * to the same store, so taking the card anyway would end in a refund.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { Bee } from "@ethersphere/bee-js";

process.chdir(mkdtempSync(join(tmpdir(), "woco-attendee-wiring-")));
process.env.BEE_URL = "http://127.0.0.1:1";
process.env.EMAIL_HASH_SECRET ??= "0".repeat(64);
process.env.PAYMENT_QUOTE_SECRET ??= "5".repeat(64);
process.env.FEED_PRIVATE_KEY ??= "11".repeat(32);
delete process.env.ATTENDEE_STAMPER_PRIVATE_KEY;
delete process.env.STRIPE_SECRET_KEY;

const { stripeRoutes } = await import("../src/routes/stripe.js");
const { __setBeeForTests } = await import("../src/config/swarm.js");
const ledger = await import("../src/lib/attendee-batch/ledger.js");
const { readyAttendeeStore, acceptingUploadChunk } = await import("./helpers/attendee-store.js");
const { canonicalOrderBox } = await import("../src/lib/stripe/order-ref.js");
const { splitPayload, bucketOf } = await import("../src/lib/attendee-batch/stamp.js");

let feedReads = 0;
let chunksUploaded = 0;
__setBeeForTests({
  makeFeedReader() {
    feedReads++;
    return { async downloadPayload() { throw Object.assign(new Error("no feed here"), { status: 404 }); } };
  },
  async uploadChunk(stamp: unknown, body: Uint8Array) {
    chunksUploaded++;
    return acceptingUploadChunk(stamp, body);
  },
} as unknown as Bee);
globalThis.fetch = (() => {
  throw new Error("unexpected outbound fetch");
}) as unknown as typeof fetch;

const app = new Hono();
app.route("/api/stripe", stripeRoutes);

const BOX = { v: 2, enc: "ab".repeat(1120), ct: "cd".repeat(64) };

function post(path: string, body: unknown, ip: string): Promise<Response> {
  return app.request(`/api/stripe/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify(body),
  });
}

test("with no erasable storage, checkout is refused 503 before any read or spend", async () => {
  const res = await post("create-checkout", { eventId: "evt-1", seriesId: "s1", claimerEmail: "a@example.com" }, "198.51.100.1");
  assert.equal(res.status, 503);
  const body = (await res.json()) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.match(body.error, /paused/i);
  assert.doesNotMatch(body.error, /stamper|batch|ledger/i, "operator detail stays in the log");
  assert.equal(feedReads, 0);
  assert.equal(chunksUploaded, 0);
});

test("with no erasable storage, prepare-order is refused 503 and stores nothing", async () => {
  const res = await post("prepare-order", { encryptedOrder: BOX }, "198.51.100.2");
  assert.equal(res.status, 503);
  assert.equal(chunksUploaded, 0);
});

test("once ready, prepare-order stores on the attendee batch and returns the recorded root", async () => {
  const { batchId } = await readyAttendeeStore();
  const res = await post("prepare-order", { encryptedOrder: BOX }, "198.51.100.3");
  assert.equal(res.status, 200);
  const { orderRef, orderRefToken } = (await res.json()) as { orderRef: string; orderRefToken: string };
  assert.ok(orderRefToken);
  const record = ledger.getOrderRecord(orderRef);
  assert.ok(record, "the returned ref is an order in the attendee ledger");
  assert.equal(record.batchId, batchId);
  assert.equal(record.kind, "prepared");
  assert.equal(record.state, "stored");
  assert.equal(chunksUploaded, record.chunks.length);
});

test("an order box sent with an event that does not exist stores nothing", async () => {
  const before = chunksUploaded;
  const res = await post(
    "create-checkout",
    { eventId: "evt-missing", seriesId: "s1", claimerEmail: "a@example.com", encryptedOrder: { ...BOX, ct: "ee".repeat(64) } },
    "198.51.100.4",
  );
  assert.equal(res.status, 404);
  assert.equal(chunksUploaded, before, "no slot was spent for a request naming no real event");
});

test("a full bucket answers the buyer 'paused', never ledger detail", async () => {
  // A depth-17 batch holds 2 chunks per bucket; fill the bucket this box's root lands in.
  const box = { ...BOX, ct: "0f".repeat(64) };
  const { chunks } = await splitPayload(new TextEncoder().encode(canonicalOrderBox(box)!));
  const bucket = bucketOf(chunks[chunks.length - 1].address);
  const id = "17".repeat(32);
  const { stamper } = await readyAttendeeStore();
  ledger.registerBatch(id, 17, stamper, true, new Date(Date.now() + 30 * 86400_000).toISOString());
  ledger.setActiveBatch(id);
  for (const n of [1, 2]) {
    const a = new Uint8Array(32);
    a[0] = bucket >> 8;
    a[1] = bucket & 0xff;
    a[31] = n;
    ledger.allocateOrder(a, [a], { kind: "checkout" });
  }
  const res = await post("prepare-order", { encryptedOrder: box }, "198.51.100.5");
  assert.equal(res.status, 503);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /paused/i);
  assert.doesNotMatch(body.error, /bucket|ledger|batch/i);
});

test("the organiser's order view checks erasure before it fetches anything", () => {
  const src = readFileSync(new URL("../src/routes/orders.ts", import.meta.url), "utf8");
  const check = src.indexOf("const erased = swarmHex ? isOrderErased(swarmHex) : false;");
  const guard = src.indexOf("if (swarmHex && !erased) {");
  const fetch = src.indexOf("await downloadFromBytes(swarmHex)");
  assert.ok(check > 0 && guard > check && fetch > guard, "erasure is decided before the download, and gates it");
});
