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

test("the organiser's order view checks erasure before it fetches anything", () => {
  const src = readFileSync(new URL("../src/routes/orders.ts", import.meta.url), "utf8");
  const check = src.indexOf("const erased = swarmHex ? isOrderErased(swarmHex) : false;");
  const guard = src.indexOf("if (swarmHex && !erased) {");
  const fetch = src.indexOf("await downloadFromBytes(swarmHex)");
  assert.ok(check > 0 && guard > check && fetch > guard, "erasure is decided before the download, and gates it");
});
